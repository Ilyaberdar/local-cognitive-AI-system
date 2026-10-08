import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const { JSDOM } = require("jsdom");

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

test("deleted local selections are replaced instead of reappearing as unavailable options", () => {
  const context: any = {state:{bootstrap:{allManagedModels:[{id:"gguf-new",providerId:"llamacpp",displayName:"Installed model"}]}},
    isLocalProvider:()=>true,getProviderConfiguredModel:()=>"gguf-removed",sessionModelLabel:()=>"Model",escapeHtml:String,escapeAttr:String,
    option:(id:string,selected:string,label:string)=>`<option value="${id}" ${id===selected?"selected":""}>${label}</option>`};
  vm.runInNewContext(modelLabelHelpers + fragment("function renderSessionModelControl", "function renderCodeAgentCard"),context);
  const html=context.renderSessionModelControl("main","llamacpp","gguf-removed",["gguf-new"],"models");
  assert.doesNotMatch(html,/gguf-removed|Saved model is unavailable/); assert.match(html,/gguf-new.*selected/);
});

test("missing files and stale suggested IDs never become local options, while unloaded installed models remain selectable", () => {
  const context: any = { state: { bootstrap: { allManagedModels: [
    { id: "missing", providerId: "llamacpp", filesAvailable: false },
    { id: "installed", providerId: "llamacpp", loaded: false, displayName: "Installed" }
  ] } }, isLocalProvider: () => true, getProviderConfiguredModel: () => "missing", sessionModelLabel: () => "Model", escapeHtml: String, escapeAttr: String,
    option: (id: string, current: string, label: string) => `<option value="${id}" ${id === current ? "selected" : ""}>${label}</option>` };
  vm.runInNewContext(modelLabelHelpers + fragment("function renderSessionModelControl", "function renderCodeAgentCard"), context);
  const html = context.renderSessionModelControl("defaultModel", "llamacpp", "missing", ["missing", "installed", "deleted"], "models");
  assert.doesNotMatch(html, /missing|deleted|unavailable/); assert.match(html, /value="installed" selected/);
  context.state.bootstrap.allManagedModels = [];
  const empty = context.renderSessionModelControl("defaultModel", "llamacpp", "missing", [], "models");
  assert.doesNotMatch(empty, /missing|unavailable/); assert.match(empty, /Download a model/);
});

test("model errors render a concise escaped summary and copy the complete diagnostic", async () => {
  const manager = fs.readFileSync("public/assets/model-manager.js","utf8");
  const helpers=manager.slice(manager.indexOf("  function errorSummary("),manager.indexOf("  function renderContext",manager.indexOf("  function errorSummary(")));
  let copied="";
  const context: any={escape:(value:string)=>value.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"),
    navigator:{clipboard:{writeText:async(text:string)=>{copied=text;}}},notify:()=>{}};
  vm.runInNewContext(helpers+manager.slice(manager.indexOf("  async function perform("),manager.indexOf("  function bind(")),context);
  const error='Local runtime exited (1).\ntensor "output_norm.weight" has offset 1, expected 2\n'+"diagnostic\n".repeat(500);
  const html=context.renderModelError(error);
  assert.match(html,/Copy full error/); assert.match(html,/Model format is incompatible/);
  const visible=html.replace(/data-mm-id="[^"]*"/,""); assert.ok(visible.length<500);
  await context.perform("copy-error",error); assert.equal(copied,error);
});

test("local selectors show loaded models first without changing the configured selection", () => {
  const context: any = { state: { bootstrap: { allManagedModels: [
    { id: "gguf-small", providerId: "llamacpp", displayName: "Small", state: "unloaded" },
    { id: "gguf-qwen", providerId: "llamacpp", displayName: "Qwen 27B", loaded: true, state: "ready" }
  ], loadedModels: [] } },
    isLocalProvider: () => true, getProviderConfiguredModel: () => "", sessionModelLabel: () => "Model",
    escapeHtml: String, escapeAttr: String,
    option: (value: string, current: string, label: string) => `<option value="${value}" ${value === current ? "selected" : ""}>${label}</option>`
  };
  vm.runInNewContext(modelLabelHelpers + fragment("function renderSessionModelControl", "function renderCodeAgentCard"), context);
  const render = (model: string) => context.renderSessionModelControl("codeAgentModel:0", "llamacpp", model, ["gguf-small", "gguf-qwen"], "models");
  let html = render("gguf-small");
  assert.ok(html.indexOf('value="gguf-qwen"') < html.indexOf('value="gguf-small"'));
  assert.match(html, /value="gguf-small" selected/);
  assert.match(html, /Qwen 27B · Loaded<\/option>/);
  assert.match(html, /<select name="codeAgentModel:0"/);
  assert.doesNotMatch(html, /<details|<summary|role="listbox"|data-picker-model|<select hidden/);
  assert.match(html, /data-model-loaded hidden/);
  html = render("gguf-qwen");
  assert.match(html, /data-model-loaded >Loaded/);
  context.state.bootstrap.allManagedModels[1].loaded = false;
  context.state.bootstrap.allManagedModels[1].state = "unloaded";
  html = render("gguf-qwen");
  assert.match(html, /data-model-loaded hidden/);
  assert.doesNotMatch(html, /Qwen 27B · Loaded/);
});

test("all session model providers keep native selects, with plain green loaded status for local runtimes", () => {
  const context: any = { state: { bootstrap: { allManagedModels: [
    { id: "gguf-ready", providerId: "llamacpp", displayName: "Installed model", loaded: true },
    { id: "studio", providerId: "lmstudio", loaded: true },
    { id: "ollama-model", providerId: "ollama", loaded: true }
  ] } }, isLocalProvider: (id: string) => ["llamacpp", "lmstudio", "ollama"].includes(id),
    getProviderConfiguredModel: () => "", sessionModelLabel: () => "Model", escapeHtml: String, escapeAttr: String,
    option: (id: string, selected: string, label: string) => `<option value="${id}" ${id === selected ? "selected" : ""}>${label}</option>` };
  vm.runInNewContext(modelLabelHelpers + fragment("function renderSessionModelControl", "function renderCodeAgentCard"), context);
  const dom = new JSDOM("<form></form>");
  const form = dom.window.document.querySelector("form");
  for (const [provider, id] of [["llamacpp", "gguf-ready"], ["lmstudio", "studio"], ["ollama", "ollama-model"], ["openai", "gpt-model"], ["anthropic", "claude"], ["gemini", "gemini-model"]]) {
    form.innerHTML = context.renderSessionModelControl("defaultModel", provider, id, [id], "models");
    const select = form.querySelector("select");
    assert.ok(select, `${provider} must use the original native select`);
    assert.equal(select.hidden, false);
    assert.equal(select.value, id);
    assert.equal(form.querySelector("details, summary, [role=listbox]"), null);
    assert.equal(new dom.window.FormData(form).get("defaultModel"), id);
    if (context.isLocalProvider(provider)) {
      const badge = form.querySelector("[data-model-loaded]");
      assert.equal(badge.hidden, false);
      assert.equal(badge.className, "model-loaded-badge");
    }
  }
  const css = fs.readFileSync("public/assets/model-manager.css", "utf8");
  assert.match(css, /\.model-loaded-badge \{[^}]*color: var\(--success[^}]*border: 0; background: none;/);
  assert.doesNotMatch(css, /\.local-model-picker|\.local-model-options/);
  dom.window.close();
});

test("native loaded indicators update without replacing the select, and remove deleted options", () => {
  const context: any = { state: { bootstrap: { allManagedModels: [
    { id: "gguf-one", providerId: "llamacpp", displayName: "One", loaded: true },
    { id: "gguf-two", providerId: "llamacpp", displayName: "Two", loaded: false }
  ] } }, isLocalProvider: () => true, getProviderConfiguredModel: () => "", sessionModelLabel: () => "Model", escapeHtml: String, escapeAttr: String,
    option: (id: string, selected: string, label: string) => `<option value="${id}" ${id === selected ? "selected" : ""}>${label}</option>` };
  vm.runInNewContext(fragment("function getModelOptions", "function getLoadedModelOptions") + fragment("function renderSessionModelControl", "function renderCodeAgentCard"), context);
  const dom = new JSDOM(`<form>${context.renderSessionModelControl("defaultModel", "llamacpp", "gguf-one", ["gguf-one", "gguf-two"], "models")}</form>`);
  context.document = dom.window.document;
  const select = context.document.querySelector("select");
  context.state.bootstrap.allManagedModels[0].loaded = false;
  context.updateLoadedModelIndicators();
  assert.equal(context.document.querySelector("select"), select);
  assert.equal(context.document.querySelector("[data-model-loaded]").hidden, true);
  assert.doesNotMatch(select.textContent, /Loaded/);
  context.state.bootstrap.allManagedModels[1].loaded = true;
  select.value = "gguf-two";
  context.updateLoadedModelIndicators();
  assert.equal(context.document.querySelector("[data-model-loaded]").hidden, false);
  assert.match(select.selectedOptions[0].textContent, /Two · Loaded/);
  context.state.bootstrap.allManagedModels.pop();
  context.updateLoadedModelIndicators();
  assert.equal(context.document.querySelector("select").value, "gguf-one");
  assert.doesNotMatch(context.document.body.innerHTML, /gguf-two|unavailable/);
  dom.window.close();
});

test("local context save preserves a failed draft and reports actual runtime context separately", async () => {
  const managerSource = fs.readFileSync("public/assets/model-manager.js", "utf8");
  const from = managerSource.indexOf("  function renderRuntime()");
  const until = managerSource.indexOf("  function renderDownload(", from);
  const state: any = { contextDraft: "32768", contextSaving: false, contextError: "", contextSaved: false, catalog: [],
    runtime: { status: "ready", contextSize: 32768, effectiveContextSize: 8192 } };
  const settings = { localModels: { contextSize: 4096 } };
  let refreshes = 0; let fail = true;
  const context: any = { state, escape: String, bytes: String, asArray: (value: unknown) => Array.isArray(value) ? value : [], variantsOf: () => [], models: () => [],
    getContext: () => ({ settings }), repaint() {}, refresh: async () => { refreshes++; },
    onContextChange: async (size: number) => { if (fail) throw new Error("Runtime is busy"); settings.localModels.contextSize = size; }
  };
  vm.runInNewContext(managerSource.slice(from, until), context);
  await context.saveContext();
  assert.equal(state.contextDraft, "32768");
  assert.equal(state.contextSaved, false);
  assert.match(context.renderContextControl(), /Runtime is busy/);
  fail = false;
  await context.saveContext();
  assert.equal(settings.localModels.contextSize, 32768);
  assert.equal(state.contextDraft, null);
  assert.equal(refreshes, 1);
  assert.match(context.renderContextControl(), /value="32768"/);
  assert.match(context.renderRuntime(), /Active context: <strong>8,192 tokens/);
  state.contextDraft = "invalid";
  await context.saveContext();
  assert.match(state.contextError, /whole number/);
  assert.equal(refreshes, 1);
});

test("model settings tabs expose one runtime field each and save independently", async () => {
  const managerSource = fs.readFileSync("public/assets/model-manager.js", "utf8")
    .replace(/^import .*\n/, "").replace("export function", "function")
    .replace("return { render, bind, start, refresh, repaint, updateLiveView, dispose()", "return { test: { state, renderAdvancedSettings, saveAdvancedSettings }, render, bind, start, refresh, repaint, updateLiveView, dispose()");
  const settings = { localModels: { contextSize: 32768, gpuLayers: 99, memoryLimitPercent: 75, loadTimeoutMs: 300000, generationTimeoutMs: 600000 } };
  const writes: any[] = [];
  const context: any = {
    icon: () => "", window: { setTimeout: () => 1, clearTimeout() {} }, setTimeout,
    getContext: () => ({ settings }), onContextChange: async () => {}, onLibraryChange() {}, notify() {}, isVisible: () => false,
    onLocalSettingsChange: async (patch: Record<string, number>) => { writes.push(patch); Object.assign(settings.localModels, patch); }
  };
  vm.runInNewContext(managerSource, context);
  const manager = context.createModelManager({ request: async () => ({ models: [], downloads: [], runtime: {} }), ...context });
  const state = manager.test.state;
  state.advancedDrafts = { gpuLayers: "64" };
  assert.match(manager.test.renderAdvancedSettings("gpuLayers"), /GPU layers/);
  assert.doesNotMatch(manager.test.renderAdvancedSettings("gpuLayers"), /Memory warning threshold/);
  assert.match(manager.test.renderAdvancedSettings("memoryLimitPercent"), /Memory warning threshold/);
  assert.match(manager.test.renderAdvancedSettings("loadTimeoutMs"), /Load timeout/);
  assert.match(manager.test.renderAdvancedSettings("generationTimeoutMs"), /Generation timeout/);
  await manager.test.saveAdvancedSettings("gpuLayers");
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ gpuLayers: 64 }]);
  assert.equal(settings.localModels.gpuLayers, 64);
  assert.equal(state.advancedSaved, true);
  state.advancedDrafts = { loadTimeoutMs: "invalid" };
  await manager.test.saveAdvancedSettings("loadTimeoutMs");
  assert.match(state.advancedError, /Load timeout/);
  assert.equal(writes.length, 1);
});

test("local generation controls use neutral copy and keep the storage action beside its path", () => {
  const settingsShell = fs.readFileSync("public/assets/settings-shell.js", "utf8");
  const manager = fs.readFileSync("public/assets/model-manager.js", "utf8");
  const styles = fs.readFileSync("public/assets/settings-shell.css", "utf8");
  assert.match(settingsShell, /class="local-generation-card"/);
  assert.match(settingsShell, /class="settings-directory-control"/);
  assert.match(styles, /\.settings-directory-control \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(styles, /#settings-root :is\(a, button, input, select, textarea, summary\):focus-visible \{ outline: none !important;/);
  assert.match(styles, /html\[data-theme="light"\] #settings-root \.primary-button,/);
  assert.match(styles, /background: #fff !important;/);
  assert.doesNotMatch(settingsShell, /llama\.cpp/i);
  assert.doesNotMatch(manager, /llama\.cpp/i);
});

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
  let deletionHeaders: Record<string, string> | undefined;
  context.fetch = async (_url: string, options: { headers: Record<string, string> }) => {
    deletionHeaders = options.headers;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await context.request("/local/models/qwen-small", { method: "DELETE", timeoutMs: 0 });
  assert.equal(deletionHeaders?.["X-Local-Cognitive"], "1");
  assert.equal(deletionHeaders?.["Content-Type"], "application/json");
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
  assert.equal(context.getModelDisplayName("llamacpp", "gguf-removed"), "Select model");
});

test("the runtime strip explains a CPU fallback without rendering the reason as markup", () => {
  const managerSource = fs.readFileSync("public/assets/model-manager.js", "utf8");
  const from = managerSource.indexOf("  function renderRuntime()");
  const until = managerSource.indexOf("  function renderDownload(", from);
  const escapeSource = /const escape = .*;/.exec(managerSource)![0];
  const state: any = { catalog: [], runtime: { status: "stopped", backend: "CPU", fallbackReason: "No NVIDIA GPU <img src=x onerror=alert(1)> was found." } };
  const context: any = { state, bytes: String, variantsOf: () => [], models: () => [], getContext: () => ({}) };
  vm.runInNewContext(`${escapeSource}\n${managerSource.slice(from, until)}`, context);
  const html = context.renderRuntime();
  assert.match(html, /CPU fallback/);
  assert.match(html, /No NVIDIA GPU &lt;img src=x onerror=alert\(1\)&gt; was found\./);
  assert.doesNotMatch(html, /<img/);
  state.runtime = { status: "stopped", backend: "CUDA" };
  assert.doesNotMatch(context.renderRuntime(), /CPU fallback/);
});
