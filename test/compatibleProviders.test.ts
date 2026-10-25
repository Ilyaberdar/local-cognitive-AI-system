import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { buildSync } from "esbuild";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import { keyVault } from "./fixtures/keyVault";
import type { RuntimeManager } from "../src/app/RuntimeManager";
import { validateSettingsPatch } from "../src/app/settingsValidation";
import { config } from "../src/config/config";
import { childProcessEnv, SECRET_ENV_KEYS } from "../src/config/secrets";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { CHAT_DIALECT, QWEN_DIALECT, compatibleDialect, dialectFor } from "../src/llm/ProviderDialect";
import { BUILT_IN_PROVIDER_IDS, PROVIDER_PRESETS, providerPreset } from "../src/llm/providerCatalog";
import { RemoteOperationError, type OperationContext } from "../src/remote/host/RemoteHost";
import { createSettingsOperations } from "../src/runtime/settingsOperations";
import type { AppSettingsPatch, LLMRequest } from "../src/types";
import { Logger } from "../src/utils/Logger";
import { LLMRegistry } from "../src/llm/LLMRegistry";
import { LLMService } from "../src/llm/LLMService";
import { OutputSanitizer } from "../src/llm/OutputSanitizer";
import { unsupportedFeature } from "../src/llm/provider-utils";
import { agentFunctionTools } from "../src/tools/AgentTool";
import { readNativeAgentResponse } from "../src/llm/ResponseItems";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const SINGAPORE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

type Call = { url: string; headers: Record<string, string>; body: Record<string, any> };
const sse = (...chunks: unknown[]) => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const streamed = (answer: string, thinking = "") => sse(
  ...(thinking ? [{ choices: [{ index: 0, delta: { reasoning_content: thinking } }] }] : []),
  { choices: [{ index: 0, delta: { content: answer.slice(0, 3) } }] },
  { choices: [{ index: 0, delta: { content: answer.slice(3) }, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29, completion_tokens_details: { reasoning_tokens: 4 }, prompt_tokens_details: { cached_tokens: 5 } } });

function service(reply: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const call = { url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : {} };
    calls.push(call);
    return reply(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const qwen = (fetchImpl: typeof fetch, apiKey = "sk-qwen-test-key") =>
  new OpenAICompatibleProvider({ id: "qwen", name: "Qwen (Alibaba Cloud)", baseUrl: SINGAPORE, model: "qwen3.7-plus", timeoutMs: 60000, ...(apiKey ? { apiKey } : {}), dialect: QWEN_DIALECT }, new Logger(), fetchImpl);

test("Qwen: every request is a streamed chat completion with the key, and its thinking follows the effort", async () => {
  const { calls, fetchImpl } = service(() => streamed("Hello there", "Considering"));
  const provider = qwen(fetchImpl);
  const deltas: string[] = [], phases: string[] = [];
  const response = await provider.generateText({ prompt: "Say hi", systemPrompt: "Be brief.", maxTokens: 900, temperature: 0.4, reasoningEffort: "medium",
    onTextDelta: delta => deltas.push(delta), onProgress: event => phases.push(event.phase) });
  const [call] = calls;
  assert.equal(call.url, `${SINGAPORE}/chat/completions`);
  assert.equal(call.headers.Authorization, "Bearer sk-qwen-test-key");
  assert.equal(call.body.stream, true);
  assert.deepEqual(call.body.stream_options, { include_usage: true });
  assert.equal(call.body.enable_thinking, true);
  assert.equal(call.body.max_tokens, 900);
  assert.equal(call.body.temperature, 0.4);
  assert.deepEqual(call.body.messages, [{ role: "system", content: "Be brief." }, { role: "user", content: "Say hi" }]);
  for (const name of ["reasoning", "reasoning_effort", "input", "include", "store"]) assert.equal(call.body[name], undefined, name);
  assert.equal(response.text, "Hello there");
  assert.equal(response.error, undefined);
  assert.deepEqual(deltas.join(""), "Hello there");
  assert.ok(phases.includes("thinking") && phases.includes("responding"));
  assert.deepEqual(response.usage, { inputTokens: 20, outputTokens: 9, totalTokens: 29, cachedInputTokens: 5, reasoningTokens: 4 });

  // Low effort, or none (a helper call), turns thinking off; with thinking on the cap stays within 32768.
  await provider.generateText({ prompt: "Say hi", reasoningEffort: "low" });
  await provider.generateText({ prompt: "Say hi" });
  await provider.generateText({ prompt: "Say hi", reasoningEffort: "max", maxTokens: 40_000 });
  assert.equal(calls[1].body.enable_thinking, false);
  assert.equal(calls[2].body.enable_thinking, false);
  assert.equal(calls[3].body.enable_thinking, true);
  assert.equal(calls[3].body.max_tokens, 32_768);
});

test("Qwen: JSON mode says JSON in the instructions when the prompt does not; images go as data URLs", async () => {
  const { calls, fetchImpl } = service(() => streamed("{\"ok\":true}"));
  const provider = qwen(fetchImpl);
  const json = await provider.generateText({ prompt: "Classify this", systemPrompt: "You classify.", responseFormat: { type: "json_object" } });
  assert.equal(json.text, "{\"ok\":true}");
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.equal(calls[0].body.messages[0].content, "You classify.\n\nReply with a JSON object.");
  await provider.generateText({ prompt: "Answer in JSON", responseFormat: { type: "json_object" } });
  assert.equal(calls[1].body.messages.length, 1, "a prompt that names JSON is left as it is");
  await provider.generateText({ prompt: "What is this?", images: [{ dataUrl: PNG }] });
  assert.deepEqual(calls[2].body.messages[0].content, [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: PNG } }]);
});

test("Qwen: retried on an overload that says when, not configured without a key, errors keep the service's words", async () => {
  const overloaded = service((_, index) => index === 0 ? new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } }) : streamed("Recovered"));
  assert.equal((await qwen(overloaded.fetchImpl).generateText({ prompt: "Say hi" })).text, "Recovered");
  assert.equal(overloaded.calls.length, 2);
  assert.equal(qwen(overloaded.fetchImpl, "").isConfigured(), false);
  assert.equal(qwen(overloaded.fetchImpl).isConfigured(), true);
  const wrongRegion = service(() => Response.json({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 }));
  const response = await qwen(wrongRegion.fetchImpl).generateText({ prompt: "Say hi" });
  assert.match(response.error!, /HTTP 401.*Incorrect API key provided/);
  const descriptor = qwen(overloaded.fetchImpl).getDescriptor();
  assert.deepEqual(descriptor.capabilities, { local: false, managed: false, jsonMode: true, nativeTools: true, structuredOutputs: false, reasoning: true, vision: true });
});

test("Qwen lists its chat models, and its known models when the list cannot be read", async () => {
  const listing = service(() => Response.json({ data: [{ id: "qwen3.8-max" }, { id: "text-embedding-v4" }, { id: "qwen3-tts-flash" }, { id: "wan2.5-t2i" }, { id: "qwen3.7-plus" }] }));
  assert.deepEqual((await qwen(listing.fetchImpl).listModels()).map(model => model.id), ["qwen3.8-max", "qwen3.7-plus"]);
  assert.equal(listing.calls[0].url, `${SINGAPORE}/models`);
  assert.equal(listing.calls[0].headers.Authorization, "Bearer sk-qwen-test-key");
  const missing = service(() => new Response("not found", { status: 404 }));
  assert.deepEqual((await qwen(missing.fetchImpl).listModels()).map(model => model.id), QWEN_DIALECT.models!.fallback);
  await assert.rejects(qwen(missing.fetchImpl).listModels({ strict: true }), /status 404/, "adding a provider never mistakes a wrong address for its models");
  const empty = service(() => Response.json({ data: [] }));
  assert.equal((await qwen(empty.fetchImpl).listModels()).length, QWEN_DIALECT.models!.fallback.length);
});

// From a live run of twenty DeepSeek agents: one lost its task to "terminated", its answer cut off
// midway; another's action was refused for the reasoning DeepSeek had put before it.
test("a cloud answer the connection cuts off midway is asked for again, and reasoning before DeepSeek's end-of-thinking marker is not the answer", async () => {
  const cut = () => new Response(new ReadableStream({ start: controller => { controller.enqueue(new TextEncoder().encode('{"choices":[{"mess')); controller.error(new TypeError("terminated")); } }),
    { status: 200, headers: { "content-type": "application/json" } });
  const answer = '{"type":"tool_call","tool":"file.read","arguments":{"path":"a.ts"}}';
  const { calls, fetchImpl } = service((_call, index) => index === 0 ? cut()
    : Response.json({ choices: [{ message: { content: `${answer}\n\nWait, only the JSON object.<｜end▁of▁thinking｜>${answer}` }, finish_reason: "stop" }] }));
  const provider = new OpenAICompatibleProvider({ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", timeoutMs: 5000, apiKey: "sk-ds", dialect: compatibleDialect("deepseek") }, new Logger(), fetchImpl);
  const response = await provider.generateText({ prompt: "Read a.ts", outputPurpose: "agent-action", responseFormat: { type: "json_object" } });
  assert.equal(response.error, undefined);
  assert.equal(calls.length, 2, "asked once more");
  assert.equal(response.text, answer);
  // A local server is not asked twice: its answer is its own.
  const local = service(() => cut());
  const llama = new OpenAICompatibleProvider({ id: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", model: "m", timeoutMs: 5000, dialect: dialectFor("lmstudio") }, new Logger(), local.fetchImpl);
  assert.match((await llama.generateText({ prompt: "Hi" })).error ?? "", /terminated/);
  assert.equal(local.calls.length, 1);
});

test("any other OpenAI-compatible service sends prose to chat completions with its key, and nothing Qwen-specific", async () => {
  const { calls, fetchImpl } = service(() => Response.json({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  const provider = new OpenAICompatibleProvider({ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1/", model: "deepseek-chat", timeoutMs: 1000, apiKey: "sk-ds", dialect: compatibleDialect("chat") }, new Logger(), fetchImpl);
  const response = await provider.generateText({ prompt: "Say hi", reasoningEffort: "high", maxTokens: 100 });
  assert.equal(response.text, "Hi");
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(calls[0].body.stream, undefined);
  for (const name of ["enable_thinking", "reasoning_effort", "reasoning"]) assert.equal(calls[0].body[name], undefined, name);
  assert.equal(compatibleDialect("nonsense"), CHAT_DIALECT);
  assert.equal(new OpenAICompatibleProvider({ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "m", timeoutMs: 1000, dialect: CHAT_DIALECT }, new Logger()).isConfigured(), false);
});

async function storeIn(t: TestContext, stored?: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "compatible-providers-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (stored) await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(stored));
  return { root, store: new AppSettingsStore(root, config) };
}

test("every installation has Qwen as an OpenAI-compatible provider in Singapore, which stays Qwen", async t => {
  const fresh = await (await storeIn(t)).store.get();
  assert.deepEqual({ ...fresh.providers.qwen, apiKey: undefined }, { kind: "openai-compatible", dialect: "qwen", name: "Qwen (Alibaba Cloud)", enabled: true,
    baseUrl: SINGAPORE, apiKey: undefined, model: "qwen3.7-plus", timeoutMs: config.compatibleProviders!.qwen.timeoutMs });
  // Settings saved before Qwen existed get it; a stored entry keeps the user's values but not another dialect.
  const older = await (await storeIn(t, { ...fresh, providers: { openai: fresh.providers.openai } })).store.get();
  assert.equal(older.providers.qwen?.dialect, "qwen");
  const tampered = await (await storeIn(t, { ...fresh, providers: { ...fresh.providers, qwen: { ...fresh.providers.qwen, dialect: "chat", kind: undefined, model: "qwen3.8-max" } } })).store.get();
  assert.equal(tampered.providers.qwen.dialect, "qwen");
  assert.equal(tampered.providers.qwen.kind, "openai-compatible");
  assert.equal(tampered.providers.qwen.model, "qwen3.8-max");
});

test("a provider that is data is validated: a safe id, a known dialect, a short name, a web address", () => {
  validateSettingsPatch({ providers: { qwen: { apiKey: "sk-x", model: "qwen3.8-max", baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1" } } });
  validateSettingsPatch({ providers: { "my-groq": { kind: "openai-compatible", dialect: "chat", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "m", enabled: true } } });
  validateSettingsPatch({ providers: { "my-vllm": { kind: "openai-compatible", dialect: "chat", name: "vLLM", baseUrl: "https://llm.example/v1", model: "m", enabled: true, nativeTools: "chat" } } });
  const refused: Array<[unknown, RegExp]> = [
    [{ openai: { kind: "openai-compatible" } }, /built in/],
    [{ "Bad Id": { kind: "openai-compatible", dialect: "chat" } }, /provider id/],
    [{ custom: { kind: "openai-compatible", dialect: "anthropic" } }, /dialect/],
    [{ custom: { kind: "something-else" } }, /kind/],
    [{ custom: { kind: "openai-compatible", name: " " } }, /name/],
    [{ custom: { kind: "openai-compatible", name: "x".repeat(81) } }, /name/],
    [{ qwen: { baseUrl: "ftp://dashscope.example/v1" } }, /baseUrl/],
    [{ qwen: { baseUrl: "https://user:secret@dashscope.example/v1" } }, /baseUrl/],
    [{ custom: { kind: "openai-compatible", baseUrl: "not a url" } }, /baseUrl/],
    [{ custom: { kind: "openai-compatible", nativeTools: "responses" } }, /nativeTools/],
    [{ openai: { nativeTools: "chat" } }, /built in/]
  ];
  for (const [providers, message] of refused) assert.throws(() => validateSettingsPatch({ providers } as AppSettingsPatch), message, JSON.stringify(providers));
});

test("the catalog, the configuration and the environment agree about Qwen; its key never reaches child processes", () => {
  const preset = providerPreset("qwen")!;
  assert.equal(preset.baseUrl, SINGAPORE);
  assert.ok(preset.models.includes(preset.model));
  assert.deepEqual(preset.regions!.map(region => region.id), ["sg", "us", "hk", "cn"]);
  for (const item of PROVIDER_PRESETS) assert.equal(BUILT_IN_PROVIDER_IDS.includes(item.id), false);
  assert.equal(config.compatibleProviders!.qwen.dialect, "qwen");
  for (const name of ["QWEN_API_KEY", "DASHSCOPE_API_KEY"]) {
    assert.ok((SECRET_ENV_KEYS as readonly string[]).includes(name));
    assert.equal(childProcessEnv({ [name]: "sk-secret", PATH: "/bin" })[name], undefined);
  }
});

test("a paired device sets Qwen's key and model, never its address, and sees only whether a key is saved", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "compatible-remote-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new AppSettingsStore(root, config, { vault: keyVault() });
  await store.update({ providers: { qwen: { apiKey: "" } } });
  const runtimeManager = { getSettings: () => store.get(), providerKeys: async (settings?: never) => store.resolveKeys(settings ?? await store.get()),
    updateSettings: async (patch: AppSettingsPatch) => { validateSettingsPatch(patch); return { settings: await store.update(patch) }; },
    getRuntime: () => ({ llmService: { generateText: async () => ({ text: "ok" }) }, localModelService: { snapshot: () => ({ runtime: { status: "stopped" } }) } }) } as unknown as RuntimeManager;
  const ops = createSettingsOperations({ runtimeManager, isDraining: () => false });
  const context: OperationContext = { accountId: "account", deviceId: "mac", signal: new AbortController().signal };
  const call = (op: string, payload?: unknown) => Promise.resolve(ops[op]!(payload, context)) as Promise<any>;
  await call("settings.update", { providers: { qwen: { apiKey: { set: "sk-qwen-remote-1234" }, model: "qwen3.8-flash" } } });
  const saved = (await store.get()).providers.qwen;
  assert.equal((await store.resolveKeys(await store.get())).providers.qwen?.key, "sk-qwen-remote-1234");
  assert.equal((await fs.readFile(path.join(root, "settings.json"), "utf8")).includes("sk-qwen-remote-1234"), false, "the key is in the vault");
  assert.equal(saved.model, "qwen3.8-flash");
  await assert.rejects(call("settings.update", { providers: { qwen: { baseUrl: "https://elsewhere.example/v1" } } }), (error: unknown) => error instanceof RemoteOperationError);
  const view = JSON.stringify((await call("settings.get")).settings);
  assert.equal(view.includes("sk-qwen-remote-1234"), false);
  assert.match(view, /"qwen":\{[^}]*"apiKeyState":"set"/);
});

test("Settings names Qwen, shows its regions and links to its key page", t => {
  const bundle = buildSync({ entryPoints: ["public/assets/settings-shell.js"], bundle: true, write: false, format: "iife", globalName: "SettingsShell" }).outputFiles[0].text;
  const dom = new JSDOM('<main><div id="root"></div></main>', { url: "http://localhost/#/chat", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.eval(`${bundle}\nwindow.SettingsShell = SettingsShell;`);
  const preset = providerPreset("qwen")!;
  const appSettings = { memory: { localProfileId: "local-1" }, profile: { displayName: "Mira" }, llm: { defaultProvider: "llamacpp" },
    providers: { openai: { enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt" }, qwen: { kind: "openai-compatible", dialect: "qwen", name: preset.name, enabled: true, baseUrl: SINGAPORE, model: preset.model, timeoutMs: 300000 } } };
  const providers = [{ id: "qwen", name: preset.name, configured: false, defaultModel: preset.model, catalog: { keyUrl: preset.keyUrl, models: preset.models, regions: preset.regions } }];
  const shell = dom.window.SettingsShell.createSettingsShell({ app: dom.window.document.getElementById("root"), getContext: () => ({ appSettings, providers }),
    data: { integrations: [] }, renderModelControl: () => "<select></select>", applyPreferences() {}, captureScroll: () => ({}), restoreScroll() {}, onReturn() {} });
  shell.route("#/settings/providers");
  const page = () => dom.window.document.querySelector(".settings-content");
  assert.match(page().textContent, /Qwen \(Alibaba Cloud\)/);
  shell.route("#/settings/providers/qwen");
  assert.equal(dom.window.document.querySelector("h1").textContent, "Qwen (Alibaba Cloud)");
  assert.equal(page().querySelector(`a[href="${preset.keyUrl}"]`)?.getAttribute("target"), "_blank");
  const regions = [...page().querySelector('[data-region-for="providers.qwen.baseUrl"]').options].map((option: any) => [option.textContent, option.value]);
  assert.deepEqual(regions.slice(0, 2), [["Singapore (international)", SINGAPORE], ["US (Virginia)", "https://dashscope-us.aliyuncs.com/compatible-mode/v1"]]);
  assert.deepEqual(regions.at(-1), ["Other address", ""]);
});

test("each preset's dialect asks in its service's own way: DeepSeek's JSON word, Groq's reasoning_effort, OpenRouter's reasoning, Perplexity without JSON mode", async () => {
  const chat = () => Response.json({ choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }] });
  const provider = (id: string, fetchImpl: typeof fetch) => {
    const preset = providerPreset(id)!;
    return new OpenAICompatibleProvider({ id, name: preset.name, baseUrl: preset.baseUrl, model: preset.model, timeoutMs: 1000, apiKey: "sk-test-1234", dialect: compatibleDialect(preset.dialect) }, new Logger(), fetchImpl);
  };
  const deepseek = service(chat);
  await provider("deepseek", deepseek.fetchImpl).generateText({ prompt: "Classify", responseFormat: { type: "json_object" } });
  assert.equal(deepseek.calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(deepseek.calls[0].body.messages[0].content, "Reply with a JSON object.");

  const groq = service(chat);
  await provider("groq", groq.fetchImpl).generateText({ prompt: "Think", reasoningEffort: "max" });
  assert.equal(groq.calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(groq.calls[0].body.reasoning_effort, "high");

  const openrouter = service(chat);
  await provider("openrouter", openrouter.fetchImpl).generateText({ prompt: "Think", reasoningEffort: "low" });
  await provider("openrouter", openrouter.fetchImpl).generateText({ prompt: "Quick" });
  assert.deepEqual(openrouter.calls[0].body.reasoning, { effort: "low" });
  assert.equal(openrouter.calls[1].body.reasoning, undefined);
  assert.equal(openrouter.calls[0].body.reasoning_effort, undefined);

  // Perplexity's Agent API: Responses-shaped, a preset or a hosted model with web search, its presets listed first.
  const answer = () => Response.json({ object: "response", status: "completed", model: "openai/gpt-6-luna",
    output: [{ type: "search_results", results: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Paris[1]", annotations: [] }] }],
    usage: { input_tokens: 1457, output_tokens: 5, total_tokens: 1462, input_tokens_details: { cached_tokens: 1400, cache_creation_input_tokens: 0 } } });
  const perplexity = service((call) => call.url.endsWith("/models") ? Response.json({ object: "list", data: [{ id: "openai/gpt-6-luna" }, { id: "anthropic/claude-sonnet-5-5" }] }) : answer());
  const sonar = provider("perplexity", perplexity.fetchImpl);
  assert.equal(sonar.getDescriptor().capabilities?.jsonMode, false);
  const reply = await sonar.generateText({ prompt: "Capital of France?", systemPrompt: "One word.", maxTokens: 64, images: [{ dataUrl: PNG }] });
  assert.equal(reply.text, "Paris[1]");
  assert.deepEqual(reply.usage, { inputTokens: 1457, outputTokens: 5, totalTokens: 1462, cachedInputTokens: 1400 });
  assert.equal(perplexity.calls[0].url, "https://api.perplexity.ai/v1/responses");
  assert.equal(perplexity.calls[0].body.preset, "fast");
  assert.equal(perplexity.calls[0].body.model, undefined);
  assert.equal(perplexity.calls[0].body.instructions, "One word.");
  assert.equal(perplexity.calls[0].body.max_output_tokens, 64);
  assert.equal(perplexity.calls[0].body.input[0].content[1].type, "input_image");
  await sonar.generateText({ prompt: "Hi", model: "anthropic/claude-sonnet-5-5" });
  assert.equal(perplexity.calls[1].body.model, "anthropic/claude-sonnet-5-5");
  assert.equal(perplexity.calls[1].body.max_output_tokens, 16_000, "its Anthropic models need a cap");
  assert.deepEqual(perplexity.calls[1].body.tools, [{ type: "web_search" }]);
  // An agent's next action is about its own tools and files: no web search beside them.
  await sonar.generateText({ prompt: "Next action", model: "openai/gpt-6-luna", outputPurpose: "agent-action" });
  assert.equal(perplexity.calls[2].body.model, "openai/gpt-6-luna");
  assert.equal(perplexity.calls[2].body.tools, undefined);
  assert.deepEqual((await sonar.listModels()).map(model => model.id), ["fast", "low", "medium", "high", "xhigh", "openai/gpt-6-luna", "anthropic/claude-sonnet-5-5"]);
  for (const preset of PROVIDER_PRESETS) {
    assert.ok(preset.models.includes(preset.model), preset.id);
    assert.match(preset.baseUrl, /^https:\/\//);
    assert.equal(compatibleDialect(preset.dialect).id, preset.dialect, preset.id);
  }
});

const agentTools = agentFunctionTools(false, { only: ["file.read", "file.write"] });
const presetProvider = (id: string, fetchImpl: typeof fetch, model?: string) => {
  const preset = providerPreset(id)!;
  return new OpenAICompatibleProvider({ id, name: preset.name, baseUrl: preset.id === "qwen" ? SINGAPORE : preset.baseUrl, model: model ?? preset.model, timeoutMs: 1000, apiKey: "sk-test-1234", dialect: compatibleDialect(preset.dialect) }, new Logger(), fetchImpl);
};
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const chatCalls = (...calls: unknown[]) => Response.json({ id: "chat-1", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: calls } }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
const agentRequest = (extra: Partial<LLMRequest> = {}): LLMRequest => ({ prompt: "Read a.ts", systemPrompt: "You are an agent.", outputPurpose: "agent-action", tools: agentTools, ...extra });

// From live runs of Synthesis agents: in JSON, gpt-5.4-nano through Perplexity had 24% of its steps refused
// and DeepSeek 21%; through the services' own function calls, none.
test("agents act through each service's own function calls: chat tool calls for DeepSeek, Groq, OpenRouter and Qwen, function tools for Perplexity", async () => {
  for (const id of ["deepseek", "groq", "openrouter"]) {
    const { calls, fetchImpl } = service(() => chatCalls(toolCall("call_1", "file_read", { path: "a.ts", startLine: null, endLine: null })));
    const provider = presetProvider(id, fetchImpl);
    assert.equal(provider.getDescriptor().capabilities?.nativeTools, true, id);
    assert.equal(compatibleDialect(id).nativeTools, "chat", id);
    const response = await provider.generateText(agentRequest());
    assert.match(calls[0].url, /\/chat\/completions$/, id);
    const body = calls[0].body;
    assert.deepEqual(body.tools.map((tool: any) => tool.function.name), ["file_read", "file_write"], id);
    assert.equal(body.tools[0].type, "function");
    assert.equal(body.tools[0].function.strict, undefined, `${id}: no strict field on chat tools`);
    assert.doesNotMatch(JSON.stringify(body.tools), /minLength|maxLength/, id);
    // No strict mode on chat completions: an optional argument is optional, not required and nullable.
    assert.deepEqual(body.tools[0].function.parameters.required, ["path"], id);
    assert.deepEqual(body.tools[0].function.parameters.properties.startLine, { type: "integer", minimum: 1 }, id);
    assert.equal(body.tool_choice, "auto", id);
    assert.equal(body.parallel_tool_calls, false, id);
    assert.equal(body.response_format, undefined, `${id}: no JSON mode beside tools`);
    assert.deepEqual(response.agentAction, { type: "tool_call", tool: "file.read", arguments: { path: "a.ts" } }, id);
    assert.equal(response.toolCallId, "call_1");
    assert.equal(response.outputItems, undefined, `${id}: stateless, nothing kept for a continuation`);
    assert.equal(response.protocolError, undefined);
    assert.equal(response.error, undefined);
    // The last turn asks for an answer in text.
    await provider.generateText(agentRequest({ toolChoice: "none" }));
    assert.equal(calls[1].body.tool_choice, "none", id);
    // A prose request has no tools.
    await provider.generateText({ prompt: "Say hi" });
    assert.equal(calls[2].body.tools, undefined, id);
  }
  // A reply in text is the final answer; several calls at once (DeepSeek's chat sends them whatever
  // parallel_tool_calls says): the first runs and the others are named.
  const replies = [
    Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "## Findings\n\n- a.ts:1 swallows an error" } }] }),
    chatCalls(toolCall("call_1", "file_read", { path: "a.ts", startLine: 1, endLine: null }), toolCall("call_2", "file_read", { path: "b.ts", startLine: null, endLine: null })),
    Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id: "call_3", type: "function", function: { name: "file_list", arguments: "{}" } }] } }] }),
    Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"type":"tool_call","tool":"file.read","arguments":{"path":"a.ts"}}' } }] })
  ];
  const deepseek = presetProvider("deepseek", service((_call, index) => replies[index]!).fetchImpl);
  assert.deepEqual((await deepseek.generateText(agentRequest())).agentAction, { type: "final", text: "## Findings\n\n- a.ts:1 swallows an error" });
  const several = await deepseek.generateText(agentRequest());
  assert.deepEqual(several.agentAction, { type: "tool_call", tool: "file.read", arguments: { path: "a.ts", startLine: 1 } });
  assert.deepEqual(several.extraCalls, { count: 1, callIds: ["call_2"] });
  assert.match((await deepseek.generateText(agentRequest())).protocolError!, /Unknown function: file_list/, "a tool it was not given never runs");
  const written = await deepseek.generateText(agentRequest());
  assert.equal(written.agentAction, undefined, "a tool call written as text never runs");
  assert.match(written.protocolError!, /wrote a tool call as text, so nothing ran.*call the function itself/);

  // Qwen streams its tool calls: the id and name once, the arguments in pieces.
  const qwenStream = service(() => sse(
    { choices: [{ index: 0, delta: { reasoning_content: "I should read it." } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_q", type: "function", function: { name: "file_read", arguments: "" } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":" } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"a.ts\",\"startLine\":null,\"endLine\":null}" } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 } }));
  const qwenReply = await presetProvider("qwen", qwenStream.fetchImpl).generateText(agentRequest({ reasoningEffort: "medium" }));
  assert.equal(qwenStream.calls[0].body.stream, true);
  assert.equal(qwenStream.calls[0].body.tool_choice, "auto");
  assert.equal(qwenStream.calls[0].body.messages[0].content, "You are an agent.", "no JSON word beside tools");
  assert.deepEqual(qwenReply.agentAction, { type: "tool_call", tool: "file.read", arguments: { path: "a.ts" } });
  assert.equal(qwenReply.toolCallId, "call_q");

  // Perplexity's Agent API: function tools on the Responses API, strict, never web search beside them.
  const perplexity = service(() => Response.json({ id: "resp_p", status: "completed", model: "openai/gpt-5.4-nano",
    output: [{ type: "function_call", call_id: "call_p", name: "file_read", arguments: "{\"path\":\"a.ts\",\"startLine\":null,\"endLine\":null}", status: "completed" }] }));
  const sonar = presetProvider("perplexity", perplexity.fetchImpl);
  assert.equal(sonar.getDescriptor().capabilities?.nativeTools, true);
  assert.equal(sonar.getDescriptor().capabilities?.structuredOutputs, false, "its JSON schema reorders the keys");
  const action = await sonar.generateText(agentRequest());
  await sonar.generateText(agentRequest({ model: "openai/gpt-5.4-nano", toolChoice: "none" }));
  assert.equal(perplexity.calls[0].url, "https://api.perplexity.ai/v1/responses");
  assert.equal(perplexity.calls[0].body.preset, "fast");
  assert.deepEqual(perplexity.calls[0].body.tools.map((tool: any) => [tool.type, tool.name, tool.strict]), [["function", "file_read", true], ["function", "file_write", true]]);
  assert.equal(perplexity.calls[0].body.parallel_tool_calls, false);
  assert.equal(perplexity.calls[0].body.tool_choice, undefined);
  assert.equal(perplexity.calls[1].body.model, "openai/gpt-5.4-nano");
  assert.ok(perplexity.calls[1].body.tools.every((tool: any) => tool.type === "function"), "a hosted model gets no web search beside its tools");
  assert.equal(perplexity.calls[1].body.tool_choice, "none");
  assert.deepEqual(action.agentAction, { type: "tool_call", tool: "file.read", arguments: { path: "a.ts" } });
  assert.equal(action.toolCallId, "call_p");
  assert.ok(action.outputItems?.length, "the Responses API continues with its own items");

  // A service added as Other acts in JSON: nothing here says it reads tool calls.
  const other = service(() => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}" } }] }));
  const custom = new OpenAICompatibleProvider({ id: "custom", name: "Custom", baseUrl: "https://llm.example/v1", model: "m", timeoutMs: 1000, apiKey: "k", dialect: CHAT_DIALECT }, new Logger(), other.fetchImpl);
  await custom.generateText(agentRequest());
  assert.equal(custom.getDescriptor().capabilities?.nativeTools, false);
  assert.equal(other.calls[0].body.tools, undefined);
  // The app's own runtimes never get chat tools.
  for (const id of ["llamacpp", "lmstudio"]) assert.equal(dialectFor(id).nativeTools, undefined, id);
});

// DeepSeek writes its own function-call markup (DSML) into the content now and then, without tool_calls; a
// reasoning model may put a <think> block before its answer. Neither is an answer.
test("a native reply's text is cleaned as JSON replies are: DSML call markup is a tool call written as text, a think block is not the answer", async () => {
  const dsml = '<｜｜DSML｜｜function_calls>\n<｜｜DSML｜｜invoke name="file_read">\n<｜｜DSML｜｜parameter name="path" string="true">a.ts</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜function_calls>';
  const texts = [dsml, `I will read it.\n\n${dsml}`, "<think>Read a.ts first.</think>\n\n## Findings\n\n- a.ts:1", "## Review of LLMService.ts\n\nIt strips `/\\s*<\\/?｜+DSML｜+[\\s\\S]*$/u` from an action."];
  const provider = presetProvider("deepseek", service((_call, index) => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: texts[index] } }] })).fetchImpl);
  for (const index of [0, 1]) {
    const reply = await provider.generateText(agentRequest());
    assert.equal(reply.agentAction, undefined, `${index}: the markup never completes the agent`);
    assert.match(reply.protocolError!, /wrote a tool call as text, so nothing ran/, String(index));
  }
  assert.deepEqual((await provider.generateText(agentRequest())).agentAction, { type: "final", text: "## Findings\n\n- a.ts:1" });
  assert.equal((await provider.generateText(agentRequest())).agentAction?.type, "final", "an answer that quotes the markup's pattern is an answer");
});

// An answer about this app's own code quotes DSML markup (its tests hold some): quoted in code, it is text.
test("DSML markup in an answer's code is quoted, not a call; in its prose it is a call; native strips only think blocks", async () => {
  const closer = '{"path":"."}</｜｜DSML｜｜ parameter>';
  const texts = [
    `## Review\n\nDeepSeek ends its arguments as in \`${closer}\`; LLMService cuts that off.`,
    `## Review\n\nThe test's reply:\n\n\`\`\`text\n${closer}\n</｜｜DSML｜｜ invoke>\n\`\`\`\n\nIt is cut after the JSON.`,
    `## Review\n\n~~~\n<｜｜DSML｜｜function_calls>\n~~~`,
    `Reading it.\n\n${closer}\n</｜｜DSML｜｜ invoke>`,
    "<analysis>Root cause: a.ts:3 swallows the error.</analysis>\n\nFixed it.",
    "<analysis>The whole answer: a.ts:3 swallows the error.</analysis>",
    "<thinking>Plan.</thinking>\n<think>More.</think>\n\nDone: a.ts:3."
  ];
  const provider = presetProvider("deepseek", service((_call, index) => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: texts[index] } }] })).fetchImpl);
  const replies = [];
  for (let index = 0; index < texts.length; index++) replies.push(await provider.generateText(agentRequest()));
  for (const index of [0, 1, 2]) assert.deepEqual(replies[index]!.agentAction, { type: "final", text: texts[index] }, `${index}: markup in code is quoted`);
  assert.equal(replies[3]!.textToolCall, true, "markup in prose is a call written as text");
  assert.deepEqual(replies[4]!.agentAction, { type: "final", text: texts[4] }, "an <analysis> block is part of a native answer");
  assert.deepEqual(replies[5]!.agentAction, { type: "final", text: texts[5] });
  assert.deepEqual(replies[6]!.agentAction, { type: "final", text: "Done: a.ts:3." });
});

test("Add provider's tool check fits in the time the window waits for it, and gives up at its own limit", async () => {
  const { answersToolCalls, TOOL_CHECK_TIMEOUT_MS } = await import("../src/llm/toolProbe");
  const wait = Number(/discoverModels:[^\n]*timeoutMs: (\d+)/.exec(await fs.readFile("public/assets/settings-data.js", "utf8"))![1]);
  // The models are listed first (at most 5 s), then the check: both with room under the window's wait.
  assert.ok(5_000 + TOOL_CHECK_TIMEOUT_MS <= wait - 10_000, `${TOOL_CHECK_TIMEOUT_MS} ms`);
  const hanging = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
  const started = Date.now();
  const awake = setTimeout(() => undefined, 5_000); // AbortSignal.timeout alone does not keep the test running
  assert.equal(await answersToolCalls({ baseUrl: "https://slow.example/v1", apiKey: "k", model: "m", dialect: CHAT_DIALECT, timeoutMs: 50 }, hanging), false);
  clearTimeout(awake);
  assert.ok(Date.now() - started < 2_000);
});

test("a native answer that starts with JSON is refused only when it is a call: the whole reply, or naming a tool the agent has", () => {
  const read = (text: string) => readNativeAgentResponse({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] }, agentTools);
  // A Markdown answer with a config example first stays the answer (on the last turn it would be lost).
  const config = '{"tool":"eslint","rules":{"no-console":"warn"}}\n\nThis config makes ESLint warn on console calls.';
  assert.deepEqual(read(config).agentAction, { type: "final", text: config });
  // A call: the whole reply, or one naming the agent's own tool, whatever follows.
  for (const text of ['{"tool":"eslint","arguments":{}}', '{"type":"tool_call","tool":"file.read","arguments":{"path":"a.ts"}}\n\nReading it now.',
    '{"name":"file_read","arguments":{"path":"a.ts"}} then I will answer', '{"type":"file.read","arguments":{"path":"a.ts"}}}}']) {
    assert.equal(read(text).textToolCall, true, text);
  }
  // A final answer in its envelope with raw line breaks (Gemini's) is unwrapped to its text.
  assert.deepEqual(read('{"type":"final","text":"# Review\n\n- a.ts:1 throws"}'.replace(/\\n/g, "\n")).agentAction, { type: "final", text: "# Review\n\n- a.ts:1 throws" });
});

test("a service that refuses only the last turn's tool_choice none is asked again without it, and keeps its tools", async () => {
  for (const id of ["deepseek", "perplexity"]) {
    const refusal = { error: { message: "tool_choice 'none' is not supported for this model", type: "invalid_request_error" } };
    const answer = id === "perplexity" ? Response.json({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "## Answer" }] }] })
      : Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "## Answer" } }] });
    const { calls, fetchImpl } = service(call => call.body.tool_choice === "none" ? Response.json(refusal, { status: 400 }) : answer.clone());
    const provider = presetProvider(id, fetchImpl);
    const reply = await provider.generateText(agentRequest({ toolChoice: "none" }));
    assert.deepEqual(reply.agentAction, { type: "final", text: "## Answer" }, id);
    assert.equal(calls.length, 2, id);
    assert.equal(calls[1].body.tool_choice, undefined, `${id}: asked again without tool_choice`);
    assert.ok(calls[1].body.tools.length, `${id}: with its tools`);
    assert.equal(provider.toolsRefused(), false, `${id}: the model keeps its tools`);
    // From then on its last turns are asked without the choice; its other turns keep it as they were.
    await provider.generateText(agentRequest({ toolChoice: "none" }));
    assert.equal(calls.length, 3, id);
    assert.equal(calls[2].body.tool_choice, undefined, id);
  }
  // A refusal of the tools themselves, without the choice, is still one: once, then JSON.
  const { calls, fetchImpl } = service(() => Response.json({ error: { message: "Tools are not supported by this model" } }, { status: 400 }));
  const provider = presetProvider("deepseek", fetchImpl);
  assert.equal((await provider.generateText(agentRequest({ toolChoice: "none" }))).unsupportedFeature, "tools");
  assert.equal(calls.length, 2, "once more without the choice, never again");
  assert.equal(provider.toolsRefused(), true);
});

test("a model that refuses tools acts in JSON from then on, and Groq's unreadable tool call costs a correction, not the run", async () => {
  // OpenRouter: a model no endpoint serves with tools.
  const refusal = { error: { message: "No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing", code: 404 } };
  const openrouter = service(call => call.body.model === "meta/no-tools" ? Response.json(refusal, { status: 404 }) : chatCalls(toolCall("call_1", "file_read", { path: "a.ts", startLine: null, endLine: null })));
  const provider = presetProvider("openrouter", openrouter.fetchImpl, "meta/no-tools");
  const refused = await provider.generateText(agentRequest());
  assert.equal(refused.unsupportedFeature, "tools");
  assert.match(refused.error!, /No endpoints found that support tool use/);
  assert.equal(provider.toolsRefused("meta/no-tools"), true);
  assert.equal(provider.toolsRefused("openai/gpt-5-mini"), false);
  const again = await provider.generateText(agentRequest());
  assert.equal(again.unsupportedFeature, "tools");
  assert.equal(openrouter.calls.length, 1, "not asked again with tools");
  assert.equal((await provider.generateText(agentRequest({ model: "openai/gpt-5-mini" }))).agentAction?.type, "tool_call", "another model keeps its tools");
  const registry = new LLMRegistry(); registry.register(provider);
  const llm = new LLMService(registry, "openrouter", new Logger(), new OutputSanitizer());
  assert.equal(llm.supportsNativeTools("openrouter", "meta/no-tools"), false);
  assert.equal(llm.supportsNativeTools("openrouter", "openai/gpt-5-mini"), true);
  assert.equal(llm.supportsNativeTools("openrouter"), false, "the provider's own model is meta/no-tools");
  // vLLM without its tool parser, and OpenRouter's words, fall back; a refused key never does.
  const tools = agentRequest();
  assert.equal(unsupportedFeature(400, "\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set", tools), "tools");
  assert.equal(unsupportedFeature(404, "No endpoints found that support tool use.", tools), "tools");
  assert.equal(unsupportedFeature(401, "No endpoints found that support tool use.", tools), undefined);
  assert.equal(unsupportedFeature(400, "Invalid API key", tools), undefined);

  // Groq refuses a tool call it could not read, with what the model wrote.
  const failed = { error: { message: "Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details.", type: "invalid_request_error", code: "tool_use_failed",
    failed_generation: "<function=file_read>{\"path\": \"a.ts\"}</function>" } };
  const groq = service(() => Response.json(failed, { status: 400 }));
  const reply = await presetProvider("groq", groq.fetchImpl).generateText(agentRequest());
  assert.equal(reply.error, undefined);
  assert.equal(reply.agentAction, undefined);
  assert.match(reply.protocolError!, /function call could not be read, so nothing ran/);
  assert.equal(reply.text, failed.error.failed_generation);
  const json = { error: { message: "Failed to generate JSON.", type: "invalid_request_error", code: "json_validate_failed", failed_generation: "{\"type\":\"tool_call\"," } };
  const jsonMode = await presetProvider("groq", service(() => Response.json(json, { status: 400 })).fetchImpl).generateText({ prompt: "Next action", outputPurpose: "agent-action", responseFormat: { type: "json_object" } });
  assert.match(jsonMode.protocolError!, /not valid JSON, so nothing ran/);
  // Anything else than an agent's action stays an error.
  const chat = await presetProvider("groq", service(() => Response.json(json, { status: 400 })).fetchImpl).generateText({ prompt: "Classify", responseFormat: { type: "json_object" } });
  assert.match(chat.error!, /HTTP 400.*Failed to generate JSON/);
  assert.equal(chat.protocolError, undefined);
});

test("an added provider is saved, registered with its preset's catalog, and removed; the built-ins and the default stay", async t => {
  const { RuntimeManager } = await import("../src/app/RuntimeManager");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "added-provider-"));
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, options]) => [id, { ...options, enabled: false, apiKey: "" }])) as typeof config.providers;
  const options = { ...config, providers, appDataDir: path.join(root, "app"), llm: { defaultProvider: "llamacpp" }, sessions: { baseDir: path.join(root, "sessions") },
    memory: { ...config.memory, adapter: "local-json" as const, baseDir: path.join(root, "memory") }, outputDir: path.join(root, "output"),
    plugins: { dir: path.join(root, "plugins"), overrides: {} }, telegram: { ...config.telegram, enabled: false, botToken: "" },
    localModels: { ...config.localModels!, runtimeDir: path.join(root, "runtime"), executablePath: undefined, modelsDir: path.join(root, "models"), contextSize: 4096 } };
  const vault = keyVault();
  const manager = new RuntimeManager(options, new AppSettingsStore(options.appDataDir, options, { vault }), new Logger(), {}, { vault });
  await manager.init();
  t.after(async () => { await manager.dispose(); await fs.rm(root, { recursive: true, force: true }); });

  const added = { kind: "openai-compatible" as const, dialect: "deepseek", preset: "deepseek", name: "DeepSeek (work)", baseUrl: "https://api.deepseek.com",
    apiKey: "sk-added-provider-key", model: "deepseek-flash", enabled: true, timeoutMs: 300000 };
  const { runtime } = await manager.updateSettings({ providers: { "deepseek-2": added } });
  const descriptor = runtime.providerDescriptors.find(item => item.id === "deepseek-2");
  assert.equal(descriptor?.name, "DeepSeek (work)");
  assert.equal(descriptor?.configured, true);
  assert.deepEqual(descriptor?.catalog?.models, providerPreset("deepseek")!.models, "the preset's models follow a renamed copy");
  assert.equal(runtime.providerDescriptors.find(item => item.id === "qwen")?.configured, false, "Qwen without a key is listed, not configured");

  await assert.rejects(manager.updateSettings({ llm: { defaultProvider: "deepseek-2" }, providers: { "deepseek-2": null } }), /default provider/);
  await assert.rejects(manager.updateSettings({ providers: { qwen: null } }), /cannot be removed/);
  await assert.rejects(manager.updateSettings({ providers: { openai: null } }), /cannot be removed/);
  await assert.rejects(manager.updateSettings({ providers: { other: { ...added, preset: "nonsense" } } }), /preset/);
  // A service added as Other acts through tool calls only when it answered one when it was added, and
  // only at that address.
  const other = { kind: "openai-compatible" as const, dialect: "chat", name: "My vLLM", baseUrl: "https://llm.example/v1", apiKey: "k-other-123", model: "m", enabled: true, timeoutMs: 300000 };
  const plain = await manager.updateSettings({ providers: { "my-vllm": other, "my-tools": { ...other, name: "Tools", nativeTools: "chat" } } });
  assert.equal(plain.runtime.providerDescriptors.find(item => item.id === "my-vllm")?.capabilities?.nativeTools, false);
  assert.equal(plain.runtime.providerDescriptors.find(item => item.id === "my-tools")?.capabilities?.nativeTools, true);
  const renamed = await manager.updateSettings({ providers: { "my-tools": { name: "Tools (renamed)", baseUrl: "https://llm.example/v1" } } });
  assert.equal(renamed.settings.providers["my-tools"]?.nativeTools, "chat", "the same address keeps it");
  const moved = await manager.updateSettings({ providers: { "my-tools": { baseUrl: "https://other.example/v1" } } });
  assert.equal(moved.settings.providers["my-tools"]?.nativeTools, undefined);
  assert.equal(moved.runtime.providerDescriptors.find(item => item.id === "my-tools")?.capabilities?.nativeTools, false);
  assert.ok([...vault.values.keys()].some(name => name.startsWith("provider-key/deepseek-2/")));
  const removed = await manager.updateSettings({ providers: { "deepseek-2": null } });
  assert.equal(removed.settings.providers["deepseek-2"], undefined);
  assert.equal([...vault.values.keys()].some(name => name.startsWith("provider-key/deepseek-2/")), false, "its key's record is removed with it");
  assert.equal(removed.runtime.providerDescriptors.some(item => item.id === "deepseek-2"), false);
  assert.ok(removed.settings.providers.qwen);
});

function settingsPage(t: TestContext, providers: Record<string, unknown>) {
  const bundle = buildSync({ entryPoints: ["public/assets/settings-shell.js"], bundle: true, write: false, format: "iife", globalName: "SettingsShell" }).outputFiles[0].text;
  const dom = new JSDOM('<main><div id="root"></div></main>', { url: "http://localhost/#/chat", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.eval(`${bundle}\nwindow.SettingsShell = SettingsShell;`);
  const saves: Array<Record<string, any>> = [], tests: unknown[][] = [], discovered: Array<Record<string, string>> = [];
  const appSettings: Record<string, any> = { memory: { localProfileId: "local-1" }, profile: { displayName: "Mira" }, llm: { defaultProvider: "llamacpp" }, providers };
  const providerPresets = PROVIDER_PRESETS.map(({ env: _env, ...preset }) => preset);
  const descriptors = () => Object.entries(appSettings.providers).map(([id, entry]: [string, any]) => ({ id, name: entry.name ?? id, configured: entry.apiKeyState === "set", defaultModel: entry.model,
    ...(providerPreset(entry.preset ?? id) ? { catalog: { keyUrl: providerPreset(entry.preset ?? id)!.keyUrl, models: providerPreset(entry.preset ?? id)!.models, regions: providerPreset(entry.preset ?? id)!.regions } } : {}) }));
  const data = { integrations: [],
    // As the API answers: a saved key comes back as its state, never the key.
    save: async (patch: Record<string, any>) => { saves.push(JSON.parse(JSON.stringify(patch)));
      for (const [id, entry] of Object.entries(patch.providers ?? {})) {
        if (entry === null) { delete appSettings.providers[id]; continue; }
        const { apiKey, ...fields } = entry as Record<string, unknown>;
        appSettings.providers[id] = { ...appSettings.providers[id], ...fields, ...(apiKey === undefined ? {} : { apiKeyState: apiKey ? "set" : "unset" }) };
      } },
    testProvider: async (...args: unknown[]) => { tests.push(args); return { ok: true, message: "Provider replied: ok", model: args[1] }; },
    discoverModels: async (body: Record<string, string>) => { discovered.push(body);
      if (body.apiKey.includes("wrong")) throw new Error("The service refused this key.");
      return { models: body.dialect === "perplexity" ? ["fast", "low", "openai/gpt-6-luna"] : ["model-b", "model-a"], ...(body.baseUrl?.includes("tools") ? { nativeTools: "chat" } : {}) }; } };
  dom.window.confirm = () => true;
  const shell = dom.window.SettingsShell.createSettingsShell({ app: dom.window.document.getElementById("root"), getContext: () => ({ appSettings, providers: descriptors(), providerPresets }),
    data, renderModelControl: () => "<select></select>", applyPreferences() {}, captureScroll: () => ({}), restoreScroll() {}, onReturn() {} });
  const document = dom.window.document;
  return { dom, document, shell, saves, tests, discovered, appSettings, content: () => document.querySelector(".settings-content") };
}

test("Add provider: a preset fills its fields, the provider is saved and tested, then its page shows the result", async t => {
  const ui = settingsPage(t, { qwen: { kind: "openai-compatible", dialect: "qwen", name: "Qwen (Alibaba Cloud)", enabled: true, baseUrl: SINGAPORE, model: "qwen3.7-plus", timeoutMs: 300000 } });
  ui.shell.route("#/settings/providers");
  assert.equal(ui.content().querySelector('a[href="#/settings/providers/new"]')?.textContent?.trim(), "Add provider");
  ui.shell.route("#/settings/providers/new");
  assert.equal(ui.document.querySelector("h1").textContent, "Add provider");
  const service = ui.content().querySelector("[data-add-provider-preset]");
  assert.deepEqual([...service.options].map((option: any) => option.textContent), ["DeepSeek", "OpenRouter", "Groq", "Perplexity", "Other OpenAI-compatible service"], "Qwen is already there");
  const field = (name: string) => ui.content().querySelector(`[data-add-field="${name}"]`);
  service.value = "perplexity";
  service.dispatchEvent(new ui.dom.window.Event("change", { bubbles: true }));
  assert.equal(field("name").value, "Perplexity");
  assert.equal(field("baseUrl").value, "https://api.perplexity.ai/v1");
  // The model is chosen from the service's list after the test, never typed here.
  assert.equal(ui.content().querySelector("#add-provider-model").disabled, true);
  assert.equal(field("model"), null);
  assert.equal(ui.content().querySelector('[data-add-key-help] a').getAttribute("href"), providerPreset("perplexity")!.keyUrl);
  field("apiKey").value = "pplx-test-key-123456";
  ui.content().querySelector("#add-provider-form").dispatchEvent(new ui.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  for (let i = 0; i < 50 && !ui.dom.window.location.hash.endsWith("/perplexity"); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(ui.saves[0], { providers: { perplexity: { kind: "openai-compatible", dialect: "perplexity", preset: "perplexity", name: "Perplexity",
    baseUrl: "https://api.perplexity.ai/v1", apiKey: "pplx-test-key-123456", model: "fast", enabled: true, timeoutMs: 300000 } } });
  assert.deepEqual(ui.tests[0], ["perplexity", "fast", 300000]);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.discovered[0])), { baseUrl: "https://api.perplexity.ai/v1", apiKey: "pplx-test-key-123456", dialect: "perplexity" }, "the address and key are checked first");
  ui.shell.route(ui.dom.window.location.hash);
  assert.match(ui.content().textContent, /Test succeeded/);
  assert.ok(ui.content().querySelector('[data-setting="providers.perplexity.name"]'), "an added provider can be renamed");

  // A second copy of a preset, or any other service, gets an id of its own.
  ui.shell.route("#/settings/providers/new");
  ui.content().querySelector("[data-add-provider-preset]").value = "perplexity";
  ui.content().querySelector("[data-add-provider-preset]").dispatchEvent(new ui.dom.window.Event("change", { bubbles: true }));
  field("apiKey").value = "pplx-second-key-123456";
  ui.content().querySelector("#add-provider-form").dispatchEvent(new ui.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  for (let i = 0; i < 50 && !ui.dom.window.location.hash.endsWith("/perplexity-2"); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(ui.saves[1].providers["perplexity-2"]);

  // Any other service: the first model it lists; a refused key saves nothing and says why.
  ui.shell.route("#/settings/providers/new");
  ui.content().querySelector("[data-add-provider-preset]").value = "";
  ui.content().querySelector("[data-add-provider-preset]").dispatchEvent(new ui.dom.window.Event("change", { bubbles: true }));
  field("name").value = "My vLLM"; field("baseUrl").value = "https://llm.example.com/v1"; field("apiKey").value = "wrong-key-123456";
  ui.content().querySelector("#add-provider-form").dispatchEvent(new ui.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  for (let i = 0; i < 50 && !/refused/.test(ui.content().querySelector("[data-add-provider-status]").textContent); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(ui.content().querySelector("[data-add-provider-status]").textContent, /refused this key/);
  assert.equal(ui.saves.length, 2, "nothing saved");
  field("apiKey").value = "right-key-123456";
  ui.content().querySelector("#add-provider-form").dispatchEvent(new ui.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  for (let i = 0; i < 50 && !ui.dom.window.location.hash.endsWith("/my-vllm"); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(ui.saves[2], { providers: { "my-vllm": { kind: "openai-compatible", dialect: "chat", name: "My vLLM", baseUrl: "https://llm.example.com/v1", apiKey: "right-key-123456", model: "model-b", enabled: true, timeoutMs: 300000 } } });
  // One that answered a tool call while it was checked is saved as such.
  ui.shell.route("#/settings/providers/new");
  ui.content().querySelector("[data-add-provider-preset]").value = "";
  ui.content().querySelector("[data-add-provider-preset]").dispatchEvent(new ui.dom.window.Event("change", { bubbles: true }));
  field("name").value = "Tool server"; field("baseUrl").value = "https://tools.example.com/v1"; field("apiKey").value = "right-key-654321";
  ui.content().querySelector("#add-provider-form").dispatchEvent(new ui.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  for (let i = 0; i < 50 && !ui.dom.window.location.hash.endsWith("/tool-server"); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(ui.saves[3].providers["tool-server"].nativeTools, "chat");
});

test("an added provider can be removed from its page; a built-in one cannot; a region fills Qwen's address", async t => {
  const ui = settingsPage(t, {
    qwen: { kind: "openai-compatible", dialect: "qwen", name: "Qwen (Alibaba Cloud)", enabled: true, baseUrl: SINGAPORE, model: "qwen3.7-plus", timeoutMs: 300000 },
    groq: { kind: "openai-compatible", dialect: "groq", preset: "groq", name: "Groq", enabled: true, baseUrl: "https://api.groq.com/openai/v1", apiKeyState: "set", model: "openai/gpt-oss-120b", timeoutMs: 300000 }
  });
  ui.shell.route("#/settings/providers/qwen");
  assert.equal(ui.content().querySelector("[data-remove-provider]"), null);
  const region = ui.content().querySelector('[data-region-for="providers.qwen.baseUrl"]');
  assert.equal(region.value, SINGAPORE);
  region.value = "https://dashscope-us.aliyuncs.com/compatible-mode/v1";
  region.dispatchEvent(new ui.dom.window.Event("change", { bubbles: true }));
  assert.equal(ui.content().querySelector('[name="providers.qwen.baseUrl"]').value, "https://dashscope-us.aliyuncs.com/compatible-mode/v1");
  ui.shell.route("#/settings/providers/groq");
  ui.content().querySelector("[data-remove-provider]").click();
  for (let i = 0; i < 50 && ui.dom.window.location.hash !== "#/settings/providers"; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(ui.saves[0], { providers: { groq: null } });
  assert.equal(ui.dom.window.location.hash, "#/settings/providers");
});

test("adding a provider first reads the models the service lists for that address and key", async t => {
  const { createProviderDiscoverController } = await import("../src/api/controller");
  const { default: http } = await import("node:http");
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== "Bearer good-key-123") { response.statusCode = 401; response.end(JSON.stringify({ error: { message: "Invalid key" } })); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "chat-model" }, { id: "text-embedding-3" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const call = async (body: unknown) => {
    let status = 0, payload: any;
    const res = { status(code: number) { status = code; return this; }, json(value: unknown) { payload = value; return this; } };
    await createProviderDiscoverController()({ body } as never, res as never);
    return { status, payload };
  };
  assert.deepEqual(await call({ baseUrl: base, apiKey: "good-key-123", dialect: "chat" }), { status: 200, payload: { models: ["chat-model", "text-embedding-3"] } });
  assert.deepEqual(await call({ baseUrl: base, apiKey: "bad-key-123", dialect: "deepseek" }), { status: 502, payload: { error: "The service refused this key." } }, "never the dialect's known models");
  assert.equal((await call({ baseUrl: "ftp://x.example", apiKey: "k" })).status, 400);
  assert.equal((await call({ baseUrl: "https://user:pw@x.example/v1", apiKey: "k" })).status, 400);
  assert.equal((await call({ baseUrl: base, apiKey: " " })).status, 400);
  assert.equal((await call({ baseUrl: base, apiKey: "good-key-123", dialect: "anthropic" })).status, 400);
});

test("adding a provider masks every occurrence of its key in what the service said", async t => {
  const { createProviderDiscoverController } = await import("../src/api/controller");
  const key = "sk-echoed-key-1234567";
  t.mock.method(globalThis, "fetch", async () => { throw new Error(`connect failed for ${key}; retried with ${key}`); });
  let status = 0, payload: any;
  const res = { status(code: number) { status = code; return this; }, json(value: unknown) { payload = value; return this; } };
  await createProviderDiscoverController()({ body: { baseUrl: "https://llm.example/v1", apiKey: key, dialect: "chat" } } as never, res as never);
  assert.equal(status, 502);
  assert.equal(JSON.stringify(payload).includes(key), false, payload.error);
  assert.match(payload.error, /for <key>; retried with <key>/);
});

test("adding a service as Other asks it for one tool call, and marks it only when it answers one properly", async t => {
  const { createProviderDiscoverController } = await import("../src/api/controller");
  const { default: http } = await import("node:http");
  const requests: Array<{ url: string; body: any }> = [];
  let answer: (body: any) => { status?: number; json: unknown } = () => ({ json: {} });
  const server = http.createServer((request, response) => {
    let raw = ""; request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") { response.end(JSON.stringify({ data: [{ id: "tool-model" }, { id: "other-model" }] })); return; }
      const body = JSON.parse(raw); requests.push({ url: String(request.url), body });
      const reply = answer(body); response.statusCode = reply.status ?? 200; response.end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const call = async (body: unknown) => {
    let payload: any;
    const res = { status() { return this; }, json(value: unknown) { payload = value; return this; } };
    await createProviderDiscoverController()({ body } as never, res as never);
    return payload;
  };
  const warnings: unknown[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  answer = () => ({ json: { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_files", arguments: "{\"path\":\"src\"}" } }] } }] } });
  assert.deepEqual(await call({ baseUrl: base, apiKey: "good-key-123" }), { models: ["tool-model", "other-model"], nativeTools: "chat" });
  assert.equal(requests[0].url, "/v1/chat/completions");
  assert.equal(requests[0].body.model, "tool-model", "the model it will use");
  assert.deepEqual(requests[0].body.tools.map((tool: any) => tool.function.name), ["list_files"]);
  assert.equal(requests[0].body.parallel_tool_calls, false);
  // Text instead of a call, a refusal of tools, or a call of something else: JSON, as before.
  for (const reply of [() => ({ json: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"type":"tool_call","tool":"file.list"}' } }] } }),
    () => ({ status: 400, json: { error: { message: "\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set" } } }),
    () => ({ status: 401, json: { error: { message: "Invalid key good-key-123" } } }),
    () => ({ json: { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] } }] } })]) {
    answer = reply;
    assert.deepEqual(await call({ baseUrl: base, apiKey: "good-key-123", dialect: "chat" }), { models: ["tool-model", "other-model"] });
  }
  assert.deepEqual(warnings, [], "a failed check logs nothing, and never the key");
  // A preset's service has its dialect's tools: it is not asked.
  const before = requests.length;
  assert.deepEqual(await call({ baseUrl: base, apiKey: "good-key-123", dialect: "deepseek" }), { models: ["tool-model", "other-model"] });
  assert.equal(requests.length, before);
});
