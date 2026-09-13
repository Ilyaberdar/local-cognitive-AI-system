import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { config, AppConfig } from "../src/config/config";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import { RuntimeManager } from "../src/app/RuntimeManager";
import { Logger } from "../src/utils/Logger";
import { LocalModelOptions } from "../src/local/types";
import { LLMRequest, ProcessProgressEvent } from "../src/types";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-settings-"));
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, options]) => [id, { ...options, enabled: false, apiKey: "" }])) as AppConfig["providers"];
  const options: AppConfig = { ...config, providers, appDataDir: path.join(root, "app"),
    llm: { defaultProvider: "llamacpp" }, sessions: { baseDir: path.join(root, "sessions") },
    memory: { ...config.memory, adapter: "local-json", baseDir: path.join(root, "memory") },
    outputDir: path.join(root, "output"), plugins: { dir: path.join(root, "plugins"), overrides: {} },
    telegram: { ...config.telegram, enabled: false, botToken: "" },
    localModels: { ...config.localModels!, runtimeDir: path.join(root, "runtime"), executablePath: undefined,
      modelsDir: path.join(root, "models"), contextSize: 4096 }
  };
  const store = new AppSettingsStore(options.appDataDir, options);
  const manager = new RuntimeManager(options, store, new Logger());
  const runtime = await manager.init();
  t.after(async () => { await manager.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { manager, store, service: runtime.localModelService };
}

test("settings commit only after local reconfiguration succeeds; failures preserve the prior settings", async (t) => {
  const { manager, store, service } = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const reconfigure = service.reconfigure.bind(service);
  const previous = await store.get();
  t.mock.method(service, "reconfigure", async (options: LocalModelOptions) => {
    if (options.contextSize === 2048) { entered.resolve(); await release.promise; }
    if (options.contextSize === 1024) throw new Error("Copy verification failed");
    await reconfigure(options);
  });
  const pending = manager.updateSettings({ localModels: { contextSize: 2048 } });
  await entered.promise;
  assert.deepEqual(await store.get(), previous, "Do not publish settings pointing at unfinished storage");
  release.resolve();
  await pending;
  const committed = await store.get();
  assert.equal(committed.localModels?.contextSize, 2048);
  await assert.rejects(manager.updateSettings({ localModels: { contextSize: 1024 } }), /Copy verification failed/);
  assert.deepEqual(await store.get(), committed);
  assert.equal(manager.getRuntime().localModelService, service);
});

test("Quit disposes the local model owner before waiting for settings queued behind inference", { timeout: 3000 }, async (t) => {
  const { manager, service } = await fixture(t);
  const entered = deferred();
  const cancelled = deferred();
  const dispose = service.dispose.bind(service);
  t.mock.method(service, "reconfigure", async () => { entered.resolve(); await cancelled.promise; });
  t.mock.method(service, "dispose", () => { cancelled.resolve(); return dispose(); });
  const pending = manager.updateSettings({ localModels: { contextSize: 2048 } });
  const outcome = assert.rejects(pending, /disposed/);
  await entered.promise;
  await manager.dispose();
  await outcome;
});

test("a translation following general chat reports its own local queue and load phases", async (t) => {
  const { manager, service } = await fixture(t);
  t.mock.getter(service, "available", () => true);
  await manager.updateSettings({ providers: { llamacpp: { enabled: true, model: "fixture-model" } } });
  let calls = 0;
  t.mock.method(service, "generateText", async (request: LLMRequest) => {
    calls++;
    request.onProgress?.({ phase: "queued", model: "fixture-model", queuePosition: calls });
    request.onProgress?.({ phase: "loading", model: "fixture-model" });
    return { provider: "llamacpp", model: "fixture-model", text: calls === 1 ? "A short English sentence needs translation." : '{"items":["Краткое предложение переведено на русский."]}' };
  });
  const runtime = manager.getRuntime();
  await runtime.sessionSettingsStore.update("translation", { mode: "general", language: "ru" });
  const progress: ProcessProgressEvent[] = [];
  const result = await runtime.engine.process({ actor: { sessionId: "translation", channel: "http" }, input: "Ответь кратко.", onProgress: event => progress.push(event) });
  assert.equal(calls, 2);
  assert.ok("response" in result.result && result.result.response.includes("переведено"));
  assert.ok(progress.some(event => event.label === "Waiting · 2 in queue"), "Translation must retain the main model observer");
  assert.equal(progress.filter(event => event.label === "Loading model").length, 2);
});

test("missing delegation markers receive one structured repair from the main model before agents run", async (t) => {
  const { manager, service } = await fixture(t);
  t.mock.getter(service, "available", () => true);
  await manager.updateSettings({ providers: { llamacpp: { enabled: true, model: "main-model" } } });
  const requests: LLMRequest[] = [];
  t.mock.method(service, "generateText", async (request: LLMRequest) => {
    requests.push(request);
    const text = requests.length === 1 ? "The main model draft without markers."
      : request.responseFormat ? '{"assignments":[{"id":"reviewer","task":"Inspect the addition operator."},{"id":"unexpected","task":"Must not be scheduled."}]}'
      : request.model === "review-model" ? "The addition operator is correct." : "The reviewed result is ready.";
    return { provider: "llamacpp", model: request.model!, text };
  });
  const runtime = manager.getRuntime();
  await runtime.sessionSettingsStore.update("repair", { mode: "code", language: "auto",
    codeAgents: [{ id: "reviewer", name: "Reviewer", providerId: "llamacpp", model: "review-model", accessMode: "default" }] });
  const result = await runtime.engine.process({ actor: { sessionId: "repair", channel: "http" }, input: "Use @Reviewer to inspect an addition function." });
  assert.equal(requests.filter(request => request.responseFormat).length, 1);
  const reviewer = requests.filter(request => request.model === "review-model");
  assert.equal(reviewer.length, 1);
  assert.ok(reviewer[0].prompt.includes("Inspect the addition operator."));
  assert.ok(!reviewer[0].prompt.includes("Must not be scheduled."));
  assert.ok("subagents" in result.result && result.result.subagents?.[0].status === "ok");
});
