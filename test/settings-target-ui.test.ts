import assert from "node:assert/strict";
import test from "node:test";
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
