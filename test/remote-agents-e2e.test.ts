import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { RemoteClient } from "../src/remote/client/RemoteClient";
import { RemoteRuntime, type StreamCursor, type StreamUpdate } from "../src/remote/client/RemoteRuntime";
import type { ChatMessage, SessionSettings } from "../src/types";
import { memoryVault, remoteStackSkip, startCloud, startDaemon, startStubModel, until } from "./fixtures/remoteStack";

interface Snapshot { messages: ChatMessage[]; activeRun?: { runId: string }; cursor: StreamCursor }

test("a server chat's subagents and debate agents are set from a device; a chat the server gave full access stays there", { skip: remoteStackSkip, timeout: 180_000 }, async t => {
  const cloud = await startCloud(t);
  const model = await startStubModel(t);
  const server = await startDaemon(t, cloud.origin, { DEFAULT_PROVIDER: "lmstudio", LMSTUDIO_BASE_URL: model.url, LMSTUDIO_MODEL: "fixture" });
  const alice = await cloud.account("auth0|alice");
  const mac = new RemoteClient({ cloudUrl: cloud.origin, vault: memoryVault(), account: async () => alice, deviceName: "Mac", platform: "macos", backoff: { baseMs: 50, maxMs: 300 } });
  t.after(() => mac.dispose());
  const paired = await mac.pair(server.connectKey());
  assert.equal(paired.state, "online", JSON.stringify(paired));
  assert.ok(paired.capabilities?.includes("sessions.setup.get"), "the server offers agent setup");
  const runtime = new RemoteRuntime(mac);
  t.after(() => runtime.dispose());
  const updates: StreamUpdate[] = [];
  runtime.on("update", (update: StreamUpdate) => updates.push(update));
  const failure = async (promise: Promise<unknown>) => { try { await promise; return "ok"; } catch (error) { return (error as { code?: string }).code; } };

  const session = await runtime.request<{ id: string }>("sessions.create", { title: "Agents" });
  const snapshot = () => runtime.request<Snapshot>("sessions.messages.list", { sessionId: session.id });
  const turn = async (input: string) => {
    updates.length = 0;
    runtime.subscribe((await snapshot()).cursor);
    await runtime.send("chat.runs.start", { sessionId: session.id, input });
    await until(() => updates.flatMap(update => "events" in update ? update.events.map(event => event.type) : []), types => types.includes("run.completed") || types.includes("run.failed"), 60_000);
    return (await snapshot()).messages.at(-1)!;
  };

  // Subagents: one named Nova, on the server's own provider.
  const saved = await runtime.request<SessionSettings>("sessions.settings.update", { sessionId: session.id,
    patch: { mode: "code", codeAgents: [{ id: "agent-nova", name: "Nova", providerId: "lmstudio" }] } });
  assert.deepEqual(saved.codeAgents.map(agent => [agent.name, agent.providerId, agent.accessMode]), [["Nova", "lmstudio", "default"]]);
  const before = model.state.requests;
  const answer = await turn("@Nova check the plan");
  assert.equal(answer.role, "assistant");
  assert.ok(model.state.requests - before >= 2, `the main agent and Nova both ran (${model.state.requests - before} model calls)`);
  assert.equal(answer.subagents?.[0]?.name, "Nova");

  // Debate with an advisor.
  await runtime.request("sessions.settings.update", { sessionId: session.id, patch: { mode: "hypothesis", debate: { profile: "technical" },
    hypothesisAgents: [{ id: "s", name: "Support", role: "support", providerId: "lmstudio" }, { id: "a", name: "Attack", role: "attack", providerId: "lmstudio" },
      { id: "j", name: "Judge", role: "judge", providerId: "local" }, { id: "adv", name: "Skeptic", role: "advisor", providerId: "lmstudio" }] } });
  const debateBefore = model.state.requests;
  await turn("Is a cache worth adding here?");
  assert.ok(model.state.requests - debateBefore >= 3, `support, attack and the advisor ran (${model.state.requests - debateBefore} model calls)`);

  // Access: ask or approve-for-me from a device; the server's folders never reach it.
  const asked = await runtime.request<SessionSettings>("sessions.settings.update", { sessionId: session.id, patch: { mode: "general", defaultAccessMode: "ask" } });
  assert.deepEqual([asked.defaultAccessMode, asked.codeAgents[0]!.accessMode], ["ask", "ask"], "agents follow the chat's access");
  model.state.answer = `The report is saved as ${server.root}/app/outputs/report.md.`;
  const scrubbed = await turn("Where is the report?");
  const received = JSON.stringify([scrubbed, await snapshot(), updates]);
  assert.equal(received.includes(server.root), false, "no folder of the server reaches the device");
  assert.match(scrubbed.content, /saved as <server>\/app\/outputs\/report\.md/);
  model.state.answer = "Paris is the capital of France.";

  // What a device may not set is refused.
  assert.equal(await failure(runtime.request("sessions.settings.update", { sessionId: session.id, patch: { codeAgents: [{ id: "x", name: "X", providerId: "__proto__" }] } })), "invalid_request");
  assert.equal(await failure(runtime.request("sessions.settings.update", { sessionId: session.id, patch: { codeAgents: [{ id: "x", name: "X", providerId: "lmstudio", accessMode: "full" }] } })), "unsupported");
  assert.equal(await failure(runtime.request("sessions.settings.update", { sessionId: session.id, patch: { defaultAccessMode: "full" } })), "unsupported");

  // The server's own API gives the chat full access: from now on it is the server's alone.
  const status = JSON.parse(server.run("status", "--json").stdout) as { http?: { port: number } };
  assert.ok(status.http?.port, "the daemon serves its loopback API");
  const response = await fetch(`http://127.0.0.1:${status.http!.port}/sessions/${session.id}/settings`, { method: "PUT", headers: { "content-type": "application/json", "x-local-cognitive": "1" },
    body: JSON.stringify({ defaultAccessMode: "full" }) });
  assert.equal(response.status, 200, await response.text());
  const setup = await runtime.request<{ access: { hostOnly?: string } }>("sessions.setup.get", { sessionId: session.id });
  assert.match(String(setup.access.hostOnly), /full access on the server/);
  const requestsBefore = model.state.requests;
  assert.equal(await failure(runtime.send("chat.runs.start", { sessionId: session.id, input: "Delete everything" })), "unsupported");
  assert.equal(await failure(runtime.request("sessions.settings.update", { sessionId: session.id, patch: { language: "en" } })), "unsupported");
  assert.equal(model.state.requests, requestsBefore, "nothing ran");

  // Rename and delete: refused while answering; a follower learns the chat is gone.
  const other = await runtime.request<{ id: string }>("sessions.create", { title: "Scratch" });
  assert.equal((await runtime.request<{ title: string }>("sessions.rename", { sessionId: other.id, title: "Renamed" })).title, "Renamed");
  model.hold();
  updates.length = 0;
  runtime.subscribe((await runtime.request<Snapshot>("sessions.messages.list", { sessionId: other.id })).cursor);
  const busy = await runtime.send<{ runId: string }>("chat.runs.start", { sessionId: other.id, input: "Take your time" });
  await until(() => model.state.waiting.length, count => count > 0);
  assert.equal(await failure(runtime.request("sessions.delete", { sessionId: other.id })), "session_busy");
  model.release();
  await until(async () => (await runtime.request<Snapshot>("sessions.messages.list", { sessionId: other.id })).activeRun, run => !run);
  assert.ok(busy.runId);
  const listed = await runtime.request<Array<{ id: string; title: string }>>("sessions.list", {});
  assert.equal(listed.find(item => item.id === other.id)?.title, "Renamed", "a turn does not undo a rename");
  updates.length = 0;
  assert.deepEqual(await runtime.request("sessions.delete", { sessionId: other.id }), { deleted: true });
  await until(() => updates.some(update => "resync" in update), Boolean);
  assert.equal(await failure(runtime.request("sessions.messages.list", { sessionId: other.id })), "session_unknown");
  assert.equal((await runtime.request<Array<{ id: string }>>("sessions.list", {})).some(item => item.id === other.id), false);
  // The chat the server keeps for itself can still be deleted from here.
  assert.deepEqual(await runtime.request("sessions.delete", { sessionId: session.id }), { deleted: true });
});

test("a server chat's attachment arrives in chunks across a dropped connection and reaches the model; history keeps only its name", { skip: remoteStackSkip, timeout: 180_000 }, async t => {
  const cloud = await startCloud(t);
  const model = await startStubModel(t, "The plan says Friday.");
  const server = await startDaemon(t, cloud.origin, { DEFAULT_PROVIDER: "lmstudio", LMSTUDIO_BASE_URL: model.url, LMSTUDIO_MODEL: "fixture" });
  const alice = await cloud.account("auth0|alice");
  const mac = new RemoteClient({ cloudUrl: cloud.origin, vault: memoryVault(), account: async () => alice, deviceName: "Mac", platform: "macos", backoff: { baseMs: 50, maxMs: 300 } });
  t.after(() => mac.dispose());
  const paired = await mac.pair(server.connectKey());
  assert.ok(paired.capabilities?.includes("uploads.begin"));
  const runtime = new RemoteRuntime(mac);
  t.after(() => runtime.dispose());
  const updates: StreamUpdate[] = [];
  runtime.on("update", (update: StreamUpdate) => updates.push(update));
  const failure = async (promise: Promise<unknown>) => { try { await promise; return "ok"; } catch (error) { return (error as { code?: string }).code; } };
  const session = await runtime.request<{ id: string }>("sessions.create", { title: "Files" });

  const text = "Secret plan: ship the release on Friday, after the review.";
  const uploadId = randomUUID();
  const begin = { uploadId, sessionId: session.id, name: "plan.txt", mimeType: "text/plain", kind: "text", sizeBytes: text.length, length: text.length,
    sha256: createHash("sha256").update(text).digest("hex") };
  assert.deepEqual((await runtime.request<{ received: number[] }>("uploads.begin", begin)).received, []);
  mac.disconnect();
  assert.equal((await mac.connect(paired.hostId!)).state, "online");
  assert.deepEqual((await runtime.request<{ received: number[] }>("uploads.begin", begin)).received, [], "the upload is still there after the drop");
  await runtime.request("uploads.chunk", { uploadId, index: 0, data: text });
  assert.deepEqual(await runtime.request("uploads.commit", { uploadId }), { id: uploadId, name: "plan.txt", mimeType: "text/plain", sizeBytes: text.length, kind: "text" });

  runtime.subscribe((await runtime.request<Snapshot>("sessions.messages.list", { sessionId: session.id })).cursor);
  await runtime.send("chat.runs.start", { sessionId: session.id, input: "When do we ship?", attachmentIds: [uploadId] });
  await until(() => updates.flatMap(update => "events" in update ? update.events.map(event => event.type) : []), types => types.includes("run.completed") || types.includes("run.failed"), 60_000);
  assert.ok(model.state.bodies.some(body => body.includes("ship the release on Friday")), "the attachment's text reached the model");
  const history = await runtime.request<Snapshot>("sessions.messages.list", { sessionId: session.id });
  const asked = history.messages.find(message => message.role === "user")!;
  assert.deepEqual(asked.attachments?.map(item => [item.name, item.kind, "textContent" in item]), [["plan.txt", "text", false]], "history shows the file, not its contents");
  assert.equal(JSON.stringify(updates).includes("ship the release on Friday"), false, "no event carried the contents");
  assert.equal(await failure(runtime.send("chat.runs.start", { sessionId: session.id, input: "Again", attachmentIds: [uploadId] })), "attachment_unknown", "a turn takes an upload once");

  // A file in a folder the server lets its chats use: read for Review and copied, under the label the device sees.
  const shared = path.join(server.root, "shared");
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, "notes.md"), "# Notes\nFriday.\n");
  fs.writeFileSync(path.join(server.root, "private.txt"), "not for chats");
  const port = (JSON.parse(server.run("status", "--json").stdout) as { http: { port: number } }).http.port;
  const saved = await fetch(`http://127.0.0.1:${port}/app/settings`, { method: "PUT", headers: { "content-type": "application/json", "x-local-cognitive": "1" },
    body: JSON.stringify({ filesystem: { allowedDirectories: [shared] } }) });
  assert.equal(saved.status, 200, await saved.text());
  const review = await runtime.request<{ path: string; content: string }>("files.read", { sessionId: session.id, path: "<folder>/notes.md", as: "text" });
  assert.deepEqual([review.path, review.content], ["<folder>/notes.md", "# Notes\nFriday.\n"]);
  const stat = await runtime.request<{ sha256: string; sizeBytes: number }>("files.stat", { sessionId: session.id, path: "<folder>/notes.md" });
  const part = await runtime.request<{ data: string; eof: boolean }>("files.read", { sessionId: session.id, path: "<folder>/notes.md", as: "base64" });
  assert.equal(createHash("sha256").update(Buffer.from(part.data, "base64")).digest("hex"), stat.sha256);
  assert.equal(await failure(runtime.request("files.read", { sessionId: session.id, path: "<server>/private.txt", as: "text" })), "forbidden");
  assert.equal(await failure(runtime.request("files.read", { sessionId: session.id, path: "<folder>/../private.txt", as: "text" })), "forbidden");
});
