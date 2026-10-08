import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, flush, SESSION_ID, sessionSettings, type Harness } from "./fixtures/appHarness";

const REV = "a".repeat(40);
const HOST = "6f1c2c3e-58a4-4c55-9a0e-3c7f5b1d2e90";
const settle = async () => { await flush(30); await new Promise(resolve => setTimeout(resolve, 200)); await flush(10); };
const compatibility = { status: "compatible", canLoad: true, canDownload: true, blockingIssues: [], estimatedMemoryBytes: 600e6, warnings: [], reasons: [] };
const libraryModel = { id: "lib-qwen", libraryId: "lib-qwen", providerId: "llamacpp", providerName: "Local models", displayName: "Qwen 0.5B", repoId: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
  revision: REV, variantId: "q4.gguf", quantization: "Q4_K_M", license: "apache-2.0", installedAt: "2026-10-01T00:00:00Z", owned: true,
  files: [{ path: "q4.gguf", sizeBytes: 400e6, sha256: "b".repeat(64) }], sizeBytes: 400e6, state: "unloaded", loaded: false, loadedInstanceIds: [], filesAvailable: true, compatibility };
const catalogItem = { id: "Qwen/Qwen2.5-0.5B-Instruct-GGUF", repoId: "Qwen/Qwen2.5-0.5B-Instruct-GGUF", name: "Qwen2.5-0.5B-Instruct-GGUF", author: "Qwen", revision: REV, license: "apache-2.0",
  gated: false, projectors: [], variants: [{ id: "q4.gguf", name: "Q4_K_M", quantization: "Q4_K_M", sizeBytes: 400e6, files: [{ path: "q4.gguf", sizeBytes: 400e6, sha256: "b".repeat(64) }], compatibility }] };
const otherItem = { ...catalogItem, id: "x/other-GGUF", repoId: "x/other-GGUF", name: "other", variants: [{ ...catalogItem.variants[0]!, id: "o.gguf" }] };

/** This computer's model library: one installed model, a two-item catalog, load and unload. */
export function localModels() {
  let loaded = false;
  const snapshot = () => ({ models: [{ ...libraryModel, state: loaded ? "ready" : "unloaded", loaded, loadedInstanceIds: loaded ? ["lib-qwen"] : [] }], downloads: [],
    runtime: { status: loaded ? "ready" : "stopped", backend: "CPU", version: "b10809", modelsDir: "/Users/x/models", queueLength: 0, busy: false,
      instances: loaded ? [{ status: "ready", modelId: "lib-qwen", placement: { kind: "single-gpu", label: "GPU 0", devices: [], gpuLayers: "all", hostEstimatedBytes: 0, warnings: [] } }] : [] },
    sequence: 1 });
  const route = (method: string, url: string): unknown => {
    if (url === "/local/runtime") return snapshot();
    if (url === "/local/downloads" && method === "GET") return [];
    if (url.startsWith("/local/catalog/model")) return url.includes("other") ? otherItem : catalogItem;
    if (url.startsWith("/local/catalog")) return { items: [catalogItem, otherItem], cached: true };
    if (url === "/local/downloads" && method === "POST") return { id: "download-1", state: "queued" };
    if (url === "/local/models/load") { loaded = true; return { ok: true }; }
    if (url === "/local/models/unload") { loaded = false; return { ok: true }; }
    if (url === "/local/models/all") return [snapshot().models[0]];
    if (url === "/system/metrics") return { cpuPercent: 1, ramPercent: 1, memoryUsedBytes: 1, memoryTotalBytes: 2, cpuCores: 8, loadAverage1m: 0 };
    return undefined;
  };
  const bootstrap = () => ({
    providers: [{ id: "ollama", name: "Ollama", capabilities: { local: true } }, { id: "llamacpp", name: "Local models", capabilities: { local: true } }],
    tools: [], plugins: [], pluginStatuses: [], tasks: [], schedules: [], workflows: [], workflowRuns: [], projects: [],
    appSettings: { ui: { theme: "dark", animations: false }, llm: { defaultProvider: "ollama" }, providers: { ollama: { model: "llama3.2", enabled: true } }, localModels: { contextSize: 4096, gpuLayers: "auto" } },
    sessions: [{ id: SESSION_ID, title: "First chat", updatedAt: "2026-10-01T10:00:00.000Z" }],
    availableModels: [], loadedModels: [], allManagedModels: [libraryModel], localModels: snapshot(), systemMetrics: {}
  });
  return { route, bootstrap };
}

/** A paired server that is online; it is never selected in these tests. */
const pairedBridge = () => {
  const ok = (value: unknown) => ({ ok: true, value });
  const status = { state: "online", hostId: HOST, hostName: "fedora", serverVersion: "0.1.0", capabilities: ["chat.runs.start", "events.poll"] };
  return { status: async () => ok(status), hosts: async () => ok([{ hostId: HOST, name: "fedora", online: true, appVersion: "0.1.0", paired: true, devices: [] }]),
    connect: async () => ok(status), disconnect: async () => ok({ state: "idle" }), hostStatus: async () => ok({}), onChange() {},
    runtime: { request: async () => ok({}), send: async () => ok({}), subscribe: async () => ok(undefined), unsubscribe: async () => ok(undefined), onEvent() {} } };
};

const click = (app: Harness, selector: string) => {
  const element = app.document.querySelector(selector);
  assert.ok(element, `missing ${selector}`);
  element.click();
};
/** Requests in order, with the pinned revision masked; markers separate the user's actions. */
async function walkModelsTab(app: Harness) {
  const trace = [...app.requests];
  const step = async (label: string, action: () => void | Promise<void>) => {
    const before = app.requests.length;
    await action();
    await settle();
    trace.push(`--- ${label}`, ...app.requests.slice(before));
  };
  await step("open #/models", () => { app.window.location.hash = "#/models"; });
  await step("view model", () => click(app, `[data-mm-action="details"][data-mm-id="x/other-GGUF"]`));
  await step("download", () => click(app, '[data-mm-action="download"]'));
  await step("tab device", () => click(app, '[data-mm-action="tab"][data-mm-id="device"]'));
  await step("load", () => click(app, '[data-mm-action="load"]'));
  await step("unload", () => click(app, '[data-mm-action="unload"]'));
  await step("metrics tick", () => app.tick(5000));
  return trace.map(entry => entry.replace(/[a]{40}/g, "<sha>"));
}

/** The Models tab of this computer, recorded before the tab could show a server. */
const LOCAL_MODELS_TRACE = [
  "GET /dashboard/bootstrap", "GET /integrations/available", `GET /sessions/${SESSION_ID}/messages`, `GET /sessions/${SESSION_ID}/settings`,
  "GET /local/runtime", "GET /local/downloads", "EVENTSOURCE /local/events",
  "--- open #/models", "GET /local/catalog?source=recommended",
  "--- view model", "GET /local/catalog/model?repoId=x%2Fother-GGUF&revision=<sha>",
  "--- download", `POST /local/downloads {"repoId":"x/other-GGUF","revision":"<sha>","variantId":"o.gguf"}`, "GET /local/runtime", "GET /local/downloads",
  "--- tab device",
  "--- load", `POST /local/models/load {"providerId":"llamacpp","modelId":"lib-qwen"}`, "GET /local/runtime", "GET /local/downloads",
  "--- unload", `POST /local/models/unload {"providerId":"llamacpp","modelIdOrInstanceId":"lib-qwen"}`, "GET /local/runtime", "GET /local/downloads",
  "--- metrics tick", "GET /local/runtime", "GET /local/downloads", "GET /system/metrics"
];

test("this computer's Models tab makes exactly the same requests with or without a paired server", async t => {
  const plain = await bootApp(localModels());
  t.after(() => plain.close());
  assert.deepEqual(await walkModelsTab(plain), LOCAL_MODELS_TRACE);
  const heading = plain.document.querySelector(".mm-heading")?.textContent.replace(/\s+/g, " ").trim();
  assert.match(heading, /Private inference, on your computer/);

  const paired = await bootApp({ ...localModels(), remote: { bridge: pairedBridge() } });
  t.after(() => paired.close());
  assert.deepEqual(await walkModelsTab(paired), LOCAL_MODELS_TRACE);
  assert.deepEqual(paired.bridgeCalls.filter(call => call.op.startsWith("runtime.")), [], "nothing went to the server");
});

/** fedora, paired and online, with one model in its library and one GPU. Its Models operations
 * answer from `server`; `emitSnapshot` plays the server's model watch. */
function fedoraWithModels(capabilities = ["chat.runs.start", "events.poll", "models.local.watch", "models.local.snapshot", "system.metrics"]) {
  let status: Record<string, unknown> = { state: "online", hostId: HOST, hostName: "fedora", serverVersion: "0.2.0", capabilities };
  const statusListeners: Array<(value: unknown) => void> = [], eventListeners: Array<(value: unknown) => void> = [];
  const serverModel = { ...libraryModel, id: "srv-llama", libraryId: "srv-llama", displayName: "Llama on fedora" };
  const server = { loaded: false, sequence: 1, sessions: [] as Array<{ id: string; title: string }>,
    settings: { llm: { defaultProvider: "llamacpp" }, providers: { llamacpp: { model: "" } }, localModels: { contextSize: 8192, gpuLayers: "auto" } },
    chatSettings: { ...sessionSettings(), defaultTarget: { providerId: "llamacpp", model: "" } } as Record<string, any> };
  const snapshot = () => ({ sequence: server.sequence, models: [{ ...serverModel, state: server.loaded ? "ready" : "unloaded", loaded: server.loaded }], downloads: [],
    runtime: { status: server.loaded ? "ready" : "stopped", backend: "CUDA", version: "b10809", modelsDir: "", queueLength: 0, busy: false, instances: [] } });
  const ok = (value: unknown) => ({ ok: true, value });
  const handlers: Record<string, (payload: any) => unknown> = {
    "sessions.list": () => server.sessions,
    "sessions.create": () => { const session = { id: "srv-chat", title: "New chat" }; server.sessions = [session]; return session; },
    "sessions.messages.list": () => ({ messages: [], cursor: { streamId: "session:srv-chat", epoch: "e1", after: 0 } }),
    "sessions.settings.get": () => server.chatSettings,
    "sessions.settings.update": payload => (server.chatSettings = { ...server.chatSettings, ...payload.patch }),
    "models.available": () => ({ providers: [{ id: "llamacpp", name: "Local models" }], availableModels: [], loadedModels: [], allManagedModels: [snapshot().models[0]],
      appSettings: { llm: { defaultProvider: "llamacpp" }, providers: {} } }),
    "models.settings.get": () => server.settings,
    "models.local.snapshot": () => snapshot(),
    "models.downloads.list": () => [],
    "models.catalog.search": () => ({ items: [catalogItem, otherItem] }),
    "models.catalog.get": payload => payload.repoId === otherItem.repoId ? otherItem : catalogItem,
    "models.load": payload => { server.loaded = true; return { modelId: payload.modelId, status: "ready" }; },
    "models.unload": payload => { server.loaded = false; return { modelId: payload.modelId, status: "unloaded" }; },
    "system.metrics": () => ({ cpuPercent: 3, ramPercent: 40, memoryUsedBytes: 13e9, memoryTotalBytes: 32e9, cpuCores: 16, loadAverage1m: 1,
      gpus: [{ id: "GPU-1", index: 0, name: "GTX 1070 Ti", totalBytes: 8e9, usedBytes: 2e9, freeBytes: 6e9 }] })
  };
  const emitSnapshot = () => { server.sequence++; eventListeners.forEach(listener => listener({ streamId: "models.local", sequence: server.sequence, snapshot: snapshot() })); };
  const bridge = {
    status: async () => ok(status),
    hosts: async () => ok([{ hostId: HOST, name: "fedora", online: true, appVersion: "0.2.0", paired: true, devices: [] }]),
    connect: async () => ok(status), disconnect: async () => ok({ state: "idle" }), hostStatus: async () => ok({}),
    onChange: (listener: (value: unknown) => void) => { statusListeners.push(listener); return () => statusListeners.splice(statusListeners.indexOf(listener), 1); },
    runtime: {
      request: async (op: string, payload: unknown) => handlers[op] ? ok(handlers[op]!(payload)) : { ok: false, error: { code: "unknown_operation", message: `No ${op} here.` } },
      send: async (_op: string, payload: Record<string, unknown>) => ok({ id: "download-1", state: "queued", libraryId: "srv-other", ...payload }),
      subscribe: async () => ok(undefined), unsubscribe: async () => ok(undefined),
      // The first answer of a watch is the whole state.
      watch: async () => { setTimeout(emitSnapshot, 0); return ok(undefined); },
      unwatch: async () => ok(undefined),
      onEvent: (listener: (value: unknown) => void) => { eventListeners.push(listener); }
    }
  };
  return { bridge, server, emitSnapshot, setStatus(next: Record<string, unknown>) { status = { ...status, ...next }; statusListeners.forEach(listener => listener(status)); } };
}

const text = (app: Harness, selector: string) => String(app.document.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
/** Bridge calls as [operation, payload, server] in the test's realm. */
const runtimeCalls = (app: Harness, from = 0) => JSON.parse(JSON.stringify(app.bridgeCalls.slice(from).filter(call => call.op.startsWith("runtime.") && call.op !== "runtime.unwatch")
  .map(call => [call.op.slice("runtime.".length), ...call.payload])));
const selectFedora = async (app: Harness) => { click(app, `[data-chat-target="${HOST}"]`); await settle(); };

test("with fedora selected, the Models tab runs on fedora and asks this computer nothing", async t => {
  const fedora = fedoraWithModels();
  const app = await bootApp({ ...localModels(), remote: { bridge: fedora.bridge } });
  t.after(() => app.close());
  await selectFedora(app);
  const localBefore = app.requests.length, callsBefore = app.bridgeCalls.length;

  app.window.location.hash = "#/models";
  await settle();
  assert.equal(app.document.querySelector("#local-model-manager"), null);
  assert.match(text(app, "#server-model-manager .mm-heading"), /Private inference, on fedora\s*Models on fedora/);
  assert.match(text(app, ".chat-target-label"), /fedora/, "the switch is on every screen");
  click(app, '[data-mm-action="details"][data-mm-id="x/other-GGUF"]');
  await settle();
  assert.match(text(app, "#mm-detail-dialog"), /Download to fedora[\s\S]*Fits fedora/);
  click(app, '[data-mm-action="download"]');
  await settle();
  click(app, '[data-mm-action="tab"][data-mm-id="device"]');
  await settle();
  assert.match(text(app, "#mm-device"), /Llama on fedora/);
  assert.equal(app.document.querySelector('[data-mm-action="import"]'), null, "files of this computer are not offered to the server");
  click(app, '[data-mm-action="load"]');
  await settle();
  click(app, '[data-mm-action="unload"]');
  await settle();
  await app.tick(5000);
  assert.match(text(app, ".mm-gpu"), /GPU 0\s*5\.6 GB free \/ 7\.5 GB/);

  assert.deepEqual(app.requests.slice(localBefore).filter(entry => /\/local\/|\/system\/metrics|\/app\/settings|\/providers\/|EVENTSOURCE/.test(entry)), [],
    "this computer's model API, metrics and settings were not asked");
  const calls = runtimeCalls(app, callsBefore);
  assert.ok(calls.every((call: unknown[]) => call.at(-1) === HOST), "every call names fedora");
  const sent = calls.map((call: unknown[]) => call.slice(0, -1));
  for (const expected of [["watch", "models.local"], ["request", "models.settings.get", undefined], ["request", "models.local.snapshot", undefined],
    ["request", "models.catalog.search", { source: "recommended" }], ["request", "models.catalog.get", { repoId: "x/other-GGUF", revision: REV }],
    ["send", "models.downloads.start", { repoId: "x/other-GGUF", revision: REV, variantId: "o.gguf" }],
    ["request", "models.load", { modelId: "srv-llama" }], ["request", "models.unload", { modelId: "srv-llama" }], ["request", "system.metrics", undefined]]) {
    assert.ok(sent.some((call: unknown[]) => JSON.stringify(call) === JSON.stringify(expected)), `missing ${JSON.stringify(expected)} in ${JSON.stringify(sent)}`);
  }
});

test("offline, fedora's tab keeps the last state and sends nothing; This computer's models come back untouched", async t => {
  const fedora = fedoraWithModels();
  const app = await bootApp({ ...localModels(), remote: { bridge: fedora.bridge } });
  t.after(() => app.close());
  await selectFedora(app);
  app.window.location.hash = "#/models";
  await settle();
  click(app, '[data-mm-action="tab"][data-mm-id="device"]');
  await settle();

  fedora.setStatus({ state: "reconnecting" });
  await settle();
  assert.match(text(app, ".mm-offline-banner"), /fedora is reconnecting\. Showing the last known state; nothing is sent\./);
  assert.match(text(app, "#mm-device"), /Llama on fedora/, "the last state stays on screen");
  const load = app.document.querySelector('[data-mm-action="load"]');
  assert.equal(load.disabled, true);
  const callsBefore = app.bridgeCalls.length;
  load.click();
  await app.tick(5000);
  assert.deepEqual(runtimeCalls(app, callsBefore), [], "nothing is sent or queued while offline");

  click(app, '[data-chat-target="local"]');
  await settle();
  assert.equal(app.window.location.hash, "#/models", "the screen stays");
  assert.equal(app.document.querySelector("#server-model-manager"), null);
  assert.match(text(app, "#local-model-manager .mm-heading"), /Private inference, on your computer\s*Local models/);
  click(app, '[data-mm-action="tab"][data-mm-id="device"]');
  await settle();
  assert.match(text(app, "#mm-device"), /Qwen 0\.5B/);
  assert.doesNotMatch(text(app, "#mm-device"), /Llama on fedora/);
});

test("Use in chat on fedora's tab sets the server chat's model and opens it", async t => {
  const fedora = fedoraWithModels();
  const app = await bootApp({ ...localModels(), remote: { bridge: fedora.bridge } });
  t.after(() => app.close());
  await selectFedora(app);
  app.window.location.hash = "#/models";
  await settle();
  click(app, '[data-mm-action="tab"][data-mm-id="device"]');
  await settle();
  const localBefore = app.requests.length;
  click(app, '[data-mm-action="use"]');
  await settle();
  assert.equal(app.window.location.hash, "#/chat");
  assert.deepEqual(JSON.parse(JSON.stringify(fedora.server.chatSettings.defaultTarget)), { providerId: "llamacpp", model: "srv-llama" });
  assert.match(text(app, "#session-settings-form"), /Llama on fedora/);
  assert.deepEqual(app.requests.slice(localBefore).filter(entry => /^(PUT|POST)/.test(entry)), [], "no local chat was created or changed");
});

test("Workflow and Synthesis say they run on this computer while fedora is selected", async t => {
  const fedora = fedoraWithModels();
  const app = await bootApp({ ...localModels(), remote: { bridge: fedora.bridge } });
  t.after(() => app.close());
  await selectFedora(app);
  app.window.location.hash = "#/orchestration";
  await settle();
  assert.match(text(app, ".route--orchestration"), /Tasks & workflows is not available on fedora yet/);
  app.window.location.hash = "#/synthesis";
  await settle();
  assert.match(text(app, ".route--synthesis"), /Synthesis is not available on fedora yet/);
  click(app, '.route--synthesis [data-chat-target="local"]');
  await settle();
  assert.equal(app.window.location.hash, "#/synthesis");
  assert.equal(app.document.querySelector(".server-unavailable"), null);
});

test("an older fedora without the Models operations is asked nothing and the tab says to update it", async t => {
  const fedora = fedoraWithModels(["chat.runs.start", "events.poll"]);
  const app = await bootApp({ ...localModels(), remote: { bridge: fedora.bridge } });
  t.after(() => app.close());
  await selectFedora(app);
  const callsBefore = app.bridgeCalls.length;
  app.window.location.hash = "#/models";
  await settle();
  await app.tick(5000);
  assert.match(text(app, "#server-model-manager"), /Update Local Cognitive on fedora to manage its models from here\./);
  assert.deepEqual(runtimeCalls(app, callsBefore), []);
});
