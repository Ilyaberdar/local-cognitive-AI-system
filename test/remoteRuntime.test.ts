import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { RemoteError, type RemoteClient, type RemoteStatus } from "../src/remote/client/RemoteClient";
import { RemoteRuntime, type StreamUpdate } from "../src/remote/client/RemoteRuntime";
import { OPERATIONS, WATCHES, operationsOfKind } from "../src/runtime/operationCatalog";
import { memoryVault } from "./fixtures/remoteStack";

const FEDORA = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";

/** A connected client whose answers come from `handler`; `set` changes the connection. */
class FakeClient extends EventEmitter {
  current: RemoteStatus = { state: "online", hostId: FEDORA };
  calls: Array<{ op: string; payload: any; timeoutMs?: number; hostId?: string }> = [];
  handler: (op: string, payload: any) => Promise<unknown> = async () => ({});
  status() { return this.current; }
  set(next: RemoteStatus) { this.current = next; this.emit("change", next); }
  request(op: string, payload?: unknown, timeoutMs?: number) {
    this.calls.push({ op, payload, timeoutMs, hostId: this.current.hostId });
    return this.current.state === "online" ? this.handler(op, payload) : Promise.reject(new RemoteError("Not connected to a server.", "not_connected"));
  }
  waitOnline(timeoutMs: number) {
    if (this.current.state === "online") return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { this.off("change", changed); resolve(false); }, timeoutMs);
      const changed = (status: RemoteStatus) => { if (status.state === "online") { clearTimeout(timer); this.off("change", changed); resolve(true); } };
      this.on("change", changed);
    });
  }
}
const setup = () => {
  const client = new FakeClient();
  const runtime = new RemoteRuntime(client as unknown as RemoteClient, { resendWindowMs: 2000 });
  const updates: StreamUpdate[] = [];
  runtime.on("update", (update: StreamUpdate) => updates.push(update));
  return { client, runtime, updates };
};
const until = async (done: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test("a call for a server that is no longer selected is refused before anything is sent", async () => {
  const { client, runtime } = setup();
  await assert.rejects(runtime.request("models.local.delete", { modelId: "m" }, { hostId: OTHER }), (error: RemoteError) => error.code === "host_changed");
  await assert.rejects(runtime.send("models.downloads.start", { repoId: "r" }, { hostId: OTHER }), (error: RemoteError) => error.code === "host_changed");
  assert.throws(() => runtime.watch("models.local", "models.local.watch", { hostId: OTHER }), (error: RemoteError) => error.code === "host_changed");
  assert.equal(client.calls.length, 0);
  await runtime.request("models.local.delete", { modelId: "m" }, { hostId: FEDORA });
  assert.equal(client.calls[0]!.timeoutMs, OPERATIONS["models.local.delete"]!.timeoutMs, "each operation waits as long as the catalog says");
});

test("a command lost in a reconnect is resent to the same server only", async () => {
  const { client, runtime } = setup();
  let attempts = 0;
  client.handler = async (_op, payload) => {
    if (++attempts === 1) {
      client.set({ state: "reconnecting", hostId: FEDORA });
      setTimeout(() => client.set({ state: "online", hostId: FEDORA }), 20);
      throw new RemoteError("The connection dropped.", "disconnected");
    }
    return { id: "job-1", commandId: payload.commandId };
  };
  const result = await runtime.send<{ commandId: string }>("models.downloads.start", { repoId: "r" }, { hostId: FEDORA });
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1]!.payload.commandId, client.calls[0]!.payload.commandId, "the resend carries the same command id");
  assert.equal(result.commandId, client.calls[0]!.payload.commandId);

  // The user switches to another server while the answer is in doubt: nothing goes there.
  client.calls.length = 0;
  client.handler = async () => {
    client.set({ state: "online", hostId: OTHER });
    throw new RemoteError("The connection dropped.", "disconnected");
  };
  await assert.rejects(runtime.send("models.downloads.start", { repoId: "r" }, { hostId: OTHER }), (error: RemoteError) => error.code === "host_changed");
  client.set({ state: "online", hostId: FEDORA });
  await assert.rejects(runtime.send("models.downloads.start", { repoId: "r" }, { hostId: FEDORA }), (error: RemoteError) => error.code === "unknown_outcome");
  assert.deepEqual(client.calls.map(call => call.hostId), [FEDORA], "the command was never sent to the other server");
});

test("a watch delivers the whole state first, keeps its cursor through an empty wait and ends when the server changes", async () => {
  const { client, runtime, updates } = setup();
  let release: (value: unknown) => void = () => undefined;
  const answers: Array<() => Promise<unknown>> = [
    async () => ({ epoch: "e1", sequence: 3, snapshot: { models: ["a"] } }),
    // The wait ended without a snapshot while the state moved on: the cursor must not skip it.
    async () => ({ epoch: "e1", sequence: 4 }),
    async () => ({ epoch: "e1", sequence: 4, snapshot: { models: ["a", "b"] } }),
    () => new Promise(resolve => { release = resolve; })
  ];
  client.handler = async op => { assert.equal(op, "models.local.watch"); return answers.shift()!(); };
  runtime.watch("models.local", "models.local.watch", { hostId: FEDORA });
  await until(() => client.calls.length === 4);
  assert.deepEqual(client.calls.map(call => [call.payload.epoch, call.payload.after]), [["", 0], ["e1", 3], ["e1", 3], ["e1", 4]]);
  assert.deepEqual(updates, [{ streamId: "models.local", sequence: 3, snapshot: { models: ["a"] } }, { streamId: "models.local", sequence: 4, snapshot: { models: ["a", "b"] } }]);

  client.set({ state: "online", hostId: OTHER });
  assert.deepEqual(updates.at(-1), { streamId: "models.local", resync: "host_changed" });
  release({ epoch: "e1", sequence: 5, snapshot: { models: [] } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(updates.length, 3, "an answer from the old server is dropped");
  assert.equal(client.calls.length, 4);
});

test("a watch survives a dropped connection and stops on a server without the operation", async () => {
  const { client, runtime, updates } = setup();
  let attempts = 0;
  client.handler = async () => {
    if (++attempts === 1) {
      client.set({ state: "reconnecting", hostId: FEDORA });
      setTimeout(() => client.set({ state: "online", hostId: FEDORA }), 20);
      throw new RemoteError("The connection dropped.", "disconnected");
    }
    if (attempts === 2) return { epoch: "e1", sequence: 1, snapshot: {} };
    throw new RemoteError("The server does not support models.local.watch.", "unknown_operation");
  };
  runtime.watch("models.local", "models.local.watch", { hostId: FEDORA });
  await until(() => updates.length === 2);
  assert.deepEqual(updates, [{ streamId: "models.local", sequence: 1, snapshot: {} }, { streamId: "models.local", resync: "unknown_operation" }]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(attempts, 3, "no polling after the server said it cannot");
});

test("the desktop bridge lets screens call the catalog's operations, each by its kind, on the server they name", async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<{ ok: boolean; value?: unknown; error?: { code: string } }>>();
  const accountService = Object.assign(new EventEmitter(), { status: () => ({ state: "signed-out" }), getAccessToken: async () => "" });
  const { registerRemote } = require(path.resolve(__dirname, "..", "..", "electron", "remote.cjs"));
  const bridge = registerRemote({ app: { isPackaged: false }, ipcMain: { handle: (name: string, fn: never) => handlers.set(name, fn) }, vault: memoryVault(),
    accountService, assertSender: () => undefined, getWindow: () => undefined });
  const call = (name: string, ...args: unknown[]) => handlers.get(`remote:${name}`)!({}, ...args);
  const code = async (name: string, ...args: unknown[]) => (await call(name, ...args)).error?.code;
  try {
    assert.equal(await code("runtime-request", "fs.read", {}, FEDORA), "unsupported");
    assert.equal(await code("runtime-request", "constructor", {}, FEDORA), "unsupported");
    assert.equal(await code("runtime-request", "models.downloads.start", {}, FEDORA), "unsupported", "a command is sent only with a command id");
    assert.equal(await code("runtime-request", "models.local.watch", {}, FEDORA), "unsupported", "a watch is followed by the client, not called");
    assert.equal(await code("runtime-send", "models.local.delete", {}, FEDORA), "unsupported");
    assert.equal(await code("runtime-watch", "events", FEDORA), "unsupported");
    assert.equal(await code("runtime-watch", "toString", FEDORA), "unsupported");
    assert.equal(await code("runtime-request", "models.local.delete", { modelId: "m" }), "invalid_request", "a call must name its server");
    assert.equal(await code("runtime-request", "models.local.delete", { modelId: "m" }, FEDORA), "host_changed", "not connected to that server");
    assert.equal(await code("runtime-send", "models.downloads.start", { repoId: "r" }, FEDORA), "not_connected");
    assert.equal(await code("runtime-watch", "models.local", FEDORA), "host_changed");
    const cursor = (streamId: string) => ({ streamId, epoch: "e", after: 0 });
    assert.equal(await code("runtime-subscribe", cursor("workflow-run:4f1c1b0e-8d5a-4b8e-9c55-0a6b2f1e9d11"), FEDORA), "host_changed", "a run's log can be followed");
    assert.equal(await code("runtime-subscribe", cursor("workflow-run:../../etc/passwd"), FEDORA), "invalid_request");
    assert.equal(await code("runtime-subscribe", cursor("models.local"), FEDORA), "invalid_request");
  } finally { bridge.dispose(); }
  for (const op of Object.values(WATCHES)) assert.equal(OPERATIONS[op]!.kind, "watch");
  assert.ok(operationsOfKind("command").includes("chat.runs.start") && !operationsOfKind("request").includes("events.poll"));
});
