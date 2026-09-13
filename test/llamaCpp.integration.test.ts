import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { config, AppConfig } from "../src/config/config";
import { RuntimeManager } from "../src/app/RuntimeManager";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import { Logger } from "../src/utils/Logger";
import { LocalModelService } from "../src/local/LocalModelService";
import { randomUUID } from "node:crypto";

/** Opt in explicitly: downloads the pinned recommended variants and executes native inference. */
test("real packaged-compatible llama.cpp: all curated downloads, chat, JSON, queue, workflow, restart and offline", {
  skip: process.env.LLAMA_CPP_INTEGRATION !== "1" ? "Set LLAMA_CPP_INTEGRATION=1 to download GGUF files and run real inference." : false,
  timeout: 1800000
}, async (t) => {
  const root = path.resolve(process.env.LLAMA_TEST_DATA_DIR ?? await fs.mkdtemp(path.join(os.tmpdir(), "llama-real-")));
  const options: AppConfig = {
    ...config,
    appDataDir: path.join(root, "app"),
    sessions: { baseDir: path.join(root, "sessions") },
    memory: { ...config.memory, adapter: "local-json", baseDir: path.join(root, "memory") },
    outputDir: path.join(root, "output"),
    plugins: { ...config.plugins, overrides: { file: { enabled: false }, notion: { enabled: false } } },
    telegram: { ...config.telegram, enabled: false },
    llm: { defaultProvider: "llamacpp" },
    providers: { ...config.providers, llamacpp: { baseUrl: "", model: "", timeoutMs: 600000, enabled: true },
      ollama: { ...config.providers.ollama, enabled: false }, lmstudio: { ...config.providers.lmstudio, enabled: false },
      openai: { ...config.providers.openai, enabled: false }, anthropic: { ...config.providers.anthropic, enabled: false }, gemini: { ...config.providers.gemini, enabled: false } },
    localModels: { ...config.localModels!, modelsDir: path.join(root, "models"), contextSize: 4096, loadTimeoutMs: 300000, generationTimeoutMs: 600000 }
  };
  let manager = new RuntimeManager(options, new AppSettingsStore(options.appDataDir, options), new Logger());
  t.after(async () => { await manager.dispose(); });
  let runtime = await manager.init();
  let service = runtime.localModelService;
  const evidence: Record<string, unknown>[] = [];
  const record = (result: Record<string, unknown>) => { evidence.push({ at: new Date().toISOString(), ...result }); console.log(JSON.stringify(result)); };
  const catalog = await service.listCatalog();
  assert.ok(catalog.items.length > 0, "Recommended catalog must be bundled");
  for (const model of catalog.items) {
    for (const variant of model.variants) {
      let installed = service.snapshot().models.find(item => item.repoId === model.repoId && item.revision === model.revision && item.variantId === variant.id);
      if (!installed) {
        const job = await service.startDownload({ repoId: model.repoId, revision: model.revision, variantId: variant.id });
        let lastBucket = -1;
        const deadline = Date.now() + 900000;
        while (true) {
          const current = service.snapshot().downloads.find(item => item.id === job.id)!;
          if (["failed", "cancelled", "paused"].includes(current.state)) throw new Error(`${current.name}: ${current.state}: ${current.error}`);
          const bucket = Math.floor(current.progress / 20);
          if (bucket !== lastBucket) { lastBucket = bucket; record({ check: "download", name: current.name, progress: current.progress, bytes: current.downloadedBytes }); }
          if (current.state === "completed") break;
          assert.ok(Date.now() < deadline, "Download deadline exceeded");
          await delay(250);
        }
        installed = service.snapshot().models.find(item => item.id === job.libraryId);
      }
      assert.ok(installed);
      const started = Date.now();
      await service.loadModel(installed.id);
      assert.ok((await service.listLoadedModels()).some(item => item.id === installed!.id));
      const response = await runtime.llmService.generateText({ model: installed.id, prompt: "Answer in one short sentence: what is 2 plus 2? /no_think", maxTokens: 512 }, "llamacpp");
      assert.ok(!response.error, response.error);
      assert.ok(response.text.trim(), "The final answer must be nonempty");
      record({ check: "native-inference", model: model.repoId, revision: model.revision, variant: variant.id, sha256: installed.files.map(file => file.sha256), build: service.snapshot().runtime.version, backend: service.snapshot().runtime.backend, durationMs: Date.now() - started, answer: response.text });
      await service.unloadModel(installed.id);
      assert.equal((await service.listLoadedModels()).length, 0);
    }
  }
  const models = service.snapshot().models;
  const preferred = models.find(item => item.repoId?.includes("Qwen2.5")) ?? models[0];
  assert.ok(preferred);
  await manager.updateSettings({ providers: { llamacpp: { model: preferred.id } } });
  runtime = manager.getRuntime();
  assert.equal(runtime.localModelService, service, "Saving settings must reuse the model owner");
  await runtime.sessionSettingsStore.update("native-chat", { mode: "general", language: "auto", defaultTarget: { providerId: "llamacpp", model: preferred.id } });
  const chat = await runtime.engine.process({ actor: { sessionId: "native-chat", channel: "http" }, input: "Say hello in one short sentence." });
  assert.ok(!chat.result.error, chat.result.error);
  assert.ok("response" in chat.result && chat.result.response.trim());
  record({ check: "chat", model: preferred.id, answer: "response" in chat.result ? chat.result.response : "" });
  const json = await runtime.llmService.generateObject<{ result: number }>({ model: preferred.id, prompt: 'Return JSON with "result": 4.', maxTokens: 256 }, "llamacpp");
  assert.ok(!json.response.error, json.response.error);
  assert.equal(json.data?.result, 4);
  record({ check: "structured-output", answer: json.response.text });
  const queueEvents: string[] = [];
  const queued = models.slice(0, 2).map((model, index) => runtime.llmService.generateText({ model: model.id,
    prompt: "Say hello briefly. /no_think", maxTokens: 256, onProgress: event => queueEvents.push(`${index}:${event.phase}`) }, "llamacpp"));
  const queueResults = await Promise.all(queued);
  for (const result of queueResults) { assert.ok(!result.error, result.error); assert.ok(result.text.trim()); }
  assert.ok(queueEvents.includes("1:queued"));
  record({ check: "two-model-queue", events: queueEvents });
  const workflow = await runtime.workflowStore.create({ id: randomUUID(), version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), name: "Native model acceptance", description: "Local inference, review and completion", entryNodeId: "entry", nodes: [
    { id: "entry", type: "entry", label: "Start", position: { x: 0, y: 0 }, config: {} },
    { id: "agent", type: "agent", label: "Local model", position: { x: 200, y: 0 }, config: { providerId: "llamacpp", model: preferred.id, mode: "general", promptTemplate: "Reply with one short sentence confirming the task is ready." } },
    { id: "review", type: "human_review", label: "Review", position: { x: 400, y: 0 }, config: {} },
    { id: "done", type: "terminal", label: "Done", position: { x: 600, y: 0 }, config: { runStatus: "done" } }
  ], transitions: [
    { id: "start", from: "entry", to: "agent", priority: 1, guard: { type: "always" } },
    { id: "respond", from: "agent", to: "review", priority: 1, guard: { type: "status", equals: "ok" } },
    { id: "approve", from: "review", to: "done", priority: 1, guard: { type: "always" } }
  ] });
  const task = await runtime.taskService.create({ title: "Native workflow acceptance", description: "Verify local execution", workflowId: workflow.id });
  const workflowResult = await runtime.taskService.runTask(task.id);
  const run = await runtime.workflowRunStore.getRun(workflowResult.runId);
  assert.equal(run?.status, "waiting");
  const completed = await runtime.workflowRunner.review(workflowResult.runId, true, "QA approved");
  assert.equal(completed.status, "done");
  record({ check: "workflow-review-terminal", runId: completed.id, status: completed.status });
  const originalFetch = globalThis.fetch;
  await manager.dispose();
  // Deny external requests while preserving loopback inference. This is a real offline bootstrap.
  globalThis.fetch = ((input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("External network disabled for offline acceptance");
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    manager = new RuntimeManager(options, new AppSettingsStore(options.appDataDir, options), new Logger());
    runtime = await manager.init();
    service = runtime.localModelService;
    assert.equal(service.snapshot().models.length, models.length);
    assert.equal((await manager.getSettings()).providers.llamacpp.model, preferred.id);
    const response = await runtime.llmService.generateText({ prompt: "Say hello briefly.", maxTokens: 128 }, "llamacpp");
    assert.ok(!response.error, response.error);
    assert.ok(response.text.trim());
    record({ check: "restart-offline", models: models.length, answer: response.text });
  } finally { globalThis.fetch = originalFetch; }
  await fs.writeFile(path.join(root, "acceptance.json"), JSON.stringify({ platform: process.platform, arch: process.arch, evidence }, null, 2));
});
