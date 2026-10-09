import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, flush, SESSION_ID, sessionSettings, type Harness } from "./fixtures/appHarness";

const HOST = "6f1c2c3e-58a4-4c55-9a0e-3c7f5b1d2e90";
const RUN = "0b6a3f0e-7f1d-4b9e-8a52-1f2c3d4e5f60";
const settle = async () => { await flush(30); await new Promise(resolve => setTimeout(resolve, 40)); await flush(10); };

/** A paired server behind the desktop bridge, with one chat; `agents`: a server that offers agent setup (R5-4). */
function fakeServer({ agents = false, hostOnly = "", manage = false } = {}) {
  let status: Record<string, unknown> = { state: "online", hostId: HOST, hostName: "fedora", serverVersion: "0.1.0",
    capabilities: ["chat.runs.start", "events.poll", ...(agents ? ["sessions.setup.get"] : []), ...(manage ? ["sessions.rename", "sessions.delete"] : [])] };
  const chats = [{ id: "srv-1", title: "Server chat", updatedAt: "2026-10-08T10:00:00.000Z" }, ...(manage ? [{ id: "srv-3", title: "Older chat", updatedAt: "2026-10-07T10:00:00.000Z" }] : [])];
  const statusListeners: Array<(value: unknown) => void> = [], eventListeners: Array<(value: unknown) => void> = [];
  const server = { messages: [] as unknown[], settings: { ...sessionSettings(), defaultTarget: { providerId: "llamacpp", model: "qwen" } }, head: 0 };
  const ok = (value: unknown) => ({ ok: true, value });
  const handlers: Record<string, (payload: any) => unknown> = {
    "sessions.list": () => chats,
    "sessions.rename": payload => Object.assign(chats.find(chat => chat.id === payload.sessionId)!, { title: payload.title }),
    "sessions.delete": payload => { chats.splice(chats.findIndex(chat => chat.id === payload.sessionId), 1); return { deleted: true }; },
    "sessions.create": () => ({ id: "srv-2", title: "New chat" }),
    "sessions.messages.list": () => ({ messages: server.messages, cursor: { streamId: "session:srv-1", epoch: "e1", after: server.head } }),
    "sessions.settings.get": () => server.settings,
    "sessions.setup.get": () => ({ settings: server.settings, access: { modes: ["ask", "default"], ...(hostOnly ? { hostOnly } : {}) }, limits: { subagents: 4, advisors: 5 } }),
    "sessions.settings.update": payload => (server.settings = { ...server.settings, ...payload.patch, debate: { ...server.settings.debate, ...payload.patch.debate } }),
    "models.available": () => ({ providers: [{ id: "llamacpp", name: "Local models" }, { id: "openai", name: "OpenAI" }], availableModels: [{ providerId: "openai", id: "gpt-4.1" }], loadedModels: [],
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
  assert.deepEqual(ops(app, "subscribe"), [[{ streamId: "session:srv-1", epoch: "e1", after: 0 }, HOST]], "every call names the server it is for");

  type(app, "Hi server");
  submit(app);
  await settle();
  assert.deepEqual(ops(app, "send"), [["chat.runs.start", { sessionId: "srv-1", input: "Hi server" }, HOST]]);
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
  assert.deepEqual(updates, [["sessions.settings.update", { sessionId: "srv-1", patch: { language: "en" } }, HOST]]);
  assert.deepEqual(app.requests.slice(localBefore).filter(entry => entry.startsWith("PUT")), [], "no local settings write");
});

const autosave = async () => { await new Promise(resolve => setTimeout(resolve, 800)); await settle(); };
const settingsUpdates = (app: Harness) => ops(app, "request").filter(([op]: [string]) => op === "sessions.settings.update").map(([, payload]: [string, any]) => payload.patch);
const field = (app: Harness, name: string) => app.document.querySelector(`#session-settings-form [name="${name}"]`);
const pick = (app: Harness, name: string, value: string) => { const element = field(app, name); element.value = value; element.dispatchEvent(new app.window.Event("change", { bubbles: true })); };

test("a server chat sets up subagents and debate agents with the server's own models", async t => {
  const paired = fakeServer({ agents: true });
  const app = await bootApp({ remote: { bridge: paired.bridge } });
  t.after(() => app.close());
  await choose(app, HOST);
  const localBefore = app.requests.length;
  assert.ok(ops(app, "request").some(([op]: [string]) => op === "sessions.setup.get"));
  assert.match(app.document.querySelector("#session-settings-form").textContent, /Subagents · on fedora[\s\S]*No configured subagents/);

  app.document.querySelector("[data-action='add-code-agent']").click();
  await autosave();
  const card = app.document.querySelector(".code-agent-card[data-code-agent-index='0']");
  assert.ok(card, "a subagent card is added");
  assert.match(field(app, "codeAgentModel:0").textContent, /Qwen · Loaded/, "the server's library, not this computer's");
  pick(app, "codeAgentProvider:0", "openai");
  assert.match(field(app, "codeAgentModel:0").textContent, /gpt-4\.1/, "the model list follows the provider at once");
  pick(app, "codeAgentModel:0", "gpt-4.1");
  await autosave();
  const name = String(field(app, "codeAgentName:0").value);
  const [added, changed] = settingsUpdates(app);
  assert.deepEqual(added, { codeAgents: [{ id: added.codeAgents[0].id, name, providerId: "llamacpp", model: "qwen" }] }, "only the agents, with no access mode");
  assert.deepEqual(changed, { codeAgents: [{ id: added.codeAgents[0].id, name, providerId: "openai", model: "gpt-4.1" }] });

  app.document.querySelector("[data-action='set-chat-type'][data-chat-type='hypothesis']").click();
  await autosave();
  assert.match(app.document.querySelector("#session-settings-form").textContent, /Hypothesis models · on fedora/);
  assert.deepEqual([...app.document.querySelectorAll(".hypothesis-agent-card [name^='hypothesisAgentName:']")].map((input: any) => input.value), ["Support", "Attack", "Judge"]);
  pick(app, "debateProfile", "security");
  app.document.querySelector("[data-action='add-hypothesis-agent']").click();
  await autosave();
  assert.deepEqual([...app.document.querySelectorAll("[name='hypothesisAgentRole:3'] option")].map((item: any) => item.value), ["advisor"], "an advisor stays an advisor");
  const latest = settingsUpdates(app).slice(2);
  assert.ok(latest.some((patch: any) => patch.mode === "hypothesis"), "the chat type is saved");
  const last = Object.assign({}, ...latest);
  assert.equal(last.debate.profile, "security");
  assert.equal("enabled" in last.debate, false, "whether it debates follows the chat type on the server");
  assert.deepEqual(last.hypothesisAgents.map((agent: any) => agent.role), ["support", "attack", "judge", "advisor"]);
  assert.deepEqual(last.hypothesisAgents[2], { id: "hypothesis-judge", name: "Judge", role: "judge", providerId: "local" });
  assert.deepEqual(app.requests.slice(localBefore).filter(entry => /^(PUT|POST) /.test(entry)), [], "nothing was saved on this computer");
});

test("a server too old for agent setup says so and sends no agents", async t => {
  const paired = fakeServer();
  const app = await bootApp({ remote: { bridge: paired.bridge } });
  t.after(() => app.close());
  await choose(app, HOST);
  assert.equal(app.document.querySelector("[data-action='add-code-agent']"), null);
  assert.match(app.document.querySelector(".remote-setup-note").textContent, /Update Local Cognitive on fedora to add subagents/);
  app.document.querySelector("[data-action='set-chat-type'][data-chat-type='hypothesis']").click();
  await autosave();
  assert.deepEqual(settingsUpdates(app), [{ mode: "hypothesis" }]);
});

test("a chat with full access on the server shows why and cannot be used or changed here", async t => {
  const paired = fakeServer({ agents: true, hostOnly: "This chat has full access on the server, so it can only be used or changed there." });
  const app = await bootApp({ remote: { bridge: paired.bridge } });
  t.after(() => app.close());
  await choose(app, HOST);
  assert.match(app.document.querySelector(".remote-setup-note--host").textContent, /full access on the server/);
  assert.equal(app.document.querySelector("#session-settings-form fieldset.remote-setup-fields").disabled, true);
  assert.match(app.document.querySelector("[data-chat-target-banner]").textContent, /full access on the server/);
  assert.equal(app.document.querySelector("#chat-access-menu"), null, "no access choices");
  assert.match(app.document.querySelector(".access-trigger").getAttribute("aria-label"), /Full access · set on fedora/);
  assert.equal(app.document.querySelector("#chat-form button[type='submit']").disabled, true);
  // Its read-only setup is never read back into a save.
  const language = app.document.querySelector("#session-settings-form select[name='language']");
  language.dispatchEvent(new app.window.Event("change", { bubbles: true }));
  await autosave();
  assert.deepEqual(settingsUpdates(app), []);
  type(app, "Do it");
  submit(app);
  await settle();
  assert.deepEqual(ops(app, "send"), [], "nothing is sent");
});

test("a server chat's access is ask or approve-for-me, saved on the server", async t => {
  const paired = fakeServer({ agents: true });
  const app = await bootApp({ remote: { bridge: paired.bridge } });
  t.after(() => app.close());
  await choose(app, HOST);
  const options = [...app.document.querySelectorAll("#chat-access-menu [data-access-mode]")].map((item: any) => item.dataset.accessMode);
  assert.deepEqual(options, ["ask", "default"], "full access is set only on the server");
  assert.match(app.document.querySelector("#chat-access-menu .access-menu__footer").textContent, /its agents on fedora/);
  app.document.querySelector("#chat-access-menu [data-access-mode='ask']").click();
  await settle();
  assert.deepEqual(settingsUpdates(app), [{ defaultAccessMode: "ask" }]);
  assert.equal(paired.server.settings.defaultAccessMode, "ask");
});

test("a server chat is renamed and deleted on the server", async t => {
  const paired = fakeServer({ manage: true });
  const app = await bootApp({ remote: { bridge: paired.bridge } });
  t.after(() => app.close());
  await choose(app, HOST);
  const localBefore = app.requests.length;
  const title = app.document.querySelector("#session-settings-form [data-remote-title]");
  title.value = "Weekly plan";
  title.dispatchEvent(new app.window.Event("change", { bubbles: true }));
  await settle();
  assert.match(app.document.querySelector(".sidebar-chats").textContent, /Weekly plan/);
  assert.equal(app.document.querySelector(".app-topbar h1").textContent, "Weekly plan");

  const remove = app.document.querySelector(".sidebar-chats [data-action='delete-session-quick'][data-session-id]");
  assert.match(remove.getAttribute("aria-label"), /Delete Weekly plan on fedora/);
  remove.click();
  await settle();
  assert.doesNotMatch(app.document.querySelector(".sidebar-chats").textContent, /Weekly plan/);
  assert.equal(app.document.querySelector(".app-topbar h1").textContent, "Older chat", "another chat of the server opens");
  const calls = ops(app, "request").filter(([op]: [string]) => ["sessions.rename", "sessions.delete"].includes(op));
  assert.deepEqual(calls, [["sessions.rename", { sessionId: "srv-1", title: "Weekly plan" }, HOST], ["sessions.delete", { sessionId: "srv-1" }, HOST]]);
  assert.deepEqual(app.requests.slice(localBefore).filter(entry => /^(PATCH|DELETE|PUT|POST) /.test(entry)), [], "nothing changed on this computer");
});

test("a server without rename and delete keeps its chats' titles read-only and offers no delete", async t => {
  const paired = fakeServer();
  const app = await bootApp({ remote: { bridge: paired.bridge } });
  t.after(() => app.close());
  await choose(app, HOST);
  assert.equal(app.document.querySelector("#session-settings-form [data-remote-title]"), null);
  assert.equal(app.document.querySelector(".sidebar-chats [data-action='delete-session-quick']"), null);
});
