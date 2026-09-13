import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { Logger } from "../src/utils/Logger";

const provider = () => new OpenAICompatibleProvider({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-6-astra", timeoutMs: 600000, apiKey: "test-key" }, new Logger());

test("Responses passes reasoning and the caller's exact output budget", async (t) => {
  let body: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return Response.json({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Final answer" }] }] });
  });
  const response = await provider().generateText({ prompt: "hi", maxTokens: 1200, temperature: 0.5, reasoningEffort: "high", responseFormat: { type: "json_object" } });
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.equal(body.max_output_tokens, 1200);
  assert.equal(body.temperature, undefined);
  assert.equal(response.text, "Final answer");
  assert.deepEqual(body.text, { format: { type: "json_object" } });
});

test("OpenAI reports access and quota errors with the provider's explanation", async (t) => {
  for (const status of [401, 403, 429]) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: `Access error ${status}` } }, { status }));
    const response = await provider().generateText({ prompt: "hello" });
    assert.equal(response.text, "");
    assert.match(response.error!, new RegExp(`HTTP ${status}.*Access error ${status}`));
    mock.mock.restore();
  }
});

test("OpenAI is not configured without an API key", () => {
  const instance = new OpenAICompatibleProvider({ id: "openai", name: "OpenAI", model: "example", baseUrl: "https://api.openai.com/v1", timeoutMs: 1000 }, new Logger());
  assert.equal(instance.isConfigured(), false);
});
