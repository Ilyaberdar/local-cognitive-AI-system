import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, flush, SESSION_ID, sessionSettings, type Harness } from "./fixtures/appHarness";

const HOST = "6f1c2c3e-58a4-4c55-9a0e-3c7f5b1d2e90";
const RUN = "0b6a3f0e-7f1d-4b9e-8a52-1f2c3d4e5f60";
const settle = async () => { await flush(30); await new Promise(resolve => setTimeout(resolve, 40)); await flush(10); };

/** A paired server behind the desktop bridge, with one chat. */
function fakeServer() {
  let status: Record<string, unknown> = { state: "online", hostId: HOST, hostName: "fedora", serverVersion: "0.1.0", capabilities: ["chat.runs.start", "events.poll"] };
  const statusListeners: Array<(value: unknown) => void> = [], eventListeners: Array<(value: unknown) => void> = [];
  const server = { messages: [] as unknown[], settings: { ...sessionSettings(), defaultTarget: { providerId: "llamacpp", model: "qwen" } }, head: 0 };
  const ok = (value: unknown) => ({ ok: true, value });
  const handlers: Record<string, (payload: any) => unknown> = {
    "sessions.list": () => [{ id: "srv-1", title: "Server chat", updatedAt: "2026-10-08T10:00:00.000Z" }],
    "sessions.create": () => ({ id: "srv-2", title: "New chat" }),
    "sessions.messages.list": () => ({ messages: server.messages, cursor: { streamId: "session:srv-1", epoch: "e1", after: server.head } }),
    "sessions.settings.get": () => server.settings,
    "sessions.settings.update": payload => (server.settings = { ...server.settings, ...payload.patch }),
    "models.available": () => ({ providers: [{ id: "llamacpp", name: "Local models" }], availableModels: [], loadedModels: [],
      allManagedModels: [{ providerId: "llamacpp", id: "qwen", libraryId: "qwen", displayName: "Qwen", filesAvailable: true, compatibility: { canLoad: true }, loaded: true }],
      appSettings: { llm: { defaultProvider: "llamacpp" }, providers: {} } }),
    "chat.runs.cancel": payload => ({ runId: payload.runId, status: "running" })
  };
  const bridge = {
    status: async () => ok(status),
    hosts: async () => ok([{ hostId: HOST, name: "fedora", online: true, appVersion: "0.1.0", paired: true, devices: [] }]),
    connect: async () => ok(status), disconnect: async () => ok({ state: "idle" }), hostStatus: async () => ok({}),
    onChange: (listener: (value: unknown) => void) => { statusListeners.push(listener); },
    runtime: {
      request: async (op: string, payload: unknown) => ok(handlers[op]!(payload)),
      send: async (_op: string, payload: { input: string }) => ok({ commandId: "c1", status: "accepted", runId: RUN, userMessageId: "u1", assistantMessageId: "a1", input: payload.input }),
      subscribe: async () => ok(undefined), unsubscribe: async () => ok(undefined),
      onEvent: (listener: (value: unknown) => void) => { eventListeners.push(listener); }
    }
  };
  return { bridge, server, setStatus(next: Record<string, unknown>) { status = { ...status, ...next }; statusListeners.forEach(listener => listener(status)); },
    emit(events: unknown[]) { eventListeners.forEach(listener => listener({ streamId: "session:srv-1", events })); } };
}

const type = (app: Harness, text: string) => {
  const field = app.document.querySelector("#chat-form textarea");
  field.value = text;
  field.dispatchEvent(new app.window.Event("input", { bubbles: true }));
};
const submit = (app: Harness) => app.document.querySelector("#chat-form").dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
const choose = async (app: Harness, target: string) => { app.document.querySelector(`[data-chat-target="${target}"]`).click(); await settle(); };
/** Bridge calls of one kind, as plain values (they were made in the page's realm). */
const ops = (app: Harness, name: string) => JSON.parse(JSON.stringify(app.bridgeCalls.filter(call => call.op === `runtime.${name}`).map(call => call.payload)));

/** The local chat's requests for one message, recorded before Remote chat existed. */
const LOCAL_TRACE = ["GET /dashboard/bootstrap", "GET /integrations/available", `GET /sessions/${SESSION_ID}/messages`, `GET /sessions/${SESSION_ID}/settings`,
  "GET /local/runtime", "GET /local/downloads", "EVENTSOURCE /local/events", `PUT /sessions/${SESSION_ID}/settings`, "POST /chat", "GET /process-runs/chat-<id>",
  "GET /dashboard/bootstrap", "GET /integrations/available", `GET /sessions/${SESSION_ID}/messages`, `GET /sessions/${SESSION_ID}/settings`];

async function sendLocally(app: Harness) {
  type(app, "Hello");
  submit(app);
  await flush(30);
  await app.poll();
  assert.equal(app.document.querySelector(".message.pending .subagent-pending-line")?.textContent, "Hel");
  app.resolveChat();
  await flush(40);
  return app.requests.map(entry => entry.split(" ").slice(0, 2).join(" "));
}

test("the local chat makes exactly the same requests with or without a paired server", async t => {
  const plain = await bootApp();
  t.after(() => plain.close());
  assert.deepEqual(await sendLocally(plain), LOCAL_TRACE);
  assert.match(plain.requests.find(entry => entry.startsWith("POST /chat"))!, /"sessionId":"11111111-1111-4111-8111-111111111111"/);

  const paired = fakeServer();
  const withServer = await bootApp({ remote: { bridge: paired.bridge } });
  t.after(() => withServer.close());
  assert.ok(withServer.document.querySelector(".chat-target-trigger"), "the switch is offered once a server is paired");
  assert.match(withServer.document.querySelector(".chat-target-label").textContent, /This computer/);
  assert.deepEqual(await sendLocally(withServer), LOCAL_TRACE);
  assert.deepEqual(ops(withServer, "send"), [], "nothing went to the server");
  assert.deepEqual(ops(withServer, "request"), []);
});

test("a server chat runs on the server only: history, sending, streaming and the finished turn", async t => {
  const paired = fakeServer();
  const app = await bootApp({ remote: { bridge: paired.bridge } });
  t.after(() => app.close());
  await choose(app, HOST);
  const localBefore = app.requests.length;
  assert.equal(app.document.querySelector(".chat-target-label").textContent, "fedora");
  assert.match(app.document.querySelector(".sidebar-chats").textContent, /Chats on fedora[\s\S]*Server chat/);
  assert.equal(app.document.querySelector(".app-topbar h1").textContent, "Server chat");
  assert.equal(app.document.querySelector("[data-action='attach-files']"), null, "attachments stay local");
  assert.equal(app.document.querySelector(".access-trigger"), null, "access modes stay local");
  assert.match(app.document.querySelector("#session-settings-form").textContent, /Main model · on fedora/);
  assert.deepEqual(ops(app, "request").map(([op]: [string]) => op).sort(), ["models.available", "sessions.list", "sessions.messages.list", "sessions.settings.get"]);
  assert.deepEqual(ops(app, "subscribe"), [[{ streamId: "session:srv-1", epoch: "e1", after: 0 }]]);

  type(app, "Hi server");
  submit(app);
  await settle();
  assert.deepEqual(ops(app, "send"), [["chat.runs.start", { sessionId: "srv-1", input: "Hi server" }]]);
  assert.equal(app.document.querySelector(".message.pending.user")?.textContent.includes("Hi server") ?? app.document.querySelector(".message.pending")?.textContent.includes("Hi server"), true);
  paired.emit([{ seq: 1, type: "message.accepted", occurredAt: "t", payload: { runId: RUN, message: { content: "Hi server", createdAt: "t" } } },
    { seq: 2, type: "run.started", occurredAt: "t", payload: { runId: RUN } },
    { seq: 3, type: "message.delta", occurredAt: "t", payload: { runId: RUN, offset: 0, text: "Hel" } },
    { seq: 4, type: "message.delta", occurredAt: "t", payload: { runId: RUN, offset: 3, text: "lo" } }]);
  await settle();
  assert.equal(app.document.querySelector(".message.pending .subagent-pending-line").textContent, "Hello");
  paired.emit([{ seq: 4, type: "message.delta", occurredAt: "t", payload: { runId: RUN, offset: 3, text: "lo" } }]);
  await settle();
  assert.equal(app.document.querySelector(".message.pending .subagent-pending-line").textContent, "Hello", "a replay changes nothing");

  paired.server.messages = [{ id: "m:user", role: "user", content: "Hi server", createdAt: "2026-10-08T10:00:01.000Z", runId: RUN },
    { id: "m:assistant", role: "assistant", content: "Hello from the server", createdAt: "2026-10-08T10:00:02.000Z", runId: RUN }];
  paired.server.head = 6;
  paired.emit([{ seq: 5, type: "message.completed", occurredAt: "t", payload: { runId: RUN } }, { seq: 6, type: "run.completed", occurredAt: "t", payload: { runId: RUN } }]);
  await settle();
  assert.equal(app.document.querySelector(".message.pending"), null);
  assert.match(app.document.querySelector(".message-stream").textContent, /Hello from the server/);
  assert.equal(ops(app, "request").filter(([op]: [string]) => op === "sessions.messages.list").length, 2, "the finished turn reloads history");
  assert.deepEqual(app.requests.slice(localBefore).filter(entry => /\/chat|\/sessions\/|process-runs/.test(entry)), [], "nothing reached this computer's chat API");
});

test("while the server is away nothing is sent, the draft stays, and drafts never cross targets", async t => {
  const paired = fakeServer();
  const app = await bootApp({ remote: { bridge: paired.bridge } });
  t.after(() => app.close());
  type(app, "local draft");
  await choose(app, HOST);
  assert.equal(app.document.querySelector("#chat-form textarea").value, "", "the server chat has its own draft");
  type(app, "server draft");
  paired.setStatus({ state: "reconnecting" });
  await settle();
  assert.match(app.document.querySelector("[data-chat-target-banner]").textContent, /fedora is reconnecting\. Nothing is sent; your draft is kept\./);
  assert.equal(app.document.querySelector("#chat-form button[type='submit']").disabled, true);
  submit(app);
  await settle();
  assert.deepEqual(ops(app, "send"), [], "offline: nothing is sent");
  assert.equal(app.document.querySelector("#chat-form textarea").value, "server draft");

  paired.setStatus({ state: "online" });
  await settle();
  await choose(app, "local");
  assert.equal(app.document.querySelector("#chat-form textarea").value, "local draft");
  assert.equal(app.document.querySelector(".app-topbar h1").textContent, "First chat");
  await choose(app, HOST);
  assert.equal(app.document.querySelector("#chat-form textarea").value, "server draft");
});

test("settings of a server chat are saved on the server, only the changed ones", async t => {
  const paired = fakeServer();
  const app = await bootApp({ remote: { bridge: paired.bridge } });
  t.after(() => app.close());
  await choose(app, HOST);
  const localBefore = app.requests.length;
  const language = app.document.querySelector("#session-settings-form select[name='language']");
  language.value = "en";
  language.dispatchEvent(new app.window.Event("change", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 800));
  await settle();
  const updates = ops(app, "request").filter(([op]: [string]) => op === "sessions.settings.update");
  assert.deepEqual(updates, [["sessions.settings.update", { sessionId: "srv-1", patch: { language: "en" } }]]);
  assert.deepEqual(app.requests.slice(localBefore).filter(entry => entry.startsWith("PUT")), [], "no local settings write");
});
