import assert from "node:assert/strict";
import test from "node:test";
import { RemoteClient } from "../src/remote/client/RemoteClient";
import { RemoteRuntime, type StreamCursor, type StreamUpdate } from "../src/remote/client/RemoteRuntime";
import type { ChatMessage } from "../src/types";
import { memoryVault, remoteStackSkip, startCloud, startDaemon, startStubModel, until } from "./fixtures/remoteStack";

interface Snapshot { messages: ChatMessage[]; activeRun?: { runId: string; status: string; partialText: string }; cursor: StreamCursor }

test("a remote chat turn survives disconnects, resends, a closed app, cancel and a server crash", { skip: remoteStackSkip, timeout: 180_000 }, async t => {
  const cloud = await startCloud(t);
  const model = await startStubModel(t);
  const server = await startDaemon(t, cloud.origin, { DEFAULT_PROVIDER: "lmstudio", LMSTUDIO_BASE_URL: model.url, LMSTUDIO_MODEL: "fixture" });
  const alice = await cloud.account("auth0|alice");
  const vault = memoryVault();
  const newClient = () => new RemoteClient({ cloudUrl: cloud.origin, vault, account: async () => alice, deviceName: "Mac", platform: "macos", backoff: { baseMs: 50, maxMs: 300 } });
  let mac = newClient();
  t.after(() => mac.dispose());
  const paired = await mac.pair(server.connectKey());
  assert.equal(paired.state, "online", JSON.stringify(paired));
  let runtime = new RemoteRuntime(mac, { resendWindowMs: 10_000 });
  t.after(() => runtime.dispose());
  const updates: StreamUpdate[] = [];
  runtime.on("update", (update: StreamUpdate) => updates.push(update));

  const session = await runtime.request<{ id: string }>("sessions.create", { title: "Remote" });
  await runtime.request("sessions.settings.update", { sessionId: session.id, patch: { mode: "general" } });
  const snapshot = () => runtime.request<Snapshot>("sessions.messages.list", { sessionId: session.id });
  const eventTypes = () => updates.flatMap(update => "events" in update ? update.events.map(event => event.type) : []);

  // 1. A turn that outlives the connection.
  model.hold();
  runtime.subscribe((await snapshot()).cursor);
  const ack = await runtime.send<{ status: string; runId: string }>("chat.runs.start", { sessionId: session.id, input: "What is the capital of France?" });
  assert.equal(ack.status, "accepted");
  await until(() => model.state.requests, count => count >= 1);
  await until(eventTypes, types => types.includes("run.started"));
  mac.disconnect();
  await until(() => updates.some(update => "resync" in update), Boolean);
  assert.equal((await mac.connect(paired.hostId!)).state, "online");
  const during = await snapshot();
  assert.equal(during.activeRun?.runId, ack.runId, "the run kept going while the device was away");
  updates.length = 0;
  runtime.subscribe(during.cursor);
  model.release();
  await until(eventTypes, types => types.includes("run.completed"));
  const completed = updates.flatMap(update => "events" in update ? update.events : []).find(event => event.type === "message.completed")!;
  assert.match(String(completed.payload.text), /Paris/);
  const after = await snapshot();
  assert.equal(after.activeRun, undefined);
  assert.deepEqual(after.messages.filter(message => message.role === "user").map(message => message.content), ["What is the capital of France?"], "exactly one turn");
  assert.match(after.messages.at(-1)!.content, /Paris/);

  // 2. A resent command (same id) returns the first run instead of starting another.
  const replay = await runtime.request<{ runId: string; replayed: boolean }>("chat.runs.start",
    { sessionId: session.id, input: "What is the capital of France?", commandId: "fixed-command-id" });
  const again = await runtime.request<{ runId: string; replayed: boolean }>("chat.runs.start",
    { sessionId: session.id, input: "What is the capital of France?", commandId: "fixed-command-id" });
  assert.equal(again.runId, replay.runId);
  assert.equal(again.replayed, true);
  await until(async () => (await snapshot()).activeRun, run => !run);

  // 3. The app closes and opens again: it reconnects to the same server and the answers are there.
  runtime.dispose(); mac.dispose();
  mac = newClient();
  assert.equal((await mac.resume()).state, "online");
  runtime = new RemoteRuntime(mac);
  assert.equal((await snapshot()).messages.filter(message => message.role === "assistant").length, 2);

  // 4. Cancel is explicit and stops the model request.
  model.hold();
  updates.length = 0;
  runtime.on("update", (update: StreamUpdate) => updates.push(update));
  runtime.subscribe((await snapshot()).cursor);
  const cancelled = await runtime.send<{ runId: string }>("chat.runs.start", { sessionId: session.id, input: "Write a long essay" });
  const requestsBefore = model.state.requests;
  await until(() => model.state.requests, count => count > requestsBefore - 1 && model.state.waiting.length > 0);
  await runtime.request("chat.runs.cancel", { runId: cancelled.runId });
  await until(eventTypes, types => types.includes("run.cancelled"));
  await until(() => model.state.aborted, count => count >= 1);
  model.release();

  // 5. The server dies mid-answer: the message stays, the turn is interrupted, nothing re-runs.
  model.hold();
  const crashed = await runtime.send<{ runId: string }>("chat.runs.start", { sessionId: session.id, input: "One more question" });
  await until(() => model.state.waiting.length, count => count > 0);
  const requestsAtCrash = model.state.requests;
  await server.restart("SIGKILL");
  model.release();
  await until(() => mac.status().state, state => state === "online", 30_000);
  const recovered = await snapshot();
  const turn = recovered.messages.filter(message => message.runId === crashed.runId);
  assert.deepEqual(turn.map(message => [message.role, message.runStatus]), [["user", "interrupted"], ["assistant", "interrupted"]]);
  assert.equal(turn[0]!.content, "One more question");
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(model.state.requests, requestsAtCrash, "the interrupted turn was not executed again");
  assert.equal((await runtime.request<{ status: string }>("chat.runs.get", { runId: crashed.runId })).status, "interrupted");
});
