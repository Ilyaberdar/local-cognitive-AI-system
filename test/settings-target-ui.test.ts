import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { hostSettingsView } from "../src/runtime/settingsDto";
import { bootApp, flush, SESSION_ID, type Harness } from "./fixtures/appHarness";

const HOST = "6f1c2c3e-58a4-4c55-9a0e-3c7f5b1d2e90";
const T0 = "2026-10-01T10:00:00.000Z";
const settle = async () => { await flush(30); await new Promise(resolve => setTimeout(resolve, 150)); await flush(10); };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const merge = (target: any, patch: any): any => {
  for (const [key, value] of Object.entries(patch)) {
    target[key] = value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object" ? merge(target[key], value) : value;
  }
  return target;
};

/** This computer's settings behind a fake local API. */
export function localSettings() {
  const settings: any = {
    ui: { theme: "dark", animations: false, language: "auto", outputStyle: "balanced", mode: "auto" },
    llm: { defaultProvider: "ollama" },
    providers: {
      ollama: { enabled: true, baseUrl: "http://127.0.0.1:11434", model: "llama3.2", timeoutMs: 60000 },
      openai: { enabled: true, baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini", timeoutMs: 60000 },
      llamacpp: { enabled: true, model: "" }
    },
    localModels: { modelsDir: "/Users/me/models", contextSize: 4096, gpuLayers: "auto", memoryLimitPercent: 75, loadTimeoutMs: 300000, generationTimeoutMs: 600000, generation: { preset: "server" } },
    agentLimits: { maxSteps: 30, advisorMaxSteps: 10, maxTotalSteps: 0, maxActiveMs: 0 },
    memory: { adapter: "local-json", topK: 8, baseDir: "/Users/me/memory", worldPartition: { strategy: "auto", activationThreshold: 100, chunkCapacity: 512, initialRadius: 1,
      maxRadius: 4, fallbackToGlobalSearch: true, migrateLegacyOnStart: false, crossSessionRecall: false }, openMemory: { enabled: false, dbPath: "" } },
    filesystem: { outputDir: "/Users/me/out", accessMode: "restricted", allowedDirectories: [] },
    mcp: { server: { enabled: false, defaultSessionId: "" }, client: { servers: {}, bindings: {} } },
    profile: { displayName: "Ilya" }
  };
  const bootstrap = () => copy({
    providers: [{ id: "ollama", name: "Ollama", capabilities: { local: true } }, { id: "openai", name: "OpenAI", capabilities: { local: false } }],
    tools: [], plugins: [], pluginStatuses: [], tasks: [], schedules: [], workflows: [], workflowRuns: [], projects: [], appSettings: settings,
    sessions: [{ id: SESSION_ID, title: "First chat", updatedAt: T0 }], availableModels: [], loadedModels: [{ providerId: "ollama", id: "llama3.2" }],
    allManagedModels: [], localModels: { runtime: { status: "stopped" } }, systemMetrics: {}
  });
  const route = (method: string, url: string, body?: string): unknown => {
    if (url === "/dashboard/bootstrap") return bootstrap();
    if (url === "/app/settings" && method === "PUT") {
      merge(settings, JSON.parse(body!));
      return copy({ settings, providers: [], plugins: [], tools: [], availableModels: [] });
    }
    if (url === "/providers/openai/test") return { ok: true, providerId: "openai", model: "gpt-4o-mini", message: "ok" };
    if (url === "/mcp/clients") return { connections: [], tools: [] };
    if (url === "/integrations") return { catalog: [], connections: [], providers: [], setup: {} };
    if (url === "/app/info") return { name: "Local Cognitive AI System", version: "0.1.0" };
    return undefined;
  };
  return { route, bootstrap, settings };
}

const inRoot = (app: Harness, selector: string) => {
  const element = app.document.querySelector(`#settings-root ${selector}`);
  assert.ok(element, `missing ${selector}`);
  return element;
};
const change = (app: Harness, selector: string, value: string, type = "change") => {
  const element = inRoot(app, selector);
  element.value = value;
  element.dispatchEvent(new app.window.Event(type, { bubbles: true }));
};
const submitSettings = (app: Harness) => inRoot(app, "#settings-entity-form").dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
const open = (app: Harness, route: string) => { app.window.location.hash = `#/settings/${route}`; };

/** Requests in order, one marker per user action. */
async function walkSettings(app: Harness) {
  const trace = [...app.requests];
  const step = async (label: string, action: () => unknown) => {
    const before = app.requests.length;
    await action();
    await settle();
    trace.push(`--- ${label}`, ...app.requests.slice(before));
  };
  await step("general", () => open(app, "general"));
  await step("language", () => change(app, "#setting-ui-language", "en"));
  await step("appearance theme", async () => { open(app, "appearance"); await settle(); inRoot(app, '[data-appearance-theme="light"]').click(); });
  await step("openai key", async () => { open(app, "providers/openai"); await settle(); change(app, "#setting-providers-openai-apiKey", "sk-test-key-123", "input"); submitSettings(app); });
  await step("openai test", () => inRoot(app, "[data-test]").click());
  await step("remove key", () => { inRoot(app, '[data-clear="providers.openai.apiKey"]').click(); submitSettings(app); });
  await step("runtime context", async () => { open(app, "runtime"); await settle(); change(app, "#setting-localModels-contextSize", "8192", "input"); submitSettings(app); });
  await step("agents", async () => { open(app, "agents"); await settle(); change(app, "#setting-agentLimits-maxSteps", "40", "input"); submitSettings(app); });
  await step("memory", async () => { open(app, "memory"); await settle(); change(app, "#setting-memory-topK", "12", "input"); submitSettings(app); });
  await step("data", async () => { open(app, "data"); await settle(); change(app, "#setting-filesystem-accessMode", "full", "input"); submitSettings(app); });
  await step("mcp", () => open(app, "mcp"));
  await step("plugins", () => open(app, "plugins"));
  await step("profile", async () => {
    open(app, "profile"); await settle();
    inRoot(app, "#local-profile-name").value = "Ilya B";
    inRoot(app, "#settings-profile-form").dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await step("about", () => open(app, "about"));
  await step("back to chat", () => { app.window.location.hash = "#/chat"; });
  return trace;
}

/** This computer's Settings, recorded before they could show a server. */
const LOCAL_SETTINGS_TRACE = [
  "GET /dashboard/bootstrap", "GET /integrations/available", `GET /sessions/${SESSION_ID}/messages`, `GET /sessions/${SESSION_ID}/settings`,
  "GET /local/runtime", "GET /local/downloads", "EVENTSOURCE /local/events",
  "--- general",
  "--- language", 'PUT /app/settings {"ui":{"language":"en"}}',
  "--- appearance theme", 'PUT /app/settings {"ui":{"theme":"light"}}',
  "--- openai key", 'PUT /app/settings {"providers":{"openai":{"apiKey":"sk-test-key-123"}}}',
  "--- openai test", 'POST /providers/openai/test {"model":"gpt-4o-mini"}',
  "--- remove key", 'PUT /app/settings {"providers":{"openai":{"apiKey":""}}}',
  "--- runtime context", 'PUT /app/settings {"localModels":{"contextSize":8192}}',
  "--- agents", 'PUT /app/settings {"agentLimits":{"maxSteps":40}}',
  "--- memory", 'PUT /app/settings {"memory":{"topK":12}}',
  "--- data", 'PUT /app/settings {"filesystem":{"accessMode":"full"}}',
  "--- mcp", "GET /mcp/clients",
  "--- plugins", "GET /integrations",
  "--- profile", 'PUT /app/settings {"profile":{"displayName":"Ilya B"}}',
  "--- about", "GET /app/info",
  "--- back to chat", "GET /integrations/available"
];

/** A paired server that is never selected here. */
const pairedBridge = () => {
  const ok = (value: unknown) => ({ ok: true, value });
  const status = { state: "online", hostId: HOST, hostName: "fedora", serverVersion: "0.2.0", capabilities: ["chat.runs.start", "settings.get"] };
  return { status: async () => ok(status), hosts: async () => ok([{ hostId: HOST, name: "fedora", online: true, appVersion: "0.2.0", paired: true, devices: [] }]),
    connect: async () => ok(status), disconnect: async () => ok({ state: "idle" }), hostStatus: async () => ok({}), onChange() {},
    runtime: { request: async () => ok({}), send: async () => ok({}), subscribe: async () => ok(undefined), unsubscribe: async () => ok(undefined),
      watch: async () => ok(undefined), unwatch: async () => ok(undefined), onEvent() {} } };
};

test("this computer's Settings make exactly the same requests with or without a paired server", async t => {
  const plain = await bootApp(localSettings());
  t.after(() => plain.close());
  assert.deepEqual(await walkSettings(plain), LOCAL_SETTINGS_TRACE);

  const paired = await bootApp({ ...localSettings(), remote: { bridge: pairedBridge() } });
  t.after(() => paired.close());
  assert.deepEqual(await walkSettings(paired), LOCAL_SETTINGS_TRACE);
  assert.deepEqual(paired.bridgeCalls.filter(call => call.op.startsWith("runtime.")), [], "nothing went to the server");
});

/** fedora's settings behind the host operations, as a device sees them (the real view). */
function fedoraWithSettings({ name = "fedora", capabilities = ["chat.runs.start", "settings.get", "settings.update", "providers.test"] } = {}) {
  let status: Record<string, unknown> = { state: "online", hostId: HOST, hostName: name, serverVersion: "0.2.0", capabilities };
  const statusListeners: Array<(value: unknown) => void> = [];
  const raw: any = {
    ui: { language: "ru", outputStyle: "detailed", mode: "code", theme: "midnight" },
    llm: { defaultProvider: "llamacpp" },
    providers: {
      llamacpp: { enabled: true, model: "qwen-14b" },
      openai: { enabled: true, baseUrl: "https://user:pass@api.openai.com/v1?token=abc", apiKey: "", model: "gpt-4o-mini", timeoutMs: 60000 },
      anthropic: { enabled: false, baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-saved-on-fedora-123", model: "claude", timeoutMs: 60000, version: "2023-06-01", maxTokens: 4096 }
    },
    localModels: { modelsDir: "/srv/lc/models", contextSize: 16384, gpuLayers: "auto", memoryLimitPercent: 80, loadTimeoutMs: 300000, generationTimeoutMs: 600000, generation: { preset: "server" } },
    agentLimits: { maxSteps: 50, advisorMaxSteps: 10, maxTotalSteps: 0, maxActiveMs: 0 },
    memory: { adapter: "world-partition", topK: 6, baseDir: "/srv/lc/memory", worldPartition: { strategy: "auto", activationThreshold: 100, chunkCapacity: 512, initialRadius: 1,
      maxRadius: 4, fallbackToGlobalSearch: true, migrateLegacyOnStart: false, crossSessionRecall: true }, openMemory: { enabled: false, dbPath: "/srv/lc/om.db" } },
    filesystem: { outputDir: "/srv/lc/output", accessMode: "restricted", allowedDirectories: ["/srv/lc/a", "/srv/lc/b"] },
    mcp: { server: { enabled: false }, client: { servers: {}, bindings: {} } }
  };
  const ok = (value: unknown) => ({ ok: true, value });
  const gate = { held: false, waiting: [] as Array<() => void> };
  const handlers: Record<string, (payload: any) => unknown> = {
    "sessions.list": () => [],
    "models.available": () => ({ providers: [], availableModels: [{ providerId: "openai", id: "gpt-4.1" }], loadedModels: [],
      allManagedModels: [{ providerId: "llamacpp", id: "qwen-14b", libraryId: "qwen-14b", displayName: "Qwen 14B", loaded: true }], appSettings: { llm: {}, providers: {} } }),
    "settings.get": () => ({ settings: hostSettingsView(raw), runtimeStatus: "running" }),
    "settings.update": async payload => {
      if (gate.held) await new Promise<void>(resolve => gate.waiting.push(resolve));
      const patch = copy(payload);
      for (const provider of Object.values<any>(patch.providers ?? {})) if (provider.apiKey) provider.apiKey = provider.apiKey.set ?? "";
      merge(raw, patch);
      return { settings: hostSettingsView(raw) };
    },
    "providers.test": payload => ({ ok: true, providerId: payload.providerId, model: payload.model, message: `Provider responded successfully with model ${payload.model}.` })
  };
  const bridge = {
    status: async () => ok(status),
    hosts: async () => ok([{ hostId: HOST, name, online: true, appVersion: "0.2.0", paired: true, devices: [] }]),
    connect: async () => ok(status), disconnect: async () => ok({ state: "idle" }), hostStatus: async () => ok({}),
    onChange: (listener: (value: unknown) => void) => { statusListeners.push(listener); return () => undefined; },
    runtime: {
      request: async (op: string, payload: unknown) => handlers[op] ? ok(await handlers[op]!(payload)) : { ok: false, error: { code: "unknown_operation", message: `No ${op} here.` } },
      send: async (op: string) => ({ ok: false, error: { code: "unknown_operation", message: `No ${op} here.` } }),
      subscribe: async () => ok(undefined), unsubscribe: async () => ok(undefined), watch: async () => ok(undefined), unwatch: async () => ok(undefined), onEvent() {}
    }
  };
  return { bridge, raw,
    hold() { gate.held = true; },
    release() { gate.held = false; for (const resolve of gate.waiting.splice(0)) resolve(); },
    setStatus(next: Record<string, unknown>, notify = true) { status = { ...status, ...next }; if (notify) statusListeners.forEach(listener => listener(status)); } };
}

const text = (app: Harness, selector: string) => String(app.document.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
/** Bridge calls as [operation, payload, server], plain values of the test's realm. */
const runtimeCalls = (app: Harness, from = 0) => copy(app.bridgeCalls.slice(from).filter(call => /^runtime\.(request|send)$/.test(call.op)).map(call => call.payload)) as unknown[][];
const updates = (app: Harness, from = 0) => runtimeCalls(app, from).filter(call => call[0] === "settings.update").map(call => call[1]);
async function selectFedora(app: Harness) {
  const button = app.document.querySelector(`[data-chat-target="${HOST}"]`);
  assert.ok(button, "the switch offers fedora");
  button.click();
  await settle();
}

test("with fedora selected, host pages show and change fedora's settings; appearance and profile stay on this computer", async t => {
  const local = localSettings();
  const fedora = fedoraWithSettings();
  const app = await bootApp({ ...local, remote: { bridge: fedora.bridge } });
  t.after(() => app.close());
  await selectFedora(app);
  const localBefore = app.requests.length, callsBefore = app.bridgeCalls.length;

  open(app, "general"); await settle();
  assert.equal(inRoot(app, "#setting-ui-language").value, "ru", "fedora's chat defaults, not this computer's");
  assert.match(text(app, ".settings-target-note"), /Defaults for new chats on fedora/);
  assert.equal(text(app, 'a[href="#/settings/general"] .settings-nav-scope'), "fedora");
  assert.equal(app.document.querySelector('#settings-root a[href="#/settings/appearance"] .settings-nav-scope'), null);
  change(app, "#setting-ui-language", "en"); await settle();

  open(app, "providers/openai"); await settle();
  assert.equal(app.document.querySelector('#settings-root [name="providers.openai.baseUrl"]'), null, "the address is set on fedora");
  assert.equal(text(app, '[data-setting="providers.openai.baseUrl"] .settings-control'), "https://api.openai.com · set on fedora");
  assert.equal(inRoot(app, "#setting-providers-openai-apiKey").placeholder, "Enter API key");
  change(app, "#setting-providers-openai-apiKey", "sk-server-key-123", "input"); submitSettings(app); await settle();
  assert.equal(fedora.raw.providers.openai.apiKey, "sk-server-key-123");
  inRoot(app, "[data-test]").click(); await settle();
  assert.match(text(app, ".settings-test-result"), /Test succeeded[\s\S]*gpt-4o-mini/);
  open(app, "providers"); await settle();
  open(app, "providers/openai"); await settle();
  assert.equal(inRoot(app, "#setting-providers-openai-apiKey").placeholder, "Saved key · leave blank to keep");
  inRoot(app, '[data-clear="providers.openai.apiKey"]').click(); submitSettings(app); await settle();
  assert.equal(fedora.raw.providers.openai.apiKey, "");
  open(app, "providers/anthropic"); await settle();
  assert.equal(inRoot(app, "#setting-providers-anthropic-apiKey").placeholder, "Saved key · leave blank to keep");
  open(app, "providers/llamacpp"); await settle();
  assert.equal(app.document.querySelector("#settings-root [data-test]"), null, "fedora's own models are tested from Models");
  assert.match(text(app, "#setting-providers-llamacpp-model"), /Qwen 14B · Loaded/);

  open(app, "runtime"); await settle();
  assert.match(text(app, ".settings-runtime-overview"), /Runtime status\s*running/);
  assert.equal(text(app, '[data-setting="localModels.modelsDir"] .settings-control'), "Set on fedora");
  change(app, "#setting-localModels-contextSize", "8192", "input"); submitSettings(app); await settle();
  open(app, "memory"); await settle();
  assert.equal(text(app, '[data-setting="memory.baseDir"] .settings-control'), "Set on fedora");
  change(app, "#setting-memory-topK", "12", "input"); submitSettings(app); await settle();
  open(app, "data"); await settle();
  assert.equal(app.document.querySelector("#settings-entity-form, #settings-root [data-open-data]"), null, "nothing on Data can be changed from here");
  assert.match(text(app, ".settings-content"), /Restricted · set on fedora[\s\S]*2 folders · set on fedora/);
  for (const route of ["mcp", "plugins", "connections"]) {
    open(app, route); await settle();
    assert.match(text(app, ".settings-content"), /Plugins and MCP on fedora come in a later update/);
    assert.ok(app.document.querySelector('#settings-root [data-server-action="use-local"]'));
  }
  open(app, "about"); await settle();
  assert.match(text(app, ".settings-content"), /Selected server\s*fedora · 0\.2\.0/);
  open(app, "appearance"); await settle();
  assert.match(text(app, ".settings-target-note"), /kept on this device\. fedora has its own/);
  inRoot(app, '[data-appearance-theme="light"]').click(); await settle();
  open(app, "profile"); await settle();
  inRoot(app, "#local-profile-name").value = "Ilya B";
  inRoot(app, "#settings-profile-form").dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();

  assert.deepEqual(updates(app, callsBefore), [
    { ui: { language: "en" } }, { providers: { openai: { apiKey: { set: "sk-server-key-123" } } } }, { providers: { openai: { apiKey: { clear: true } } } },
    { localModels: { contextSize: 8192 } }, { memory: { topK: 12 } }
  ]);
  assert.deepEqual(runtimeCalls(app, callsBefore).filter(call => call[0] === "providers.test").map(call => call[1]), [{ providerId: "openai", model: "gpt-4o-mini" }]);
  assert.ok(runtimeCalls(app, callsBefore).every(call => call.at(-1) === HOST), "every call names fedora");
  assert.deepEqual(app.requests.slice(localBefore).filter(entry => /^(PUT|POST) |\/mcp\/|GET \/integrations$/.test(entry)),
    ['PUT /app/settings {"ui":{"theme":"light"}}', 'PUT /app/settings {"profile":{"displayName":"Ilya B"}}'], "only appearance and profile went to this computer");
  assert.deepEqual([local.settings.ui.language, local.settings.localModels.contextSize, local.settings.memory.topK], ["auto", 4096, 8], "this computer's values are untouched");
  assert.equal(fedora.raw.ui.theme, "midnight", "fedora's appearance is not changed from here");
  assert.equal(app.document.body.innerHTML.includes("/srv/lc"), false, "no folder of fedora reaches the page");
});

test("offline, fedora's settings stay readable and nothing is sent; Use This computer shows this computer's pages", async t => {
  const local = localSettings();
  const fedora = fedoraWithSettings();
  const app = await bootApp({ ...local, remote: { bridge: fedora.bridge } });
  t.after(() => app.close());
  await selectFedora(app);
  open(app, "general"); await settle();
  fedora.setStatus({ state: "reconnecting" }); await settle();
  assert.ok(app.document.querySelector("#settings-root .settings-content.is-offline"));
  assert.match(text(app, ".settings-target-note"), /fedora is not connected\. These are its last known settings/);
  assert.equal(inRoot(app, "#setting-ui-language").disabled, true);
  assert.equal(inRoot(app, "#setting-ui-language").value, "ru");
  const callsBefore = app.bridgeCalls.length;
  inRoot(app, "#setting-ui-language").disabled = false;
  change(app, "#setting-ui-language", "en"); await settle();
  assert.deepEqual(updates(app, callsBefore), [], "nothing is sent while offline");
  assert.match(text(app, ".settings-save-status"), /Not saved\. fedora is not connected/);

  fedora.setStatus({ state: "online" }); await settle();
  assert.equal(app.document.querySelector("#settings-root .settings-content.is-offline"), null);
  // The connection drops while a save is on its way: the page stays disabled when it finishes.
  open(app, "agents"); await settle();
  fedora.hold();
  change(app, "#setting-agentLimits-maxSteps", "45", "input"); submitSettings(app); await settle();
  fedora.setStatus({ state: "reconnecting" }); await settle();
  fedora.release(); await settle();
  assert.equal(fedora.raw.agentLimits.maxSteps, 45);
  assert.equal(inRoot(app, '#settings-entity-form button[type="submit"]').disabled, true, "nothing can be sent while offline");
  fedora.setStatus({ state: "online" }); await settle();
  open(app, "mcp"); await settle();
  const localBefore = app.requests.length;
  inRoot(app, '[data-server-action="use-local"]').click(); await settle();
  assert.equal(app.window.location.hash, "#/settings/mcp", "Settings stay open");
  assert.ok(app.requests.slice(localBefore).includes("GET /mcp/clients"), "this computer's MCP servers are shown");
  assert.equal(app.document.querySelector("#settings-root .settings-nav-scope"), null);
  open(app, "general"); await settle();
  assert.equal(inRoot(app, "#setting-ui-language").value, "auto");
});

test("fedora not connected, or too old for its settings: the page says so and offers what can be done", async t => {
  const fedora = fedoraWithSettings();
  const app = await bootApp({ ...localSettings(), remote: { bridge: fedora.bridge } });
  t.after(() => app.close());
  await selectFedora(app);
  fedora.setStatus({ state: "reconnecting" }); await settle();
  open(app, "providers"); await settle();
  assert.match(text(app, ".settings-content"), /fedora is not connected[\s\S]*Its settings appear once it reconnects/);
  assert.equal(runtimeCalls(app).filter(call => call[0] === "settings.get").length, 0);
  // Back by the time "Try again" reconnects.
  fedora.setStatus({ state: "online" }, false);
  inRoot(app, '[data-server-action="retry"]').click(); await settle();
  assert.equal(inRoot(app, "#setting-llm-defaultProvider").value, "llamacpp");

  const older = fedoraWithSettings({ capabilities: ["chat.runs.start"] });
  const old = await bootApp({ ...localSettings(), remote: { bridge: older.bridge } });
  t.after(() => old.close());
  await selectFedora(old);
  open(old, "general"); await settle();
  assert.match(text(old, ".settings-content"), /Update Local Cognitive on fedora/);
  assert.equal(runtimeCalls(old).filter(call => call[0] === "settings.get").length, 0, "an older server is not asked");
  open(old, "appearance"); await settle();
  assert.ok(old.document.querySelector('#settings-root [data-appearance-theme="light"]'), "this computer's pages still work");
});

test("a server's name and values are shown as text in Settings", async t => {
  const name = '<img src=x onerror="window.injected=1">';
  const fedora = fedoraWithSettings({ name });
  fedora.raw.localModels.generation = { preset: "custom", temperature: '"><img src=x id=injected-value>', seed: '"><img src=x id=injected-seed>' };
  const app = await bootApp({ ...localSettings(), remote: { bridge: fedora.bridge } });
  t.after(() => app.close());
  await selectFedora(app);
  for (const route of ["general", "providers", "providers/llamacpp", "providers/openai", "runtime", "memory", "data", "mcp", "appearance", "about"]) {
    open(app, route); await settle();
    assert.equal(app.document.querySelector("#settings-root img[src='x']"), null, route);
  }
  assert.ok(text(app, ".settings-target-note").includes(name));
  assert.equal(app.document.querySelector("#injected-value, #injected-seed"), null);
});

test("a change sent before another server was selected is not reported as not saved", async () => {
  const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
  const { createRemoteRequest, SETTINGS_ROUTES } = await importModule(pathToFileURL(path.resolve("public/assets/runtime-routes.js")).href);
  let current = true, answer: unknown = { ok: true, value: { settings: {} } };
  const sent: unknown[] = [];
  const runtime = { request: async (...args: unknown[]) => { sent.push(args); current = false; return answer; } };
  const request = createRemoteRequest({ runtime, hostId: HOST, routes: SETTINGS_ROUTES, isCurrent: () => current });
  const save = () => request("/app/settings", { method: "PUT", body: JSON.stringify({ providers: { openai: { apiKey: "" } } }) });
  await assert.rejects(save(), (error: any) => error.code === "unknown_outcome" && /Done on the previous server/.test(error.message));
  assert.deepEqual(copy(sent), [["settings.update", { providers: { openai: { apiKey: { clear: true } } } }, HOST]]);
  current = true; answer = { ok: false, error: { code: "not_connected", message: "Lost." } };
  await assert.rejects(save(), (error: any) => error.code === "unknown_outcome" && /may have been made there/.test(error.message));
  await assert.rejects(save(), (error: any) => error.code === "host_changed" && /Nothing was sent/.test(error.message));
  assert.equal(sent.length, 2, "nothing is sent once another server is selected");
});
