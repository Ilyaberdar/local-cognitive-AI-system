import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LLMRegistry } from "../src/llm/LLMRegistry";
import { LLMService } from "../src/llm/LLMService";
import { LocalModelManagerRegistry } from "../src/llm/LocalModelManager";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { OutputSanitizer } from "../src/llm/OutputSanitizer";
import { withInferenceProgress } from "../src/llm/InferenceProgress";
import { Logger } from "../src/utils/Logger";
import { LLMProvider } from "../src/llm/LLMProvider";
import { LMStudioManager } from "../src/llm/LMStudioManager";
import { OllamaModelManager } from "../src/llm/OllamaModelManager";

test("model discovery keeps identical model IDs from different providers and never invents installed models", async () => {
  const registry = new LLMRegistry();
  for (const id of ["llamacpp", "cloud"]) registry.register({
    id, name: id, defaultModel: "same-id", isConfigured: () => true,
    getDescriptor: () => ({ id, name: id, defaultModel: "same-id", configured: true }),
    listModels: async () => [{ id: "same-id", providerId: id, providerName: id }],
    generateText: async () => ({ provider: id, model: "same-id", text: "ok" })
  });
  assert.equal((await registry.listModels()).length, 2);
  registry.register({
    id: "missing", name: "missing", defaultModel: "not-installed", isConfigured: () => true,
    getDescriptor: () => ({ id: "missing", name: "missing", defaultModel: "not-installed", configured: true,
      capabilities: { local: true, managed: true, jsonMode: true, reasoning: false } }),
    listModels: async () => { throw new Error("runtime offline"); },
    generateText: async () => { throw new Error("unreachable"); }
  });
  assert.equal((await registry.listModels("missing")).length, 0);
});

test("switching a session or debate provider resolves that provider's model and preserves the local judge", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-targets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionSettingsStore({ baseDir: root }, { providerId: "openai", model: "cloud-model" }, { openai: "cloud-model", llamacpp: "library-id" });
  const settings = await store.update("chat", { defaultTarget: { providerId: "llamacpp" }, debate: { support: { providerId: "llamacpp" } } });
  assert.deepEqual(settings.defaultTarget, { providerId: "llamacpp", model: "library-id" });
  assert.deepEqual(settings.debate.support, { providerId: "llamacpp", model: "library-id" });
  assert.deepEqual(settings.debate.judge, { providerId: "local" });
  const loaded = await store.get("chat");
  assert.deepEqual(loaded.defaultTarget, settings.defaultTarget);
});

test("an unavailable external model manager cannot hide installed internal models", async () => {
  const registry = new LocalModelManagerRegistry([
    { providerId: "llamacpp", providerName: "Local", listAllModels: async () => [{ id: "installed", providerId: "llamacpp", providerName: "Local", displayName: "Installed", loaded: false, loadedInstanceIds: [] }],
      listLoadedModels: async () => [], loadModel: async () => {}, unloadModel: async () => {} },
    { providerId: "broken", providerName: "Broken", listAllModels: async () => { throw new Error("offline"); },
      listLoadedModels: async () => { throw new Error("offline"); }, loadModel: async () => {}, unloadModel: async () => {} }
  ]);
  assert.equal((await registry.listAllModels()).length, 1);
  await assert.rejects(registry.listAllModels("broken"), /offline/);
});

test("external model discovery has a short deadline even when generation allows five minutes", async (t) => {
  const deadlines: number[] = [];
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    deadlines.push(milliseconds);
    return timeout(10);
  });
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  // Keep the event loop alive: AbortSignal.timeout uses an unref timer.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const managers = [new LMStudioManager({ baseUrl: "http://fixture.invalid/v1", timeoutMs: 300000 }),
    new OllamaModelManager({ baseUrl: "http://fixture.invalid", timeoutMs: 300000 })];
  const results = await Promise.all(managers.flatMap(manager => [manager.listAllModels(), manager.listLoadedModels()]));
  assert.ok(results.every(models => models.length === 0));
  assert.equal(deadlines.length, 4);
  assert.ok(deadlines.every(value => value <= 5000), `Bootstrap discovery deadlines: ${deadlines.join(", ")}`);
});

test("concurrent agents retain their own inference progress observer", async () => {
  const registry = new LLMRegistry();
  registry.register({
    id: "llamacpp", name: "Local", defaultModel: "tiny", isConfigured: () => true,
    getDescriptor: () => ({ id: "llamacpp", name: "Local", configured: true, defaultModel: "tiny" }),
    generateText: async (request) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      request.onProgress?.({ phase: "queued", model: request.model! });
      return { provider: "llamacpp", model: request.model!, text: "ok" };
    }
  } satisfies LLMProvider);
  const llm = new LLMService(registry, "llamacpp", new Logger(), new OutputSanitizer());
  const seen: string[] = [];
  await Promise.all(["a", "b"].map(id => withInferenceProgress(event => { seen.push(`${id}:${event.model}`); }, () => llm.generateText({ model: id, prompt: "hello" }))));
  assert.deepEqual(seen.sort(), ["a:a", "b:b"]);
});
