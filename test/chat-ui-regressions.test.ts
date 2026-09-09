import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync("public/assets/app.js", "utf8");
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const functionSource = (name: string, next: string) => source.slice(source.indexOf(name), source.indexOf(next, source.indexOf(name)));

test("chat submit locks before setup save and old cleanup cannot reset a new request", async () => {
  const setup = deferred<void>(); const answer = deferred<{ sessionId: string }>(); const sent = deferred<void>();
  const state: any = { activeSessionId: "a", activeChatRequest: null, chatSubmitting: false,
    drafts: { a: "prompt", b: "keep this draft" }, draftAttachments: {}, ui: {} };
  let handler!: (event: any) => Promise<void>; let calls = 0;
  const stopped: unknown[] = [];
  const context = { state, AbortController, FormData: class { get() { return "Explain arrays"; } },
    document: { querySelector: () => ({ addEventListener: (_name: string, callback: typeof handler) => { handler = callback; } }) },
    createUiEntityId: () => "request-a", getActiveDraftAttachments: () => [], persistActiveSessionSetup: () => setup.promise,
    window: { location: { hash: "" } }, isSubagentRequest: () => false, isMessageStreamNearBottom: () => false,
    render: () => {}, startProcessProgressPolling: () => {}, stopProcessProgressPolling: (active: unknown) => stopped.push(active),
    refreshBootstrap: async () => {}, loadActiveSession: async () => {},
    api: { sendChat: async () => { calls++; sent.resolve(); return answer.promise; } },
    preserveStoppedChatRequest: () => {}, pushToast: () => {}
  };
  const start = source.indexOf('  document.querySelector("#chat-form")?.addEventListener("submit"');
  vm.runInNewContext(source.slice(start, source.indexOf('  document.querySelector("#chat-form textarea', start)), context);
  const button = { disabled: false };
  const event = { preventDefault() {}, currentTarget: { querySelector: () => button } };
  const first = handler(event);
  const original = state.activeChatRequest;
  await handler(event);
  assert.equal(button.disabled, true);
  assert.equal(state.chatSubmitting, true);
  assert.equal(calls, 0);
  state.activeSessionId = "b";
  setup.resolve(); await sent.promise;
  assert.equal(calls, 1);
  assert.equal(state.drafts.b, "keep this draft");
  original.cancelled = true;
  const newer = { requestId: "request-b" };
  state.activeChatRequest = newer;
  answer.resolve({ sessionId: "a" }); await first;
  assert.equal(state.activeChatRequest, newer);
  assert.equal(state.chatSubmitting, true);
  assert.deepEqual(stopped, [original]);
});

test("late progress from an old request cannot overwrite the current request", async () => {
  const response = deferred<unknown>(); let tick!: () => Promise<void>;
  const active = { requestId: "a" };
  const state: any = { activeChatRequest: active, pendingRequest: { progress: { label: "A" } } };
  let updates = 0;
  const context = { state, window: { setInterval: (callback: typeof tick) => { tick = callback; return 1; } },
    api: { getProcessRun: () => response.promise }, stopProcessProgressPolling() {}, updateChatActivityProgress() { updates++; }, active };
  vm.runInNewContext(functionSource("function startProcessProgressPolling", "function stopProcessProgressPolling") + "startProcessProgressPolling(active);", context);
  const polling = tick();
  state.activeChatRequest = { requestId: "b" };
  state.pendingRequest = { progress: { label: "B" } };
  response.resolve({ progress: { label: "Old A" } }); await polling;
  assert.equal(state.pendingRequest.progress.label, "B");
  assert.equal(updates, 0);
});

test("late session reads do not replace the selected conversation or clear another run", async () => {
  const aMessages = deferred<unknown>(); const aSettings = deferred<unknown>();
  const pending = { sessionId: "a", startedAt: new Date(0).toISOString() };
  const state: any = { activeSessionId: "a", pendingRequest: pending };
  const context: any = { state, sessionLoadSequence: 0, api: {
    getSessionMessages: (id: string) => id === "a" ? aMessages.promise : Promise.resolve([{ role: "assistant", content: "B", createdAt: new Date().toISOString() }]),
    getSessionSettings: (id: string) => id === "a" ? aSettings.promise : Promise.resolve({ name: "B" })
  } };
  vm.runInNewContext(functionSource("async function loadActiveSession", "async function request("), context);
  const loadA = context.loadActiveSession(); state.activeSessionId = "b";
  await context.loadActiveSession();
  assert.equal(state.pendingRequest, pending);
  aMessages.resolve([{ content: "A" }]); aSettings.resolve({ name: "A" }); await loadA;
  assert.equal(state.messages[0].content, "B");
  assert.equal(state.sessionSettings.name, "B");
});

test("model load keeps the confirmed catalog when refreshing metrics fails", async () => {
  let handler!: () => Promise<void>;
  const model = { id: "tiny", providerId: "lmstudio", loaded: true, loadedInstanceIds: ["tiny"] };
  const state: any = { modelActions: {}, bootstrap: { loadedModels: [], allManagedModels: [] } };
  const toasts: string[] = [];
  const context = { state,
    document: { querySelectorAll: () => [{ dataset: { modelId: "tiny", providerId: "lmstudio" }, addEventListener: (_: string, fn: typeof handler) => { handler = fn; } }] },
    captureScrollState() {}, restoreScrollState() {}, render() {},
    api: { loadModel: async () => {}, getSystemMetrics: async () => { throw new Error("metrics unavailable"); } },
    waitForManagedModelState: async () => ({ loadedModels: [model], allManagedModels: [model] }),
    pushToast: (message: string) => toasts.push(message)
  };
  const start = source.indexOf('  document.querySelectorAll("[data-action=\'load-model\']")');
  const end = source.indexOf('  document.querySelectorAll("[data-action=\'unload-model\']")', start);
  vm.runInNewContext(source.slice(start, end), context);
  await handler();
  assert.equal(state.bootstrap.loadedModels[0], model);
  assert.deepEqual(toasts, []);
  assert.equal(Object.keys(state.modelActions).length, 0);
});

test("load confirmation tolerates a stale catalog and the browser allows the full backend budget", async () => {
  let reads = 0; let succeedsOn = 2;
  const context: any = { state: { bootstrap: { appSettings: { providers: { lmstudio: { timeoutMs: 600000 } } } } },
    window: { setTimeout: (fn: () => void) => fn() },
    api: { refreshManagedModels: async () => { const loaded = ++reads >= succeedsOn; return { allManagedModels: [{ providerId: "lmstudio", id: "tiny", loaded }], loadedModels: loaded ? [{ providerId: "lmstudio", id: "tiny" }] : [] }; } }
  };
  vm.runInNewContext(functionSource("async function waitForManagedModelState", "async function pollWorkflowProgress") +
    functionSource("function localModelActionTimeoutMs", "function providerTimeoutHelp"), context);
  const managed = await context.waitForManagedModelState("lmstudio", "tiny", true);
  assert.equal(reads, 2);
  assert.equal(managed.loadedModels.length, 1);
  reads = 0; succeedsOn = 6;
  assert.equal((await context.waitForManagedModelState("lmstudio", "tiny", true)).loadedModels.length, 1);
  assert.equal(reads, 6);
  assert.equal(context.localModelActionTimeoutMs("lmstudio"), 630000);
  assert.equal(context.localModelActionTimeoutMs("ollama"), 330000);
});
