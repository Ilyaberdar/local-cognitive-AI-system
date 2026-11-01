import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { RuntimeManager } from "../src/app/RuntimeManager";
import { InferenceApiServer } from "../src/api/inference/InferenceApiServer";
import { InferenceApiStore } from "../src/api/inference/InferenceApiStore";
import { createApiToken } from "../src/api/localApiAuth";
import { AppConfig, config } from "../src/config/config";
import { startBackend } from "../src/index";
import { emptyMcpConfiguration } from "../src/mcp/client/configuration";
import { maskKeyShapes } from "../src/security/keyPatterns";
import type { LLMRequest, LLMResponse } from "../src/types";
import { currentUsageScope } from "../src/usage/UsageScope";
import { Logger } from "../src/utils/Logger";

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }
const call = (port: number, method: string, target: string, headers: Record<string, string> = {}, body?: unknown): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = http.request({ host: "127.0.0.1", port, method, path: target, agent: false, headers: { ...(text ? { "Content-Type": "application/json" } : {}), ...headers } }, response => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { data += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: data }));
    });
    outgoing.once("error", reject);
    outgoing.end(text);
  });
const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = net.createServer().listen(0, "127.0.0.1", () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
});
const events = (body: string) => body.split("\n\n").filter(Boolean).map(block => block.replace(/^data: /, "")).filter(line => !line.startsWith(":"));

type Behaviour = (request: LLMRequest, providerId: string) => Promise<LLMResponse> | LLMResponse;
const answer = (text: string, extra: Partial<LLMResponse> = {}): LLMResponse => ({ provider: "llamacpp", model: "qwen3-8b", text, usage: { inputTokens: 12, outputTokens: 5 }, ...extra });

/** The API on a free port, over a runtime that records each model call and answers as `behaviour` says. */
async function api(t: TestContext, behaviour: Behaviour = () => answer("Hello there")) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lc-inference-api-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls: Array<{ request: LLMRequest; providerId: string; scope: ReturnType<typeof currentUsageScope> }> = [];
  const runtime = {
    providerDescriptors: [
      { id: "llamacpp", name: "Local", configured: true, defaultModel: "", capabilities: { local: true, managed: true, jsonMode: true, reasoning: true } },
      { id: "deepseek", name: "DeepSeek", configured: true, defaultModel: "deepseek-chat", capabilities: { local: false, managed: false, jsonMode: true, reasoning: true } },
      { id: "openai", name: "OpenAI", configured: false, defaultModel: "gpt", capabilities: { local: false, managed: false, jsonMode: true, reasoning: true } }
    ],
    localModelService: { listAllModels: async () => [{ id: "qwen3-8b", displayName: "Qwen3 8B", loaded: true }, { id: "gemma-4b", displayName: "Gemma 4B", loaded: false }] },
    llmService: {
      supportsStructuredOutputs: (id: string) => id === "llamacpp",
      generateText: async (request: LLMRequest, providerId: string) => { calls.push({ request, providerId, scope: currentUsageScope() }); return behaviour(request, providerId); }
    }
  };
  const runtimeManager = { getRuntime: () => runtime, getSettings: async () => ({ providers: { deepseek: { enabled: true, model: "deepseek-chat" }, openai: { enabled: true, model: "gpt" } } }) } as unknown as RuntimeManager;
  const store = new InferenceApiStore(path.join(root, "inference-api.json"));
  const server = new InferenceApiServer({ store, runtimeManager, logger: new Logger(), isDraining: () => false });
  t.after(() => server.close());
  const port = await freePort();
  await store.setConfig({ enabled: true, port });
  const status = await server.apply();
  assert.equal(status.listening, true, status.error);
  const { key } = await store.createKey("news bot");
  const auth = { Authorization: `Bearer ${key}` };
  const post = (body: unknown, headers: Record<string, string> = auth) => call(port, "POST", "/v1/chat/completions", headers, body);
  return { root, port, store, server, key, auth, post, calls };
}

test("API keys are kept as hashes, shown once, listed by name and hint, and revoked at once", async t => {
  const f = await api(t);
  const file = fs.readFileSync(path.join(f.root, "inference-api.json"), "utf8");
  assert.equal(file.includes(f.key), false, "the key itself is never written");
  assert.match(f.key, /^lcsk_[A-Za-z0-9_-]{43}$/);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(f.root, "inference-api.json")).mode & 0o777, 0o600);
  const [listed] = (await f.store.config()).keys;
  assert.deepEqual([listed!.name, listed!.hint, "key" in listed!, "hash" in listed!], ["news bot", f.key.slice(-4), false, false]);
  assert.equal(maskKeyShapes(`token ${f.key} here`), "token <key> here", "logs and reports mask it");
  assert.equal((await call(f.port, "GET", "/v1/models", f.auth)).status, 200);
  assert.equal(await f.store.revokeKey(listed!.id), true);
  assert.equal((await call(f.port, "GET", "/v1/models", f.auth)).status, 401);
  await assert.rejects(f.store.createKey("  "), /name/);
  await assert.rejects(f.store.setConfig({ port: 80 }), /1024/);
});

test("the API answers only its own keys, only at 127.0.0.1 or localhost, and lists loaded local models and set-up providers", async t => {
  const f = await api(t);
  const tries: Array<Record<string, string>> = [{}, { Authorization: "Bearer lcsk_wrong" }, { Authorization: `Bearer ${createApiToken()}` }];
  for (const headers of tries) {
    const reply = await call(f.port, "GET", "/v1/models", headers);
    assert.equal(reply.status, 401);
    assert.equal(JSON.parse(reply.body).error.code, "invalid_api_key");
  }
  const rebound = await call(f.port, "GET", "/v1/models", { ...f.auth, Host: `evil.example:${f.port}` });
  assert.equal(rebound.status, 403);
  const models = JSON.parse((await call(f.port, "GET", "/v1/models", f.auth)).body);
  assert.deepEqual(models.data.map((model: { id: string; owned_by: string }) => [model.id, model.owned_by]), [["qwen3-8b", "local"], ["deepseek/deepseek-chat", "deepseek"]]);
  const missing = await call(f.port, "GET", "/v1/other", f.auth);
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).error.code, "not_found");
});

test("a chat completion is one model call with the conversation, the system prompt and the sampling asked for", async t => {
  const f = await api(t, () => answer("<think>Let me see.</think>\n\nParis is the capital.\nUser: more"));
  const reply = await f.post({ model: "qwen3-8b", temperature: 0.2, top_p: 0.9, max_tokens: 200, seed: 7, stop: ["\nUser:"], unknown_field: true,
    messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Capital of France?" }, { role: "assistant", content: "Paris." }, { role: "user", content: [{ type: "text", text: "Sure?" }] }] });
  assert.equal(reply.status, 200, reply.body);
  const body = JSON.parse(reply.body);
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "qwen3-8b");
  assert.deepEqual(body.choices[0].message, { role: "assistant", content: "Paris is the capital." }, "no reasoning, cut at the stop sequence");
  assert.deepEqual(body.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
  const [{ request, providerId, scope }] = f.calls;
  assert.equal(providerId, "llamacpp");
  assert.equal(request.model, "qwen3-8b");
  assert.equal(request.systemPrompt, "Be brief.");
  assert.equal(request.prompt, "User: Capital of France?\n\nAssistant: Paris.\n\nUser: Sure?\n\nAssistant:");
  assert.deepEqual([request.temperature, request.maxTokens, request.sampling], [0.2, 200, { temperature: 0.2, topP: 0.9, seed: 7 }]);
  assert.equal(request.holder, "the API (news bot)");
  assert.deepEqual(scope, { origin: "api", purpose: "api", runId: (await f.store.config()).keys[0]!.id }, "usage is recorded as the API's");

  await f.post({ model: "deepseek/deepseek-v4", messages: [{ role: "user", content: "Hi" }] });
  assert.deepEqual([f.calls[1]!.providerId, f.calls[1]!.request.model, f.calls[1]!.request.prompt, f.calls[1]!.request.systemPrompt], ["deepseek", "deepseek-v4", "Hi", undefined]);
});

test("a streamed completion sends deltas without the reasoning, holds back a possible stop sequence, then the finish, usage and [DONE]", async t => {
  const f = await api(t, (request) => {
    for (const delta of ["<think>hm", "m</think>", "Hello", " wor", "ld\nEN", "D more"]) request.onTextDelta?.(delta);
    return answer("Hello world\nEND more");
  });
  const reply = await f.post({ model: "qwen3-8b", stream: true, stream_options: { include_usage: true }, stop: "\nEND", messages: [{ role: "user", content: "Hi" }] });
  assert.equal(reply.headers["content-type"], "text/event-stream; charset=utf-8");
  const lines = events(reply.body);
  assert.equal(lines.at(-1), "[DONE]");
  const chunks = lines.slice(0, -1).map(line => JSON.parse(line));
  assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant", content: "" });
  const text = chunks.flatMap((chunk: any) => chunk.choices.map((choice: any) => choice.delta.content ?? "")).join("");
  assert.equal(text, "Hello world");
  assert.ok(chunks.filter((chunk: any) => chunk.choices[0]?.delta?.content).length >= 2, "sent as it is written");
  assert.equal(chunks.find((chunk: any) => chunk.choices[0]?.finish_reason)?.choices[0].finish_reason, "stop");
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
  assert.deepEqual(chunks.at(-1).choices, []);

  // A cloud model that does not stream: its answer comes as one chunk.
  const cloud = await api(t, () => answer("All at once", { provider: "deepseek" }));
  const once = events((await cloud.post({ model: "deepseek/deepseek-chat", stream: true, messages: [{ role: "user", content: "Hi" }] })).body);
  assert.deepEqual(once.slice(0, -1).map(line => JSON.parse(line).choices[0].delta.content ?? null).filter(Boolean), ["All at once"]);
});

test("a local model thinks within a budget: Balanced as in the app's chats, at most half of max_tokens, or the level asked for", async t => {
  const f = await api(t);
  const messages = [{ role: "user", content: "Hi" }];
  const last = () => f.calls.at(-1)!.request;
  await f.post({ model: "qwen3-8b", messages });
  assert.equal(last().localReasoningBudget, 512);
  assert.match(last().localReasoningBudgetMessage!, /give my answer/);
  assert.equal(last().reasoningEffort, undefined, "the provider's own level stays unless the request names one");
  await f.post({ model: "qwen3-8b", messages, max_tokens: 64 });
  assert.equal(last().localReasoningBudget, 32, "the answer keeps the other half");
  await f.post({ model: "qwen3-8b", messages, reasoning_effort: "high" });
  assert.equal(last().localReasoningBudget, 1024);
  assert.equal(last().reasoningEffort, "high");
  await f.post({ model: "qwen3-8b", messages, reasoning_effort: "minimal" });
  assert.equal(last().localReasoningBudget, 128);
  assert.equal(last().reasoningEffort, "low");
  await f.post({ model: "qwen3-8b", messages, reasoning_effort: "none" });
  assert.equal(last().localReasoningBudget, 0, "no thinking at all");
  assert.equal(last().localReasoningBudgetMessage, undefined);
  assert.equal(last().reasoningEffort, undefined);
  await f.post({ model: "qwen3-8b", messages, max_tokens: 1 });
  assert.equal(last().localReasoningBudget, 0);
  const wrong = await f.post({ model: "qwen3-8b", messages, reasoning_effort: "extreme" });
  assert.equal(wrong.status, 400);
  assert.match(JSON.parse(wrong.body).error.message, /reasoning_effort/);
});

test("the token limit is an answer with finish_reason length, in each provider's words: never a failure, never \"stop\"", async t => {
  const limits: Array<[string, Partial<LLMResponse>]> = [
    ["OpenAI-compatible", { error: "Model response stopped: length. No action was executed.", raw: { choices: [{ finish_reason: "length" }] } }],
    ["a bounded local answer", { raw: { choices: [{ finish_reason: "length" }] } }],
    ["the Responses API", { error: "Model response stopped.", raw: { incomplete_details: { reason: "max_output_tokens" } } }],
    ["Anthropic", { error: "Anthropic response stopped: max_tokens.", raw: { stop_reason: "max_tokens" } }],
    ["Gemini", { error: "Gemini response stopped: MAX_TOKENS.", raw: { candidates: [{ finishReason: "MAX_TOKENS" }] } }],
    ["Ollama", { error: "Model response stopped at the token limit. No action was executed.", raw: { done_reason: "length" } }]
  ];
  for (const [name, extra] of limits) {
    const f = await api(t, () => answer("Once upon a", extra));
    const reply = await f.post({ model: "qwen3-8b", max_tokens: 4, messages: [{ role: "user", content: "A story" }] });
    assert.equal(reply.status, 200, name);
    const choice = JSON.parse(reply.body).choices[0];
    assert.deepEqual([choice.message.content, choice.finish_reason], ["Once upon a", "length"], name);
  }

  // All of it went on thinking: an empty answer, as OpenAI's reasoning models give.
  const thought = await api(t, () => answer("", { error: "The model returned no final answer: it stopped without writing any text.", raw: { choices: [{ finish_reason: "length" }] } }));
  const empty = await thought.post({ model: "qwen3-8b", max_tokens: 4, messages: [{ role: "user", content: "A story" }] });
  assert.equal(empty.status, 200);
  assert.deepEqual([JSON.parse(empty.body).choices[0].message.content, JSON.parse(empty.body).choices[0].finish_reason], ["", "length"]);

  // Streamed; a stop sequence met before the limit is still "stop"; cut JSON is the client's to read.
  const cut = { raw: { choices: [{ finish_reason: "length" }] } };
  const streamed = await api(t, (request) => { request.onTextDelta?.("Once upon a"); return answer("Once upon a", cut); });
  const chunks = events((await streamed.post({ model: "qwen3-8b", stream: true, messages: [{ role: "user", content: "A story" }] })).body).slice(0, -1).map(line => JSON.parse(line));
  assert.equal(chunks.find((chunk: any) => chunk.choices[0]?.finish_reason)?.choices[0].finish_reason, "length");
  assert.equal(chunks.flatMap((chunk: any) => chunk.choices.map((choice: any) => choice.delta.content ?? "")).join(""), "Once upon a");
  const stopped = await api(t, () => answer("Once upon a", cut));
  assert.equal(JSON.parse((await stopped.post({ model: "qwen3-8b", stop: "upon", messages: [{ role: "user", content: "A story" }] })).body).choices[0].finish_reason, "stop");
  const json = await api(t, () => answer('{"topic": "ra', cut));
  const partial = await json.post({ model: "qwen3-8b", response_format: { type: "json_object" }, messages: [{ role: "user", content: "JSON" }] });
  assert.equal(partial.status, 200);
  assert.equal(JSON.parse(partial.body).choices[0].finish_reason, "length");
});

test("JSON output: a provider without structured outputs gets JSON mode and the schema; an answer that is not JSON is refused", async t => {
  let reply = "```json\n{\"title\": \"News\"}\n```";
  const f = await api(t, () => answer(reply));
  const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
  const ok = await f.post({ model: "deepseek/deepseek-chat", response_format: { type: "json_schema", json_schema: { name: "story", schema } }, messages: [{ role: "system", content: "Classify." }, { role: "user", content: "x" }] });
  assert.equal(JSON.parse(ok.body).choices[0].message.content, "{\"title\": \"News\"}", "without the code fence");
  assert.deepEqual(f.calls[0]!.request.responseFormat, { type: "json_object" });
  assert.match(f.calls[0]!.request.systemPrompt ?? "", /^Classify\.\n\nAnswer with one JSON value that matches this JSON Schema/);
  await f.post({ model: "qwen3-8b", response_format: { type: "json_schema", json_schema: { name: "story", schema } }, messages: [{ role: "user", content: "x" }] });
  assert.deepEqual(f.calls[1]!.request.responseFormat, { type: "json_schema", name: "story", schema, strict: true }, "enforced where the provider can");
  reply = "Sorry, no.";
  const bad = await f.post({ model: "qwen3-8b", response_format: { type: "json_object" }, messages: [{ role: "user", content: "x" }] });
  assert.equal(bad.status, 422);
  assert.equal(JSON.parse(bad.body).error.code, "invalid_json_output");
});

test("what cannot be answered says why, in OpenAI's error shape", async t => {
  const f = await api(t, (request) => request.model === "deepseek-chat"
    ? answer("", { error: "DeepSeek refused the API key (HTTP 401): Authentication Fails" })
    : answer("ok"));
  const cases: Array<[unknown, number, string]> = [
    [{ model: "nope", messages: [{ role: "user", content: "x" }] }, 404, "model_not_found"],
    [{ model: "gemma-4b", messages: [{ role: "user", content: "x" }] }, 409, "model_not_loaded"],
    [{ model: "openai/gpt", messages: [{ role: "user", content: "x" }] }, 404, "model_not_found"],
    [{ model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "x" }] }, 502, "upstream_key_refused"],
    [{ model: "qwen3-8b", messages: [{ role: "user", content: "x" }], tools: [{ type: "function" }] }, 400, "unsupported_parameter"],
    [{ model: "qwen3-8b", messages: [{ role: "user", content: "x" }], n: 2 }, 400, "unsupported_parameter"],
    [{ model: "qwen3-8b", messages: [{ role: "assistant", content: "x" }] }, 400, "invalid_request_error"],
    [{ model: "qwen3-8b", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] }, 400, "invalid_image"],
    [{ messages: [] }, 400, "invalid_request_error"]
  ];
  for (const [body, status, code] of cases) {
    const reply = await f.post(body);
    assert.equal(reply.status, status, `${JSON.stringify(body)} → ${reply.body}`);
    assert.equal(JSON.parse(reply.body).error.code, code, JSON.stringify(body));
  }
  const image = "data:image/png;base64,iVBORw0KGgo=";
  await f.post({ model: "qwen3-8b", messages: [{ role: "user", content: [{ type: "text", text: "What is it?" }, { type: "image_url", image_url: { url: image } }] }] });
  assert.deepEqual(f.calls.at(-1)!.request.images, [{ name: "image-1", dataUrl: image }]);
  const broken = await call(f.port, "POST", "/v1/chat/completions", { ...f.auth, "Content-Type": "application/json" }, undefined);
  assert.equal(broken.status, 400);
});

test("one key runs at most four requests at once; the fifth is told to retry", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await api(t, async () => { await gate; return answer("done"); });
  const first = Array.from({ length: 4 }, () => f.post({ model: "qwen3-8b", messages: [{ role: "user", content: "x" }] }));
  while (f.calls.length < 4) await new Promise(resolve => setTimeout(resolve, 10));
  const fifth = await f.post({ model: "qwen3-8b", messages: [{ role: "user", content: "x" }] });
  assert.equal(fifth.status, 429);
  assert.equal(fifth.headers["retry-after"], "2");
  release();
  assert.deepEqual((await Promise.all(first)).map(reply => reply.status), [200, 200, 200, 200]);
  assert.equal((await f.post({ model: "qwen3-8b", messages: [{ role: "user", content: "x" }] })).status, 200);
});

test("in the app, Settings turns the API on, makes a key and revokes it; the app's key and the API's key never open each other's door", { timeout: 60_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lc-inference-backend-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, value]) => [id, { ...value, enabled: false, apiKey: "" }])) as AppConfig["providers"];
  const options: AppConfig = {
    ...config, providers, compatibleProviders: {}, appDataDir: path.join(root, "app"), outputDir: path.join(root, "output"),
    sessions: { baseDir: path.join(root, "sessions") }, memory: { ...config.memory, adapter: "local-json", baseDir: path.join(root, "memory") },
    mcp: { client: emptyMcpConfiguration(), server: { ...config.mcp.server, enabled: false } },
    plugins: { dir: path.resolve(process.cwd(), "plugins"), overrides: {} }, telegram: { ...config.telegram, enabled: false, botToken: "" },
    server: { enabled: true, host: "127.0.0.1", port: 0 }, ui: { publicDir: path.join(root, "public"), serve: false },
    localModels: { ...config.localModels!, runtimeDir: path.join(root, "runtime"), executablePath: undefined, modelsDir: path.join(root, "models"), contextSize: 4096 }
  };
  const token = createApiToken();
  let handle = await startBackend(options, {}, { runtimeKind: "test", apiToken: token });
  t.after(() => handle.dispose());
  const main = () => handle.status().http!.port;
  const app = { Authorization: `Bearer ${token}`, "X-Local-Cognitive": "1" };
  assert.equal(JSON.parse((await call(main(), "GET", "/inference-api", app)).body).enabled, false, "off until it is turned on");
  const port = await freePort();
  const on = JSON.parse((await call(main(), "PUT", "/inference-api", app, { enabled: true, port })).body);
  assert.deepEqual([on.enabled, on.listening, on.url], [true, true, `http://127.0.0.1:${port}/v1`]);
  const made = await call(main(), "POST", "/inference-api/keys", app, { name: "news bot" });
  assert.equal(made.status, 201);
  const { key, id } = JSON.parse(made.body);
  assert.equal(JSON.parse((await call(main(), "GET", "/inference-api", app)).body).keys[0].name, "news bot");
  assert.equal(JSON.stringify(JSON.parse((await call(main(), "GET", "/inference-api", app)).body)).includes(key), false, "listed without the key");

  assert.equal((await call(port, "GET", "/v1/models", { Authorization: `Bearer ${key}` })).status, 200);
  assert.equal((await call(port, "GET", "/v1/models", { Authorization: `Bearer ${token}` })).status, 401, "the app's key opens nothing here");
  assert.equal((await call(main(), "GET", "/inference-api", { Authorization: `Bearer ${key}` })).status, 401, "the API's key opens nothing of the app");
  assert.equal((await call(main(), "GET", "/sessions", { Authorization: `Bearer ${key}` })).status, 401);

  // It comes back on with the app.
  await handle.dispose();
  handle = await startBackend(options, {}, { runtimeKind: "test", apiToken: token });
  assert.equal((await call(port, "GET", "/v1/models", { Authorization: `Bearer ${key}` })).status, 200);
  assert.equal((await call(main(), "DELETE", `/inference-api/keys/${id}`, app)).status, 204);
  assert.equal((await call(port, "GET", "/v1/models", { Authorization: `Bearer ${key}` })).status, 401);
  assert.equal(JSON.parse((await call(main(), "PUT", "/inference-api", app, { enabled: false })).body).listening, false);
  await assert.rejects(call(port, "GET", "/v1/models", { Authorization: `Bearer ${key}` }), /ECONNREFUSED/);
});
