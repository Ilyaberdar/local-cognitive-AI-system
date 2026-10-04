import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeLocalGenerationSettings, preciseLocalGenerationSettings, resolveLocalGenerationSettings } from "../src/local/GenerationSettings";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { Logger } from "../src/utils/Logger";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";

test("local generation profiles preserve server defaults and resolve an explicit custom sampler", () => {
  assert.deepEqual(resolveLocalGenerationSettings({ preset: "server" }), { sampling: {} });
  assert.deepEqual(resolveLocalGenerationSettings({ preset: "precise" }), {
    sampling: { temperature: 0.2, topP: 0.9, topK: 40, minP: 0.05, repeatPenalty: 1.05 },
    maxTokens: 1024
  });
  assert.deepEqual(normalizeLocalGenerationSettings({
    preset: "custom", temperature: 0.63, topP: 0.92, topK: 55, minP: 0.08, repeatPenalty: 1.12, maxTokens: 1600, seed: 7
  }), { preset: "custom", temperature: 0.63, topP: 0.92, topK: 55, minP: 0.08, repeatPenalty: 1.12, maxTokens: 1600, seed: 7 });
  assert.deepEqual(preciseLocalGenerationSettings(), { preset: "precise" });
});

test("llama.cpp receives all local sampler fields on the chat-compatible endpoint", async () => {
  let received: Record<string, unknown> | undefined;
  const transport: typeof fetch = async (_url, init) => {
    received = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  const provider = new OpenAICompatibleProvider({
    id: "llamacpp", name: "Local", model: "tiny", baseUrl: "http://127.0.0.1:1/v1", timeoutMs: 1000
  }, new Logger(), transport);
  const response = await provider.generateText({
    prompt: "Reply with one word", localReasoningBudget: 512, maxTokens: 1600,
    sampling: { temperature: 0.63, topP: 0.92, topK: 55, minP: 0.08, repeatPenalty: 1.12, seed: 7 }
  });
  assert.equal(response.text, "ok");
  assert.deepEqual(received, {
    model: "tiny", messages: [{ role: "user", content: "Reply with one word" }], max_tokens: 1600,
    temperature: 0.63, top_p: 0.92, top_k: 55, min_p: 0.08, repeat_penalty: 1.12, seed: 7,
    reasoning_budget_tokens: 512
  });
});

test("chat effort survives reopening a local session and defaults old sessions to Balanced", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-effort-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const defaults = { providerId: "llamacpp", model: "tiny" };
  const first = new SessionSettingsStore({ baseDir: root }, defaults, { llamacpp: "tiny" });
  assert.equal((await first.get("chat")).reasoningEffort, "medium");
  await first.update("chat", { reasoningEffort: "max" });
  const reopened = new SessionSettingsStore({ baseDir: root }, defaults, { llamacpp: "tiny" });
  assert.equal((await reopened.get("chat")).reasoningEffort, "max");
});
