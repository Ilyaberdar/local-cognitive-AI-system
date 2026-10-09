import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentLoopRunner } from "../src/agents/runtime/AgentLoopRunner";
import { withReasoningEffort } from "../src/llm/InferenceThinking";
import { LLMRegistry } from "../src/llm/LLMRegistry";
import { LLMService } from "../src/llm/LLMService";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { OutputSanitizer } from "../src/llm/OutputSanitizer";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { OperationExecutor } from "../src/tools/OperationExecutor";
import type { ExecutionContext, LLMRequest, ReasoningEffort } from "../src/types";
import { Logger } from "../src/utils/Logger";

test("a chat turn's effort reaches every model call in it: a local model's thinking budget and the effort itself", async () => {
  const seen: LLMRequest[] = [];
  const registry = new LLMRegistry();
  registry.register({ id: "llamacpp", name: "Local", defaultModel: "qwen", isConfigured: () => true,
    getDescriptor: () => ({ id: "llamacpp", name: "Local", defaultModel: "qwen", configured: true }),
    generateText: async (request: LLMRequest) => { seen.push(request); return { provider: "llamacpp", model: "qwen", text: "ok" }; } } as never);
  const service = new LLMService(registry, "llamacpp", new Logger(), new OutputSanitizer());
  await withReasoningEffort("high", () => service.generateText({ prompt: "judge this" }, "llamacpp"));
  await service.generateText({ prompt: "outside a turn" }, "llamacpp");
  await withReasoningEffort("max", () => service.generateText({ prompt: "explicit", localReasoningBudget: 0 }, "llamacpp"));
  assert.deepEqual(seen.map(request => [request.reasoningEffort, request.localReasoningBudget]), [["high", 1024], [undefined, undefined], ["max", 0]]);
});

test("the agent's thinking budget per step follows the chat's effort, with room left for the action", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-effort-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const settings = await new SessionSettingsStore({ baseDir: root }, { providerId: "llamacpp", model: "qwen" }, {}).get("chat");
  const budgets: Array<[number | undefined, number | undefined]> = [];
  const llm = {
    getContextWindow: () => 32768,
    generateObject: async (request: LLMRequest) => {
      budgets.push([request.localReasoningBudget, request.maxTokens]);
      return { data: { type: "final", text: "Done." }, response: { provider: "llamacpp", model: "qwen", text: '{"type":"final","text":"Done."}' } };
    }
  } as unknown as LLMService;
  const runner = new AgentLoopRunner(llm, new OperationExecutor(root), root);
  for (const effort of ["low", "medium", "max"] as ReasoningEffort[]) {
    const context: ExecutionContext = { actor: { sessionId: "chat", channel: "http" }, memory: [], conversation: [], providerId: "llamacpp",
      activeTarget: { providerId: "llamacpp", model: "qwen" }, sessionSettings: { ...settings, reasoningEffort: effort },
      workspace: { version: 1, kind: "project", projectId: "p", rootPath: root, outputDir: root, allowedDirectories: [root], memoryScope: "project:p" } };
    await runner.run({ id: `effort-${effort}:agent:main`, input: "Answer.", instructions: "", context, target: context.activeTarget });
  }
  assert.deepEqual(budgets, [[128, 4224], [512, 4608], [4096, 8192]]);
});

test("cloud APIs get an effort they take; a model that refuses one is asked without it", async () => {
  const calls: Array<{ url: string; body: Record<string, any> }> = [];
  let refuse = 0;
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (refuse > 0) { refuse--; return Response.json({ error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model." } }, { status: 400 }); }
    return String(url).endsWith("/responses")
      ? Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
      : Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  const openai = new OpenAICompatibleProvider({ id: "openai", name: "OpenAI", model: "gpt", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", timeoutMs: 1000 }, new Logger(), transport);
  await openai.generateText({ prompt: "x", reasoningEffort: "max" });
  assert.deepEqual(calls.at(-1)!.body.reasoning, { effort: "max" }, "OpenAI's reasoning models take max");
  refuse = 1;
  assert.equal((await openai.generateText({ prompt: "y", reasoningEffort: "low" })).text, "ok");
  assert.deepEqual(calls.slice(-2).map(call => call.body.reasoning), [{ effort: "low" }, undefined], "asked again without it");
  await openai.generateText({ prompt: "z", reasoningEffort: "low" });
  assert.equal(calls.at(-1)!.body.reasoning, undefined, "and from then on for that model");

  const lmstudio = new OpenAICompatibleProvider({ id: "lmstudio", name: "LM Studio", model: "gpt-oss", baseUrl: "http://127.0.0.1:1/v1", timeoutMs: 1000 }, new Logger(), transport);
  await lmstudio.generateText({ prompt: "act", outputPurpose: "agent-action", reasoningEffort: "medium" });
  assert.match(calls.at(-1)!.url, /chat\/completions$/);
  assert.equal(calls.at(-1)!.body.reasoning_effort, "medium");

  const local = new OpenAICompatibleProvider({ id: "llamacpp", name: "Local", model: "qwen", baseUrl: "http://127.0.0.1:1/v1", timeoutMs: 1000 }, new Logger(), transport);
  await local.generateText({ prompt: "think", reasoningEffort: "high", localReasoningBudget: 1024 });
  assert.equal(calls.at(-1)!.body.reasoning_budget_tokens, 1024);
  assert.equal("reasoning_effort" in calls.at(-1)!.body || "reasoning" in calls.at(-1)!.body, false, "a local model's effort is its thinking budget");
});
