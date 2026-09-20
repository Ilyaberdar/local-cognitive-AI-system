import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicProvider } from "../src/llm/AnthropicProvider";
import { GeminiProvider } from "../src/llm/GeminiProvider";
import { Logger } from "../src/utils/Logger";

const logger = new Logger();

test("Anthropic lists every page of models with the provider's authentication headers", async (t) => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  t.mock.method(globalThis, "fetch", async (input: URL | string, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return requests.length === 1
      ? Response.json({ data: [{ id: "claude-first", display_name: "Claude First" }], has_more: true, last_id: "claude-first" })
      : Response.json({ data: [{ id: "claude-second" }], has_more: false });
  });

  const provider = new AnthropicProvider({
    baseUrl: "https://api.anthropic.test/", apiKey: "anthropic-key", model: "claude-first", timeoutMs: 1000,
    version: "2023-06-01", maxTokens: 100
  }, logger);
  const models = await provider.listModels();

  assert.deepEqual(models.map((model) => model.id), ["claude-first", "claude-second"]);
  assert.match(requests[0].url, /\/v1\/models\?limit=1000/);
  assert.match(requests[1].url, /after_id=claude-first/);
  assert.equal(requests[0].headers.get("x-api-key"), "anthropic-key");
  assert.equal(requests[0].headers.get("anthropic-version"), "2023-06-01");
});

test("Gemini lists generative models and follows page tokens", async (t) => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  t.mock.method(globalThis, "fetch", async (input: URL | string, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return requests.length === 1
      ? Response.json({
          models: [
            { name: "models/gemini-first", baseModelId: "gemini-first", displayName: "Gemini First", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-embedding", supportedGenerationMethods: ["embedContent"] }
          ],
          nextPageToken: "next-page"
        })
      : Response.json({ models: [{ name: "models/gemini-second", supported_actions: ["generateContent"] }] });
  });

  const provider = new GeminiProvider({
    baseUrl: "https://generativelanguage.googleapis.test", apiKey: "gemini-key", model: "gemini-first", timeoutMs: 1000
  }, logger);
  const models = await provider.listModels();

  assert.deepEqual(models.map((model) => model.id), ["gemini-first", "gemini-second"]);
  assert.match(requests[0].url, /\/v1beta\/models\?pageSize=1000/);
  assert.match(requests[1].url, /pageToken=next-page/);
  assert.equal(requests[0].headers.get("x-goog-api-key"), "gemini-key");
});
