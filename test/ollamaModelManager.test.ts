import assert from "node:assert/strict";
import test from "node:test";
import { LocalModelManagerRegistry } from "../src/llm/LocalModelManager";
import { OllamaModelManager } from "../src/llm/OllamaModelManager";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("Ollama model manager maps local and running models", async () => {
  globalThis.fetch = (async (input) => {
    const url = String(input);

    if (url.endsWith("/api/tags")) {
      return new Response(
        JSON.stringify({
          models: [
            { name: "llama3.2:latest", size: 123 },
            { model: "codellama:latest", size: 456 }
          ]
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/api/ps")) {
      return new Response(
        JSON.stringify({
          models: [{ name: "llama3.2:latest", size: 123, size_vram: 100 }]
        }),
        { status: 200 }
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const manager = new OllamaModelManager({
    baseUrl: "http://127.0.0.1:11434",
    timeoutMs: 1000
  });

  const models = await manager.listAllModels();

  assert.equal(models.length, 2);
  assert.equal(models[0].providerId, "ollama");
  assert.equal(models[0].providerName, "Ollama");
  assert.equal(models[0].id, "codellama:latest");
  assert.equal(models[0].loaded, false);
  assert.equal(models[1].id, "llama3.2:latest");
  assert.equal(models[1].loaded, true);
  assert.deepEqual(models[1].loadedInstanceIds, ["llama3.2:latest"]);
  assert.equal(models[1].sizeBytes, 123);
});

test("Ollama model manager load and unload use generate keep_alive contract", async () => {
  const bodies: unknown[] = [];

  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "http://127.0.0.1:11434/api/generate");
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ done: true }), { status: 200 });
  }) as typeof fetch;

  const manager = new OllamaModelManager({
    baseUrl: "http://127.0.0.1:11434/",
    timeoutMs: 1000
  });

  await manager.loadModel("llama3.2:latest");
  await manager.unloadModel("llama3.2:latest");

  assert.deepEqual(bodies, [
    {
      model: "llama3.2:latest",
      prompt: "",
      stream: false,
      keep_alive: "5m"
    },
    {
      model: "llama3.2:latest",
      prompt: "",
      stream: false,
      keep_alive: 0
    }
  ]);
});

test("local model manager registry dispatches by provider", async () => {
  const calls: string[] = [];
  const ollama = new OllamaModelManager({
    baseUrl: "http://127.0.0.1:11434",
    timeoutMs: 1000
  });
  const registry = new LocalModelManagerRegistry([
    {
      providerId: "fake",
      providerName: "Fake",
      listAllModels: async () => [],
      listLoadedModels: async () => [],
      loadModel: async (modelId) => {
        calls.push(`load:${modelId}`);
      },
      unloadModel: async (modelId) => {
        calls.push(`unload:${modelId}`);
      }
    },
    ollama
  ]);

  await registry.loadModel("fake", "model-a");
  await registry.unloadModel("fake", "model-a");

  assert.deepEqual(calls, ["load:model-a", "unload:model-a"]);
  await assert.rejects(() => registry.loadModel("missing", "model-a"), /not registered/);
});
