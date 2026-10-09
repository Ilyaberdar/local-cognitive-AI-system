import assert from "node:assert/strict";
import test from "node:test";
import { LLMRegistry } from "../src/llm/LLMRegistry";
import { LLMService } from "../src/llm/LLMService";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { OutputSanitizer } from "../src/llm/OutputSanitizer";
import { usageModelName, UsageAttemptRecord } from "../src/usage/UsageCall";
import { withUsageScope } from "../src/usage/UsageScope";
import { Logger } from "../src/utils/Logger";

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const answer = (usage?: Record<string, number>) => reply(200, { id: "r", output: [{ type: "message", content: [{ type: "output_text", text: "fine" }] }], ...(usage ? { usage } : {}) });

const setup = (transport: typeof fetch) => {
  const records: UsageAttemptRecord[] = [];
  const registry = new LLMRegistry();
  registry.register(new OpenAICompatibleProvider({ id: "openai", name: "OpenAI", model: "gpt-x", baseUrl: "https://api.example/v1", apiKey: "k", timeoutMs: 5000 }, new Logger(), transport));
  registry.register({ id: "plain", name: "Plain", defaultModel: "p", isConfigured: () => true,
    getDescriptor: () => ({ id: "plain", name: "Plain", defaultModel: "p", configured: true }),
    generateText: async request => request.prompt === "fail" ? { provider: "plain", model: "p", text: "", error: "not loaded" }
      : { provider: "plain", model: "p", text: request.prompt === "silent" ? "x" : "{\"a\":1}", ...(request.prompt === "silent" ? {} : { usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }) } });
  const llm = new LLMService(registry, "openai", new Logger(), new OutputSanitizer(), { record: attempts => records.push(...attempts) });
  return { llm, records };
};

test("every request a call sends is in the ledger: retries are refused requests, the answer carries the tokens", async () => {
  const queue: Array<Response | Error> = [reply(503, { error: "overloaded" }, { "retry-after": "0" }), new TypeError("fetch failed"), answer({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })];
  const { llm, records } = setup((async () => { const next = queue.shift()!; if (next instanceof Error) throw next; return next; }) as typeof fetch);
  await withUsageScope({ origin: "chat", sessionId: "s1" }, () => withUsageScope({ runId: "r1" }, () => llm.generateText({ prompt: "hi", usagePurpose: "judge" })));
  assert.deepEqual(records.map(record => [record.attempt, record.outcome, record.httpStatus, record.usageSource, record.usage?.totalTokens]),
    [[1, "rejected", 503, "unknown", undefined], [2, "failed", undefined, "unknown", undefined], [3, "completed", 200, "reported", 15]]);
  assert.equal(new Set(records.map(record => record.callId)).size, 1);
  assert.equal(new Set(records.map(record => record.eventId)).size, 3);
  assert.deepEqual(records[2]!.scope, { origin: "chat", sessionId: "s1", runId: "r1", purpose: "judge" });
  assert.equal(records[2]!.provider, "openai");
  assert.equal(records[2]!.model, "gpt-x");
  assert.equal(JSON.stringify(records).includes("hi"), false, "no prompt text");
});

test("a request repeated without an unsupported effort is a request of its own", async () => {
  const queue = [reply(400, { error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.", param: "reasoning.effort" } }), answer({ input_tokens: 2, output_tokens: 1, total_tokens: 3 })];
  const { llm, records } = setup((async () => queue.shift()!) as typeof fetch);
  await llm.generateText({ prompt: "hi", reasoningEffort: "high" });
  assert.deepEqual(records.map(record => [record.attempt, record.outcome, record.httpStatus, record.usage?.totalTokens]), [[1, "rejected", 400, undefined], [2, "completed", 200, 3]]);
});

test("an answer that arrives as the user cancels keeps its tokens; a cancelled request stays unknown", async () => {
  const controller = new AbortController();
  let { llm, records } = setup((async () => { controller.abort(); return answer({ input_tokens: 8, output_tokens: 2, total_tokens: 10 }); }) as typeof fetch);
  await assert.rejects(llm.generateText({ prompt: "hi", signal: controller.signal }));
  assert.deepEqual(records.map(record => [record.outcome, record.usage?.totalTokens]), [["completed", 10]]);

  const second = new AbortController();
  ({ llm, records } = setup(((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    setTimeout(() => second.abort(), 5);
  })) as typeof fetch));
  await assert.rejects(llm.generateText({ prompt: "hi", signal: second.signal }));
  assert.deepEqual(records.map(record => [record.outcome, record.usageSource]), [["cancelled", "unknown"]]);
});

test("a call that sent nothing is not recorded; an answer without a token report is unknown", async () => {
  const { llm, records } = setup((async () => answer()) as typeof fetch);
  await llm.generateText({ prompt: "ok" }, "plain");
  await llm.generateText({ prompt: "silent" }, "plain");
  await llm.generateText({ prompt: "fail" }, "plain");
  assert.deepEqual(records.map(record => [record.provider, record.outcome, record.usageSource, record.usage?.totalTokens]),
    [["plain", "completed", "reported", 7], ["plain", "completed", "unknown", undefined]]);
  await llm.generateText({ prompt: "hi" });
  assert.equal(records.at(-1)!.usageSource, "unknown", "an answer without a token report is unknown, never 0");
  assert.equal(records.at(-1)!.usage, undefined);
});

test("a local model's file path is not part of the recorded model name", () => {
  assert.equal(usageModelName("/Users/someone/models/qwen3-8b.gguf"), "qwen3-8b.gguf");
  assert.equal(usageModelName("C:\\models\\a.gguf"), "a.gguf");
  assert.equal(usageModelName("openai/gpt-4o"), "openai/gpt-4o");
  assert.equal(usageModelName("x".repeat(300)).length, 128);
  assert.equal(usageModelName(""), "unknown");
});
