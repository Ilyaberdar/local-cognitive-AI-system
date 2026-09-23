import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync("public/assets/app.js", "utf8");
const fragment = (start: string, end: string) => {
  const offset = source.indexOf(start);
  assert.notEqual(offset, -1, `Missing UI entry point: ${start}`);
  const boundary = source.indexOf(end, offset);
  assert.notEqual(boundary, -1, `Missing UI boundary: ${end}`);
  return source.slice(offset, boundary);
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const modelUseCallback = fragment("  onUse: async (model) => {", "  onDefault:").trim().replace(/^onUse:\s*/, "").replace(/,$/, "");
const modelLabelHelpers = fragment("function getModelDisplayName", "function getLoadedModelOptions");

test("memory warnings cannot disguise an architecture or disk failure in model cards", () => {
  const managerSource = fs.readFileSync("public/assets/model-manager.js", "utf8");
  const body = managerSource.slice(managerSource.indexOf("  function compatibility("), managerSource.indexOf("  function renderCompatibility("));
  const context: any = { asArray: (value: unknown) => Array.isArray(value) ? value : [] };
  vm.runInNewContext(body, context);
  const architecture = context.compatibility({ compatibility: { status: "incompatible", reasons: ["The qwen35 architecture is not in the supported text-model list for this runtime."], warnings: ["Memory is tight. Loading may cause swapping."] } });
  assert.equal(architecture.label, "Unsupported model type"); assert.equal(architecture.tone, "danger");
  const disk = context.compatibility({ compatibility: { status: "incompatible", canDownload: false, reasons: ["Not enough free disk space."], warnings: ["Memory is tight."] } });
  assert.equal(disk.label, "Not enough disk space"); assert.equal(disk.downloadBlocked, true);
  const memory = context.compatibility({ compatibility: { status: "warning", canLoad: true, canDownload: true, reasons: [], warnings: ["Estimated memory use exceeds your 75% warning threshold."] } });
  assert.equal(memory.label, "High memory usage"); assert.equal(memory.loadBlocked, false); assert.equal(memory.downloadBlocked, false);
  const largeDownload = context.compatibility({ compatibility: { status: "incompatible", canLoad: false, canDownload: true, blockingIssues: [{ code: "model_memory" }], reasons: ["The weights exceed device memory."], warnings: [] } });
  assert.equal(largeDownload.label, "Weights exceed device memory"); assert.equal(largeDownload.loadBlocked, true); assert.equal(largeDownload.downloadBlocked, false);
  const estimate = context.compatibility({ compatibility: { status: "warning", canLoad: true, canDownload: true, estimatedMemoryBytes: 1500000000, totalMemoryBytes: 48 * 1024 ** 3,
    reasons: [], warnings: ["Memory is an estimate. GGUF metadata is checked after download and runtime support is verified when loading."] } });
  assert.equal(estimate.label, "Compatibility checked on load"); assert.equal(estimate.tone, "muted"); assert.equal(estimate.downloadBlocked, false);
});

test("choosing a local model cannot copy a switched session during deferred autosave", async () => {
  const autosave = deferred<void>();
  const sessionB = { mode: "code", defaultTarget: { providerId: "openai", model: "remote-b" } };
  const state: any = { activeSessionId: "a", sessionSettings: { mode: "chat" }, ui: { autosavePromise: autosave.promise } };
  const writes: any[] = []; let renders = 0;
  const window = { clearTimeout() {}, location: { hash: "#/models" } };
  const onUse = vm.runInNewContext(`(${modelUseCallback})`, {
    state, window, render: () => { renders++; },
    api: { updateSessionSettings: async (id: string, patch: unknown) => { writes.push({ id, patch }); return { mode: "chat", ...patch as object }; } },
    readSessionSetupSnapshot: () => ({ settings: state.sessionSettings }),
    sessionSettingsToPatch: (settings: unknown) => settings
  });
  const pending = onUse({ libraryId: "gguf-chosen" });
  state.activeSessionId = "b";
  state.sessionSettings = sessionB;
  autosave.resolve(); await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ id: "a", patch: { defaultTarget: { providerId: "llamacpp", model: "gguf-chosen" } } }]);
  assert.equal(state.sessionSettings, sessionB);
  assert.equal(renders, 0);
  assert.equal(window.location.hash, "#/models");
});

test("choosing a local model preserves session settings and only opens the still-current chat", async () => {
  const response = deferred<unknown>(); const written = deferred<void>();
  const saved = { mode: "code", codeAgents: [{ name: "Existing" }], defaultTarget: { providerId: "llamacpp", model: "gguf-chosen" } };
  const state: any = { activeSessionId: "a", sessionSettings: { mode: "code" }, ui: { autosavePromise: Promise.resolve() } };
  let renders = 0;
  const window = { clearTimeout() {}, location: { hash: "#/models" } };
  const onUse = vm.runInNewContext(`(${modelUseCallback})`, { state, window, render: () => { renders++; },
    api: { updateSessionSettings: async (_id: string, patch: object) => { assert.deepEqual(Object.keys(patch), ["defaultTarget"]); written.resolve(); return response.promise; } }
  });
  const pending = onUse({ id: "gguf-chosen" });
  await written.promise; response.resolve(saved); await pending;
  assert.equal(state.sessionSettings, saved);
  assert.equal(renders, 1);
  assert.equal(window.location.hash, "#/chat");
});

test("backend-owned requests have no browser deadline while ordinary deadlines and connection failures remain", async () => {
  const response = deferred<unknown>();
  const timers: { fn: () => void; ms: number }[] = []; const cleared: number[] = [];
  const context: any = { AbortController, DOMException, Error,
    window: { setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id: number) => cleared.push(id) },
    fetch: () => response.promise
  };
  vm.runInNewContext(fragment("async function request(", "function applyTheme"), context);
  const pending = context.request("/local/models/load", { timeoutMs: 0 });
  assert.equal(timers.length, 0);
  response.resolve({ ok: true, status: 200, json: async () => ({ ready: true }) });
  assert.equal((await pending).ready, true);
  assert.equal(cleared.length, 0);
  context.fetch = async () => { throw new TypeError("Connection closed"); };
  await assert.rejects(context.request("/providers/llamacpp/test", { timeoutMs: 0 }), /Connection closed/);
  context.fetch = (_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
  const normal = context.request("/dashboard/bootstrap");
  assert.equal(timers[0].ms, 30000);
  timers[0].fn();
  await assert.rejects(normal, /Request timed out/);
  assert.deepEqual(cleared, [1]);
});

test("provider tests submit the chosen model and only built-in runtime requests omit the browser deadline", async () => {
  const calls: any[] = [];
  const context: any = { state: { bootstrap: { appSettings: { providers: {} } } },
    request: async (url: string, options: unknown) => calls.push({ url, options }),
    isLocalProvider: (id: string) => ["llamacpp", "lmstudio", "ollama"].includes(id)
  };
  vm.runInNewContext(fragment("function defaultProviderTimeoutMs", "function providerTimeoutHelp") + fragment("const api = {", "const projectsUi =") + "globalThis.api = api;", context);
  await context.api.testProvider("llamacpp", "gguf-selected");
  await context.api.loadModel("llamacpp", "gguf-selected");
  await context.api.unloadModel("llamacpp", "gguf-selected");
  await context.api.testProvider("openai", "selected-remote");
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: "gguf-selected" });
  assert.deepEqual(calls.slice(0, 3).map((call) => call.options.timeoutMs), [0, 0, 0]);
  assert.equal(calls[3].options.timeoutMs, 90000);
  assert.deepEqual(JSON.parse(calls[3].options.body), { model: "selected-remote" });
});

test("cloud model selectors include the models discovered with the user's provider key", () => {
  const source = fs.readFileSync("public/assets/app.js", "utf8");
  const helpers = source.slice(source.indexOf("function getModelOptions"), source.indexOf("function renderChip"));
  const context: any = {
    state: { bootstrap: { availableModels: [
      { providerId: "openai", id: "gpt-5-custom" },
      { providerId: "openai", id: "ft:gpt-4.1-mini:team:example" },
      { providerId: "anthropic", id: "claude-unrelated" }
    ], allManagedModels: [], appSettings: { providers: { openai: { model: "gpt-4.1-mini" } } } } },
    isLocalProvider: () => false,
    escapeAttr: (value: unknown) => String(value),
    escapeHtml: (value: unknown) => String(value),
    option: (model: string, selected: string, label: string) => `<option value="${model}"${model === selected ? " selected" : ""}>${label}</option>`
  };
  vm.runInNewContext(helpers, context);
  const choices = context.getProviderSuggestedModels("openai");
  assert.ok(choices.includes("gpt-5-custom"));
  assert.ok(choices.includes("ft:gpt-4.1-mini:team:example"));
  const rendered = context.renderProviderSettingsModelControl("openai", "gpt-4.1-mini");
  assert.match(rendered, /<select name="provider\.openai\.model">/);
  assert.match(rendered, /gpt-5-custom/);
  assert.doesNotMatch(rendered, /<input name="provider\.openai\.model"/);
});

test("local model test captures the form selection, prevents duplicates and leaves the UI editable", async () => {
  const answer = deferred<unknown>(); let handler!: () => Promise<void>;
  const selected = { value: "gguf-selected" };
  const button = { dataset: { providerId: "llamacpp" }, form: { elements: { namedItem: () => selected } }, addEventListener: (_name: string, fn: typeof handler) => { handler = fn; } };
  const calls: unknown[][] = []; let starts = 0; let updates = 0;
  const state: any = { loading: false, localModelTest: null, providerTestResults: {} };
  vm.runInNewContext(fragment('  document.querySelectorAll("[data-action=\'test-provider\']")', '  document.querySelectorAll("[data-chip-kind]")'), {
    state, Error, document: { querySelectorAll: () => [button] },
    modelManager: { start: () => { starts++; } }, updateLocalModelTestProgress: () => { updates++; },
    api: { testProvider: (...args: unknown[]) => { calls.push(args); return answer.promise; } },
    runAction: () => { assert.fail("Local testing must not lock the full UI"); }
  });
  const pending = handler();
  selected.value = "gguf-next-selection";
  await handler();
  assert.deepEqual(calls, [["llamacpp", "gguf-selected"]]);
  assert.equal(state.loading, false);
  assert.equal(starts, 1);
  answer.resolve({ ok: true, model: "gguf-selected" }); await pending;
  assert.equal(selected.value, "gguf-next-selection");
  assert.equal(state.localModelTest, null);
  assert.equal(state.providerTestResults.llamacpp.ok, true);
  assert.equal(updates, 2);
});

test("remote provider tests save the values currently entered in Settings before testing", async () => {
  let handler!: () => Promise<void>;
  const selected = { value: "claude-sonnet-test" };
  const button = {
    dataset: { providerId: "anthropic" },
    form: { elements: { namedItem: () => selected } },
    addEventListener: (_name: string, fn: typeof handler) => { handler = fn; }
  };
  const form = {};
  const payload = { providers: { anthropic: { apiKey: "draft-key", model: "claude-sonnet-test" } } };
  const saved = {
    providers: [{ id: "anthropic" }], plugins: [], tools: [],
    settings: { providers: { anthropic: { apiKey: "draft-key" } } },
    availableModels: [{ providerId: "anthropic", id: "claude-sonnet-test" }]
  };
  const calls: unknown[][] = [];
  const state: any = {
    loading: false, localModelTest: null, providerTestResults: {},
    bootstrap: { providers: [], plugins: [], tools: [], appSettings: {}, availableModels: [] }
  };

  vm.runInNewContext(fragment('  document.querySelectorAll("[data-action=\'test-provider\']")', '  document.querySelectorAll("[data-chip-kind]")'), {
    state, Error,
    FormData: function FormData() { return form; },
    document: {
      querySelectorAll: () => [button],
      querySelector: (selector: string) => selector === "#app-settings-form" ? form : null
    },
    buildAppSettingsPayload: () => payload,
    api: {
      updateAppSettings: async (next: unknown) => { calls.push(["save", next]); return saved; },
      testProvider: async (...args: unknown[]) => { calls.push(["test", ...args]); return { ok: true }; }
    },
    runAction: async (action: () => Promise<void>) => action()
  });

  await handler();
  assert.deepEqual(calls, [["save", payload], ["test", "anthropic", "claude-sonnet-test"]]);
  assert.deepEqual(state.bootstrap.appSettings, saved.settings);
  assert.deepEqual(state.bootstrap.availableModels, saved.availableModels);
});

test("local runtime phases and technical model references render readable installed model names", () => {
  const runtime: any = { status: "loading", modelId: "gguf-123abc", queueLength: 0, busy: true };
  const state: any = { localModelTest: { model: "gguf-123abc" }, providerTestResults: {}, bootstrap: {
    localModels: { runtime }, allManagedModels: [{ id: "gguf-123abc", providerId: "llamacpp", displayName: "Qwen2.5 1.5B Instruct", quantization: "Q4_K_M" }]
  } };
  const context: any = { state, escapeHtml: (value: unknown) => String(value) };
  vm.runInNewContext(modelLabelHelpers + fragment("function renderLocalModelTestFeedback", "function updateLocalModelTestProgress") + fragment("function renderRuntimeMetaLine", "function renderMessageTools"), context);
  assert.match(context.renderLocalModelTestFeedback(), /Loading model into memory/);
  assert.match(context.renderLocalModelTestFeedback(), /Qwen2\.5 1\.5B Instruct · Q4_K_M/);
  runtime.status = "ready"; runtime.queueLength = 2;
  assert.match(context.renderLocalModelTestFeedback(), /2 waiting/);
  runtime.queueLength = 0;
  assert.match(context.renderLocalModelTestFeedback(), /Generating test response/);
  assert.match(context.renderRuntimeMetaLine("Model", "gguf-123abc"), /Qwen2\.5 1\.5B Instruct · Q4_K_M/);
  assert.equal(context.formatLocalModelReferences("Loading gguf-123abc…"), "Loading Qwen2.5 1.5B Instruct · Q4_K_M…");
  assert.equal(context.getModelDisplayName("openai", "remote-model"), "remote-model");
  assert.equal(context.getModelDisplayName("llamacpp", "gguf-removed"), "gguf-removed");
});
