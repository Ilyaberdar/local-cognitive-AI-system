import assert from "node:assert/strict";
import test from "node:test";
import { readUsage } from "../src/llm/provider-utils";

test("every provider's token report reads into one shape, and nothing unreported becomes 0", () => {
  // OpenAI chat completions, cached prompt and reasoning as parts of input and output.
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140,
    prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 30 } } }),
  { inputTokens: 100, outputTokens: 40, totalTokens: 140, cachedInputTokens: 64, reasoningTokens: 30 });
  // OpenAI Responses.
  assert.deepEqual(readUsage({ usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15,
    input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } } }),
  { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0, reasoningTokens: 2 });
  // Anthropic: its input excludes the cache, and there is no total.
  assert.deepEqual(readUsage({ usage: { input_tokens: 20, cache_creation_input_tokens: 1000, cache_read_input_tokens: 3000, output_tokens: 50 } }),
    { inputTokens: 4020, outputTokens: 50, totalTokens: 4070, cachedInputTokens: 3000, cacheWriteTokens: 1000 });
  // Gemini: thoughts are outside the candidates; the tool-use prompt is input.
  assert.deepEqual(readUsage({ usageMetadata: { promptTokenCount: 120, cachedContentTokenCount: 100, candidatesTokenCount: 30,
    thoughtsTokenCount: 70, toolUsePromptTokenCount: 5, totalTokenCount: 225 } }),
  { inputTokens: 125, outputTokens: 100, totalTokens: 225, cachedInputTokens: 100, reasoningTokens: 70 });
  // Ollama's /api/generate; a fully cached prompt may leave its count out.
  assert.deepEqual(readUsage({ response: "hi", prompt_eval_count: 26, eval_count: 290 }), { inputTokens: 26, outputTokens: 290, totalTokens: 316 });
  assert.deepEqual(readUsage({ response: "hi", eval_count: 290 }), { outputTokens: 290 }, "an unknown input leaves the total unknown");
  // llama.cpp: usage first, its timings fill the gaps.
  assert.deepEqual(readUsage({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 }, timings: { prompt_n: 10, cache_n: 40, predicted_n: 8 } }),
    { inputTokens: 50, outputTokens: 8, totalTokens: 58, cachedInputTokens: 40 });
  assert.deepEqual(readUsage({ choices: [], timings: { prompt_n: 10, cache_n: 40, predicted_n: 8 } }),
    { inputTokens: 50, outputTokens: 8, totalTokens: 58, cachedInputTokens: 40 });
  // Nothing reported, or nonsense.
  assert.equal(readUsage({ choices: [] }), undefined);
  assert.equal(readUsage({ usage: {} }), undefined);
  assert.equal(readUsage({ usage: { prompt_tokens: -1, completion_tokens: "7" } }), undefined);
  assert.equal(readUsage(null), undefined);
});
