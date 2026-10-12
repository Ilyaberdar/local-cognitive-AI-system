import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AnthropicProvider } from "../src/llm/AnthropicProvider";
import { GeminiProvider } from "../src/llm/GeminiProvider";
import { OllamaProvider } from "../src/llm/OllamaProvider";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import type { LLMRequest } from "../src/types";
import { Logger } from "../src/utils/Logger";

// What the OpenAI-compatible client sends and returns for OpenAI, LM Studio and llama.cpp, and what
// every built-in provider says it can do, recorded from the code before providers became data.
// The recording is the contract: a change to any of these requests must be deliberate. Record again
// with RECORD_PROVIDER_FIXTURES=1 only when a change is meant.
const FIXTURE = path.resolve(process.cwd(), "test/fixtures/provider-requests.json");
const RECORD = process.env.RECORD_PROVIDER_FIXTURES === "1";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const tool = { name: "read_file", action: "read", optionalArguments: [], description: "Read a file", parameters: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 200 } }, required: ["path"], additionalProperties: false } };
const schema = { type: "object", properties: { answer: { type: "string", maxLength: 50 } }, required: ["answer"], additionalProperties: false };

const requests: Array<[string, LLMRequest]> = [
  ["prose", { prompt: "Say hi" }],
  ["prose with system, cap, temperature and effort", { prompt: "Say hi", systemPrompt: "Be brief.", maxTokens: 1200, temperature: 0.3, reasoningEffort: "medium" }],
  ["prose with xhigh effort", { prompt: "Say hi", reasoningEffort: "xhigh" }],
  ["json object", { prompt: "Answer in JSON", responseFormat: { type: "json_object" } }],
  ["json schema", { prompt: "Answer in JSON", responseFormat: { type: "json_schema", name: "answer", schema, strict: true } }],
  ["agent action with tools", { prompt: "Read a.txt", systemPrompt: "You are an agent.", outputPurpose: "agent-action", tools: [tool], maxTokens: 4000 }],
  ["agent action with continuation", { prompt: "Continue", outputPurpose: "agent-action", tools: [tool], inputItems: [{ type: "function_call_output", call_id: "c1", output: "contents" }], previousResponseId: "resp_0" }],
  ["image", { prompt: "What is this?", images: [{ dataUrl: PNG }] }],
  ["sampling", { prompt: "Say hi", sampling: { temperature: 0.6, topP: 0.9, topK: 20, minP: 0.05, repeatPenalty: 1.1, seed: 7 } }],
  ["thinking budget 0", { prompt: "Say hi", localReasoningBudget: 0 }],
  ["thinking budget 256", { prompt: "Say hi", localReasoningBudget: 256, reasoningEffort: "high" }],
  ["streamed prose", { prompt: "Say hi", onTextDelta: () => undefined }]
];

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** A fake HTTP endpoint answering as the API the URL names; `answer` replaces the reply for a call. */
function endpoint(answer?: (call: Call, index: number) => Response | undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).sort(([a], [b]) => a.localeCompare(b)));
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    const custom = answer?.(call, calls.length - 1);
    if (custom) return custom;
    if (call.url.endsWith("/models")) return Response.json({ data: [{ id: "model-a" }, { id: "model-b" }, {}] });
    if (call.url.endsWith("/responses")) {
      const body = call.body as Record<string, unknown>;
      const output = body.tools
        ? [{ type: "reasoning", id: "rs_1", encrypted_content: "enc" }, { type: "function_call", call_id: "c1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" }]
        : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello from Responses" }] }];
      return Response.json({ id: "resp_1", status: "completed", output, usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } },
        { headers: { "x-ratelimit-remaining-requests": "99" } });
    }
    return Response.json({ id: "chat_1", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{\"answer\":\"Hello from chat\"}" } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const compatible = (id: string, fetchImpl: typeof fetch, apiKey: string | undefined = "test-key") =>
  new OpenAICompatibleProvider({ id, name: id, baseUrl: `https://${id}.example/v1/`, model: `${id}-model`, timeoutMs: 600000, ...(apiKey ? { apiKey } : {}) }, new Logger(), fetchImpl);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === "raw" || typeof item === "function" ? undefined : item));

async function record() {
  const out: Record<string, unknown> = {};
  for (const id of ["openai", "lmstudio", "llamacpp"]) {
    for (const [name, request] of requests) {
      const { calls, fetchImpl } = endpoint();
      const response = await compatible(id, fetchImpl).generateText({ ...request });
      out[`${id} · ${name}`] = { calls, response: plain(response) };
    }
    const models = endpoint();
    out[`${id} · models`] = { calls: models.calls, models: await compatible(id, models.fetchImpl).listModels(), calls_after: models.calls.length };
    out[`${id} · configured`] = { withKey: compatible(id, endpoint().fetchImpl).isConfigured(), withoutKey: compatible(id, endpoint().fetchImpl, undefined).isConfigured() };
    out[`${id} · descriptor`] = plain(compatible(id, endpoint().fetchImpl).getDescriptor());
    // Retried on an overload that says when (OpenAI only), and asked again without an effort the model refuses.
    const overloaded = endpoint((_, index) => index === 0 ? new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } }) : undefined);
    const afterOverload = await compatible(id, overloaded.fetchImpl).generateText({ prompt: "Say hi" });
    out[`${id} · overload`] = { requests: overloaded.calls.length, text: afterOverload.text, error: afterOverload.error ?? null };
    const refusing = endpoint((call, index) => index === 0 ? Response.json({ error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.", param: "reasoning.effort" } }, { status: 400 }) : undefined);
    const provider = compatible(id, refusing.fetchImpl);
    await provider.generateText({ prompt: "Say hi", reasoningEffort: "high" });
    await provider.generateText({ prompt: "Say hi again", reasoningEffort: "high" });
    out[`${id} · refused effort`] = { calls: refusing.calls.map(call => call.body) };
    const failing = endpoint(() => Response.json({ error: { message: "Invalid API key" } }, { status: 401 }));
    out[`${id} · auth error`] = plain(await compatible(id, failing.fetchImpl).generateText({ prompt: "Say hi" }));
  }
  const logger = new Logger();
  out["anthropic · descriptor"] = plain(new AnthropicProvider({ baseUrl: "https://api.anthropic.com", model: "claude-x", timeoutMs: 1000, apiKey: "k", version: "2023-06-01", maxTokens: 16000 }, logger).getDescriptor());
  out["gemini · descriptor"] = plain(new GeminiProvider({ baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-x", timeoutMs: 1000, apiKey: "k" }, logger).getDescriptor());
  out["ollama · descriptor"] = plain(new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", model: "llama", timeoutMs: 1000 }, logger).getDescriptor());
  return out;
}

test("OpenAI, LM Studio and llama.cpp requests and every built-in provider's capabilities stay as recorded", async () => {
  const actual = await record();
  if (RECORD) { fs.writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 1)}\n`); return; }
  const expected = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const key of Object.keys(expected)) assert.deepEqual(actual[key], expected[key], key);
});
