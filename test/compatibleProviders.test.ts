import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { buildSync } from "esbuild";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import type { RuntimeManager } from "../src/app/RuntimeManager";
import { validateSettingsPatch } from "../src/app/settingsValidation";
import { config } from "../src/config/config";
import { childProcessEnv, SECRET_ENV_KEYS } from "../src/config/secrets";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { CHAT_DIALECT, QWEN_DIALECT, compatibleDialect } from "../src/llm/ProviderDialect";
import { BUILT_IN_PROVIDER_IDS, PROVIDER_PRESETS, providerPreset } from "../src/llm/providerCatalog";
import { RemoteOperationError, type OperationContext } from "../src/remote/host/RemoteHost";
import { createSettingsOperations } from "../src/runtime/settingsOperations";
import type { AppSettingsPatch, LLMRequest } from "../src/types";
import { Logger } from "../src/utils/Logger";

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
  assert.deepEqual(descriptor.capabilities, { local: false, managed: false, jsonMode: true, nativeTools: false, structuredOutputs: false, reasoning: true, vision: true });
});

test("Qwen lists its chat models, and its known models when the list cannot be read", async () => {
  const listing = service(() => Response.json({ data: [{ id: "qwen3.8-max" }, { id: "text-embedding-v4" }, { id: "qwen3-tts-flash" }, { id: "wan2.5-t2i" }, { id: "qwen3.7-plus" }] }));
  assert.deepEqual((await qwen(listing.fetchImpl).listModels()).map(model => model.id), ["qwen3.8-max", "qwen3.7-plus"]);
  assert.equal(listing.calls[0].url, `${SINGAPORE}/models`);
  assert.equal(listing.calls[0].headers.Authorization, "Bearer sk-qwen-test-key");
  const missing = service(() => new Response("not found", { status: 404 }));
  assert.deepEqual((await qwen(missing.fetchImpl).listModels()).map(model => model.id), QWEN_DIALECT.models!.fallback);
  const empty = service(() => Response.json({ data: [] }));
  assert.equal((await qwen(empty.fetchImpl).listModels()).length, QWEN_DIALECT.models!.fallback.length);
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
  const refused: Array<[unknown, RegExp]> = [
    [{ openai: { kind: "openai-compatible" } }, /built in/],
    [{ "Bad Id": { kind: "openai-compatible", dialect: "chat" } }, /provider id/],
    [{ custom: { kind: "openai-compatible", dialect: "anthropic" } }, /dialect/],
    [{ custom: { kind: "something-else" } }, /kind/],
    [{ custom: { kind: "openai-compatible", name: " " } }, /name/],
    [{ custom: { kind: "openai-compatible", name: "x".repeat(81) } }, /name/],
    [{ qwen: { baseUrl: "ftp://dashscope.example/v1" } }, /baseUrl/],
    [{ qwen: { baseUrl: "https://user:secret@dashscope.example/v1" } }, /baseUrl/],
    [{ custom: { kind: "openai-compatible", baseUrl: "not a url" } }, /baseUrl/]
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
  const store = new AppSettingsStore(root, config);
  await store.update({ providers: { qwen: { apiKey: "" } } });
  const runtimeManager = { getSettings: () => store.get(),
    updateSettings: async (patch: AppSettingsPatch) => { validateSettingsPatch(patch); return { settings: await store.update(patch) }; },
    getRuntime: () => ({ llmService: { generateText: async () => ({ text: "ok" }) }, localModelService: { snapshot: () => ({ runtime: { status: "stopped" } }) } }) } as unknown as RuntimeManager;
  const ops = createSettingsOperations({ runtimeManager, isDraining: () => false });
  const context: OperationContext = { accountId: "account", deviceId: "mac", signal: new AbortController().signal };
  const call = (op: string, payload?: unknown) => Promise.resolve(ops[op]!(payload, context)) as Promise<any>;
  await call("settings.update", { providers: { qwen: { apiKey: { set: "sk-qwen-remote-1234" }, model: "qwen3.8-flash" } } });
  const saved = (await store.get()).providers.qwen;
  assert.equal(saved.apiKey, "sk-qwen-remote-1234");
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
  assert.match(page().querySelector('[data-setting="providers.qwen.baseUrl"]').textContent, /US \(Virginia\): https:\/\/dashscope-us/);
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
  assert.deepEqual(perplexity.calls[1].body.tools, [{ type: "web_search" }]);
  assert.deepEqual((await sonar.listModels()).map(model => model.id), ["fast", "low", "medium", "high", "xhigh", "openai/gpt-6-luna", "anthropic/claude-sonnet-5-5"]);
  for (const preset of PROVIDER_PRESETS) {
    assert.ok(preset.models.includes(preset.model), preset.id);
    assert.match(preset.baseUrl, /^https:\/\//);
    assert.equal(compatibleDialect(preset.dialect).id, preset.dialect, preset.id);
  }
});
