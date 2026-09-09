import assert from "node:assert/strict";
import test from "node:test";
import { Request, Response as ExpressResponse } from "express";
import { createProviderTestController } from "../src/api/controller";
import { RuntimeManager } from "../src/app/RuntimeManager";
import { Judge } from "../src/judge/Judge";
import { LanguageEnforcer } from "../src/llm/LanguageEnforcer";
import { LLMService } from "../src/llm/LLMService";
import { LMStudioManager } from "../src/llm/LMStudioManager";
import { LocalModelManagerRegistry } from "../src/llm/LocalModelManager";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { readResponseText } from "../src/llm/provider-utils";
import { Logger } from "../src/utils/Logger";
import { AgentDebateResponse } from "../src/types";

test("LM Studio loading has its own budget and does not load an existing instance again", async (t) => {
  let loaded = false; let loads = 0; const timeouts: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => { timeouts.push(ms); return new AbortController().signal; });
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/models/load")) { loads++; loaded = true; return Response.json({ status: "loaded", instance_id: "tiny" }); }
    return Response.json({ models: [{ key: "tiny", loaded_instances: loaded ? [{ id: "tiny" }] : [] }] });
  });
  const manager = new LMStudioManager({ baseUrl: "http://127.0.0.1:1234/v1", timeoutMs: 20000 });
  await manager.loadModel("tiny");
  await manager.loadModel("tiny");
  assert.equal(loads, 1);
  assert.deepEqual(timeouts, [10000, 300000, 10000]);
});

test("concurrent local model loads share one operation and a failed load can be retried", async () => {
  let finish!: () => void; let calls = 0;
  const registry = new LocalModelManagerRegistry([{
    providerId: "local", providerName: "Local", listAllModels: async () => [], listLoadedModels: async () => [],
    unloadModel: async () => {}, loadModel: async () => { calls++; if (calls === 1) await new Promise<void>((resolve) => { finish = resolve; }); else if (calls === 2) throw new Error("load failed"); }
  }]);
  const first = registry.loadModel("local", "tiny");
  const duplicate = registry.loadModel("local", "tiny");
  assert.equal(first, duplicate);
  await Promise.resolve(); finish(); await first;
  await assert.rejects(registry.loadModel("local", "tiny"), /load failed/);
  await registry.loadModel("local", "tiny");
  assert.equal(calls, 3);
});

test("Responses parsing finds the final answer after an empty output_text and excludes reasoning", () => {
  assert.equal(readResponseText({ output_text: "", output: [
    { type: "reasoning", content: [{ type: "text", text: "private reasoning" }] },
    { type: "message", role: "assistant", content: [{ type: "reasoning_text", text: "more reasoning" }, { type: "output_text", text: "Final story" }] }
  ] }), "Final story");
});

test("reasoning-only and incomplete responses return explicit errors without fabricated output", async (t) => {
  const provider = new OpenAICompatibleProvider({ id: "lmstudio", name: "LM Studio", model: "tiny", baseUrl: "http://127.0.0.1:1234/v1", timeoutMs: 300000 }, new Logger());
  for (const status of ["completed", "incomplete"]) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ status, incomplete_details: { reason: "max_output_tokens" }, output: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "unfinished thinking" }] }
    ] }));
    const response = await provider.generateText({ prompt: "Tell me a story" });
    assert.equal(response.text, "");
    assert.match(response.error ?? "", status === "incomplete" ? /max_output_tokens/ : /no final answer/);
    mock.mock.restore();
  }
});

test("provider transport errors remain errors without returning mock prompt digests", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("connection refused"); });
  const provider = new OpenAICompatibleProvider({ id: "lmstudio", name: "LM Studio", model: "tiny", baseUrl: "http://127.0.0.1:1234/v1", timeoutMs: 300000 }, new Logger());
  const response = await provider.generateText({ prompt: "private request" });
  assert.equal(response.text, "");
  assert.equal(response.error, "connection refused");
});

test("the provider connection check rejects explicit errors and empty final answers", async () => {
  for (const response of [
    { provider: "lmstudio", model: "tiny", text: "", error: "connection refused" },
    { provider: "lmstudio", model: "tiny", text: "partial", error: "Response incomplete" },
    { provider: "lmstudio", model: "tiny", text: "   " }
  ]) {
    const runtimeManager = {
      getRuntime: () => ({ llmService: { generateText: async () => response } }),
      getSettings: async () => ({ providers: { lmstudio: { enabled: true, model: "tiny" } } })
    } as unknown as RuntimeManager;
    let result: { ok: boolean; message: string } | undefined;
    const res = {
      status(code: number) { assert.equal(code, 200); return this; },
      json(body: typeof result) { result = body; }
    } as unknown as ExpressResponse;
    await createProviderTestController(runtimeManager)(
      { params: { providerId: "lmstudio" } } as unknown as Request,
      res,
      (error) => { throw error; }
    );
    assert.equal(result?.ok, false);
    assert.equal(result?.message, response.error || "Provider returned no usable final answer.");
  }
});

test("judge diagnostics report provider failures even when incomplete output contains valid JSON", async () => {
  const support: AgentDebateResponse = { agent: "SupportAgent", stance: "pro", provider: "lmstudio", model: "tiny", summary: "Support", arguments: ["Pro"], raw: "Support" };
  const attack: AgentDebateResponse = { ...support, agent: "AttackAgent", stance: "contra", summary: "Attack", arguments: ["Contra"] };
  for (const data of [null, { verdict: "attack", confidence: 0.9, reasoning: "Reason", conclusion: "Conclusion" }]) {
    const llm = {
      generateObject: async () => ({ data, response: {
        provider: "lmstudio", model: "tiny", text: data ? JSON.stringify(data) : "", error: "Response incomplete"
      } })
    } as unknown as LLMService;
    const result = await new Judge(llm, new LanguageEnforcer(llm)).evaluate(
      "Hypothesis", [support, attack], { providerId: "lmstudio", model: "tiny" }, "general", "auto", "compact"
    );
    assert.equal(result.participants.judge, "local");
    assert.equal(result.fallback?.used, true);
    assert.equal(result.diagnostics?.judge.providerCall, "failed");
    assert.equal(result.diagnostics?.judge.structuredOutput, "rejected");
    assert.equal(result.diagnostics?.judge.providerError, "Response incomplete");
  }
});
