import assert from "node:assert/strict";
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
  updates.length = 0;
  assert.deepEqual(await runtime.request("sessions.delete", { sessionId: other.id }), { deleted: true });
  await until(() => updates.some(update => "resync" in update), Boolean);
  assert.equal(await failure(runtime.request("sessions.messages.list", { sessionId: other.id })), "session_unknown");
  assert.equal((await runtime.request<Array<{ id: string }>>("sessions.list", {})).some(item => item.id === other.id), false);
  // The chat the server keeps for itself can still be deleted from here.
  assert.deepEqual(await runtime.request("sessions.delete", { sessionId: session.id }), { deleted: true });
});
