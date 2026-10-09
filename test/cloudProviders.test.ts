import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicProvider } from "../src/llm/AnthropicProvider";
import { GeminiProvider } from "../src/llm/GeminiProvider";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { fetchWithRetries } from "../src/llm/provider-utils";
import { Logger } from "../src/utils/Logger";

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("cloud requests are retried on overload and rate limits that say when, never on a spending limit", async () => {
  const run = async (responses: Array<Response | Error>) => {
    let calls = 0;
    const fetchImpl = (async () => { const next = responses[calls++]!; if (next instanceof Error) throw next; return next; }) as typeof fetch;
    const response = await fetchWithRetries(fetchImpl, "https://api.example/x", { method: "POST", body: "{}" });
    return { status: response.status, calls };
  };
  assert.deepEqual(await run([reply(529, { error: "overloaded" }, { "retry-after": "0" }), reply(200, {})]), { status: 200, calls: 2 });
  assert.deepEqual(await run([new TypeError("fetch failed"), reply(200, {})]), { status: 200, calls: 2 }, "a dropped connection");
  assert.deepEqual(await run([reply(429, { error: "quota" })]), { status: 429, calls: 1 }, "no retry-after: a spending limit");
  assert.deepEqual(await run([reply(429, {}, { "retry-after-ms": "5" }), reply(429, {}, { "retry-after-ms": "5" }), reply(429, {}, { "retry-after-ms": "5" })]), { status: 429, calls: 3 }, "at most two retries");
  assert.deepEqual(await run([reply(400, { error: "bad" })]), { status: 400, calls: 1 });
  const controller = new AbortController();
  const waiting = fetchWithRetries((async () => reply(503, {}, { "retry-after": "20" })) as typeof fetch, "https://api.example/x", { signal: controller.signal });
  controller.abort(new Error("stopped"));
  await assert.rejects(waiting, /stopped/, "a cancelled request stops waiting");
});

test("OpenAI: strict tool schemas without length limits, a cap that leaves room for reasoning, and fallbacks for older models", async () => {
  const bodies: Array<Record<string, any>> = [];
  const queue: Response[] = [];
  const ok = () => reply(200, { output: [{ type: "message", content: [{ type: "output_text", text: '{"type":"final","text":"ok"}' }] }] });
  const transport = (async (_url: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return queue.shift() ?? ok(); }) as typeof fetch;
  const provider = new OpenAICompatibleProvider({ id: "openai", name: "OpenAI", model: "gpt-x", baseUrl: "https://api.example/v1", apiKey: "k", timeoutMs: 5000 }, new Logger(), transport);
  const tool = { name: "file_write", action: "file.write", description: "Write", optionalArguments: [],
    parameters: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["path"], additionalProperties: false } };
  await provider.generateText({ prompt: "act", outputPurpose: "agent-action", tools: [tool], maxTokens: 1200, reasoningEffort: "max" });
  const first = bodies.at(-1)!;
  assert.deepEqual(first.tools[0].parameters.properties.path, { type: "string" });
  assert.equal(first.max_output_tokens, 16000);
  assert.deepEqual(first.reasoning, { effort: "max" });
  assert.deepEqual(first.include, ["reasoning.encrypted_content"]);
  // A model that offers effort only up to high, and one that has no encrypted reasoning.
  queue.push(reply(400, { error: { message: "Unsupported value: 'max' is not supported. Supported values are: 'low', 'medium' and 'high'.", param: "reasoning.effort" } }),
    reply(400, { error: { message: "Encrypted content is not supported with this model.", param: "include" } }));
  await provider.generateText({ prompt: "act", outputPurpose: "agent-action", tools: [tool], reasoningEffort: "max" });
  assert.deepEqual(bodies.at(-1)!.reasoning, { effort: "high" });
  assert.equal("include" in bodies.at(-1)!, false);
});

test("Anthropic: a thinking model's continuation falls back to JSON; a full context window is an error", async t => {
  const answers: Response[] = [];
  t.mock.method(globalThis, "fetch", async () => answers.shift()!);
  const provider = new AnthropicProvider({ id: "anthropic", name: "Anthropic", model: "claude", baseUrl: "https://api.example", apiKey: "k", timeoutMs: 5000, version: "2023-06-01", maxTokens: 16000 } as never, new Logger());
  answers.push(reply(400, { type: "error", error: { type: "invalid_request_error", message: "messages.1.content.0: Invalid `signature` in `thinking` block" } }));
  const response = await provider.generateText({ prompt: "step", outputPurpose: "agent-action", tools: [], inputItems: [{ type: "function_call_output", call_id: "1", output: "x" }] } as never);
  assert.equal(response.unsupportedFeature, "tools");
  answers.push(reply(200, { id: "m", content: [{ type: "text", text: "partial" }], stop_reason: "model_context_window_exceeded", usage: {} }));
  assert.match((await provider.generateText({ prompt: "long" })).error ?? "", /model_context_window_exceeded/);
  answers.push(reply(529, { type: "error", error: { type: "overloaded_error" } }, { "retry-after": "0" }), reply(200, { id: "m", content: [{ type: "text", text: "fine" }], stop_reason: "end_turn", usage: {} }));
  assert.equal((await provider.generateText({ prompt: "again" })).text, "fine", "an overload is retried");
});

test("Gemini: the model name is a path segment, and a small token cap leaves room for thinking", async t => {
  const seen: Array<{ url: string; body: Record<string, any> }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return reply(200, { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] });
  });
  const provider = new GeminiProvider({ id: "gemini", name: "Gemini", model: "gemini-2.5-flash", baseUrl: "https://api.example", apiKey: "k", timeoutMs: 5000 } as never, new Logger());
  await provider.generateText({ prompt: "x", model: "gemini-2.5-flash?alt=evil#", maxTokens: 1200 });
  assert.match(seen[0]!.url, /models\/gemini-2\.5-flash%3Falt%3Devil%23:generateContent$/);
  assert.equal(seen[0]!.body.generationConfig.maxOutputTokens, 8192);
});
