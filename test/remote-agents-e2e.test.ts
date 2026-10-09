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

  // Files this chat did not create or open are not its own, even in the output folder chats share.
  fs.mkdirSync(path.join(server.root, "output"), { recursive: true });
  fs.writeFileSync(path.join(server.root, "output", "notes.md"), "# Another chat's notes\n");
  fs.writeFileSync(path.join(server.root, "private.txt"), "not for chats");
  for (const ref of ["<output>/notes.md", "<server>/private.txt", "<output>/../private.txt", "<server>/missing.txt"]) {
    assert.equal(await failure(runtime.request("files.read", { sessionId: session.id, path: ref, as: "text" })), "file_unavailable", ref);
  }

  // Folders: the server's own Projects, and one its admin shares while it runs (no restart).
  const work = path.join(path.dirname(server.root), "work");
  fs.mkdirSync(path.join(work, "app"), { recursive: true });
  const shared = server.run("folders", "add", work, "--label", "Work", "--json");
  assert.equal(shared.status, 0, shared.stderr);
  const roots = await runtime.request<Array<{ rootId: string; label: string }>>("fs.roots", {});
  assert.deepEqual(roots.map(root => root.label), ["Projects", "Work"]);
  assert.equal(JSON.stringify(roots).includes(path.dirname(server.root)), false);
  const listing = await runtime.request<{ entries: Array<{ name: string }> }>("fs.browse", { rootId: roots[1]!.rootId });
  assert.deepEqual(listing.entries.map(entry => entry.name), ["app"]);
  assert.deepEqual(await runtime.request("fs.mkdir", { rootId: "projects", path: [], name: "site" }), { rootId: "projects", path: ["site"] });
  assert.ok(fs.statSync(path.join(server.root, "projects", "site")).isDirectory());
  assert.equal(server.run("folders", "remove", roots[1]!.rootId).status, 0);
  assert.equal(await failure(runtime.request("fs.browse", { rootId: roots[1]!.rootId })), "not_found", "unshared at once");

  // Projects: one made from the device in the server's Projects folder, and one the server set up elsewhere.
  const project = await runtime.send<{ id: string; folder: { path: string[] } }>("projects.create", { name: "Site", folder: { rootId: "projects", path: ["site"] } });
  assert.deepEqual(project.folder.path, ["site"]);
  const inProject = await runtime.request<{ id: string; projectId: string }>("sessions.create", { title: "New chat", projectId: project.id });
  assert.equal(inProject.projectId, project.id);
  updates.length = 0;
  runtime.subscribe((await runtime.request<Snapshot>("sessions.messages.list", { sessionId: inProject.id })).cursor);
  model.state.answer = `I will work in ${path.join(server.root, "projects", "site")}/index.html.`;
  await runtime.send("chat.runs.start", { sessionId: inProject.id, input: "Make a page" });
  await until(() => updates.flatMap(update => "events" in update ? update.events.map(event => event.type) : []), types => types.includes("run.completed") || types.includes("run.failed"), 60_000);
  // A project chat runs the agent loop (which wants actions, not this stub's prose); what matters
  // here is that it ran in the project and nothing it sent names the project's folder.
  const received = JSON.stringify([await runtime.request<Snapshot>("sessions.messages.list", { sessionId: inProject.id }), updates]);
  assert.equal(received.includes(server.root), false, "the project's folder is not named");
  const elsewhere = path.join(path.dirname(server.root), "elsewhere");
  fs.mkdirSync(elsewhere);
  const port = (JSON.parse(server.run("status", "--json").stdout) as { http: { port: number } }).http.port;
  const hostProject = await (await fetch(`http://127.0.0.1:${port}/projects`, { method: "POST", headers: { "content-type": "application/json", "x-local-cognitive": "1" },
    body: JSON.stringify({ name: "Host project", rootPath: elsewhere }) })).json() as { id: string };
  const listed = await runtime.request<Array<{ id: string; hostOnly?: boolean; folder?: unknown }>>("projects.list", {});
  assert.deepEqual(listed.find(item => item.id === hostProject.id), { ...listed.find(item => item.id === hostProject.id), hostOnly: true });
  assert.equal(JSON.stringify(listed).includes(elsewhere), false, "no folder of the host");
  assert.equal(await failure(runtime.request("sessions.create", { title: "New chat", projectId: hostProject.id })), "unsupported");
});
