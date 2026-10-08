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

void sessionSettings;
