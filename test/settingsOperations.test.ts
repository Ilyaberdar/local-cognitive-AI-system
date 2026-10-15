import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import type { RuntimeManager } from "../src/app/RuntimeManager";
import { validateSettingsPatch } from "../src/app/settingsValidation";
import { config } from "../src/config/config";
import { RemoteOperationError, type OperationContext } from "../src/remote/host/RemoteHost";
import { OPERATIONS } from "../src/runtime/operationCatalog";
import { createSettingsOperations } from "../src/runtime/settingsOperations";
import { environmentProviders } from "../src/config/environmentProviders";
import { providerPreset } from "../src/llm/providerCatalog";
import http from "node:http";
import type { AppSettingsPatch, LLMRequest } from "../src/types";

const KEY = "sk-saved-secret-key-1234567890";
const code = (expected: string) => (error: unknown) => error instanceof RemoteOperationError && error.code === expected;
const context = (signal = new AbortController().signal): OperationContext => ({ accountId: "account", deviceId: "mac", signal });

async function setup(t: TestContext, base = config) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "settings-ops-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new AppSettingsStore(root, base);
  // Keys from this machine's environment are cleared: the fixture decides which keys are saved.
  await store.update({ providers: { openai: { apiKey: KEY, baseUrl: "https://user:pass@api.example.com/v1?token=abc", enabled: true },
    anthropic: { apiKey: "" }, gemini: { apiKey: "" }, lmstudio: { apiKey: "" } },
    telegram: { botToken: "123456:telegram-secret-token" }, filesystem: { outputDir: path.join(root, "out"), allowedDirectories: [root, path.join(root, "more")] } });
  const state = { draining: false, generate: async (request: LLMRequest, providerId: string): Promise<any> => ({ provider: providerId, model: request.model, text: "ok",
    usage: { inputTokens: 3, outputTokens: 1 } }), requests: [] as Array<{ request: LLMRequest; providerId: string }> };
  const runtimeManager = {
    getSettings: () => store.get(),
    updateSettings: async (patch: AppSettingsPatch) => { validateSettingsPatch(patch); return { settings: await store.update(patch) }; },
    getRuntime: () => ({
      llmService: { generateText: (request: LLMRequest, providerId: string) => { state.requests.push({ request, providerId }); return state.generate(request, providerId); } },
      localModelService: { snapshot: () => ({ runtime: { status: "stopped" } }) }
    })
  } as unknown as RuntimeManager;
  const ops = createSettingsOperations({ runtimeManager, isDraining: () => state.draining });
  const call = <T = any>(op: string, payload?: unknown, ctx = context()) => Promise.resolve(ops[op]!(payload, ctx)) as Promise<T>;
  const file = path.join(root, "settings.json");
  return { root, store, state, call, file };
}

test("every settings operation is in the catalog, and none is a command", () => {
  const ops = createSettingsOperations({ runtimeManager: {} as RuntimeManager, isDraining: () => false });
  for (const name of Object.keys(ops)) {
    assert.ok(OPERATIONS[name], `${name} is missing from the operation catalog`);
    assert.equal(OPERATIONS[name]!.kind, "request", "a key is never hashed into the command ledger");
  }
});

test("a device sees whether a key is saved, never the key, and no folder, token or internal id", async t => {
  const f = await setup(t);
  const { settings, runtimeStatus } = await f.call("settings.get");
  const exposed = JSON.stringify(settings);
  for (const secret of [KEY, "telegram-secret-token", f.root, "user:pass", "token=abc"]) assert.equal(exposed.includes(secret), false, `${secret} reached the device`);
  for (const field of ["apiKey", "localProfileId", "defaultSessionId", "telegram", "profile", "theme", "modelsDir", "baseDir", "dbPath", "outputDir"]) {
    assert.equal(exposed.includes(`"${field}"`), false, `${field} reached the device`);
  }
  assert.equal(settings.providers.openai.apiKeyState, "set");
  assert.equal(settings.providers.anthropic.apiKeyState, "unset");
  assert.equal(settings.providers.openai.baseUrl, "https://api.example.com");
  assert.equal("apiKeyState" in settings.providers.ollama, false);
  assert.deepEqual(Object.keys(settings.providers.llamacpp).sort(), ["enabled", "model"]);
  assert.deepEqual(settings.filesystem, { accessMode: "restricted", allowedDirectoryCount: 2 });
  assert.equal(runtimeStatus, "stopped");
});

test("chat defaults, providers, runtime, agent limits and memory tuning change from a device", async t => {
  const f = await setup(t);
  const { settings } = await f.call("settings.update", {
    ui: { language: "en", mode: "code" }, llm: { defaultProvider: "openai" },
    providers: { openai: { model: "gpt-4.1-mini", timeoutMs: 90_000 }, anthropic: { version: "2023-06-01", maxTokens: 4096, enabled: true } },
    localModels: { contextSize: 8192 }, agentLimits: { maxSteps: 40 },
    memory: { topK: 12, worldPartition: { strategy: "partitioned" }, openMemory: { enabled: true } }
  });
  assert.deepEqual([settings.ui.language, settings.ui.mode, settings.llm.defaultProvider], ["en", "code", "openai"]);
  assert.deepEqual([settings.providers.openai.model, settings.providers.openai.timeoutMs, settings.providers.anthropic.maxTokens], ["gpt-4.1-mini", 90_000, 4096]);
  assert.deepEqual([settings.localModels.contextSize, settings.agentLimits.maxSteps, settings.memory.topK, settings.memory.worldPartition.strategy, settings.memory.openMemory.enabled],
    [8192, 40, 12, "partitioned", true]);
  assert.equal((await f.store.get()).providers.openai.apiKey, KEY, "a change without a key keeps the saved one");
});

test("host-only, deferred and per-device settings are refused with the reason, and nothing is written", async t => {
  const f = await setup(t);
  const before = await fs.readFile(f.file, "utf8");
  const refused: Array<[unknown, string]> = [
    [{ filesystem: { accessMode: "full" } }, "host_only"], [{ localModels: { modelsDir: "/srv/other" } }, "host_only"],
    [{ providers: { openai: { baseUrl: "https://attacker.example/v1" } } }, "host_only"], [{ memory: { baseDir: "/tmp/x" } }, "host_only"],
    [{ memory: { openMemory: { dbPath: "/tmp/x.db" } } }, "host_only"], [{ mcp: { server: { enabled: true } } }, "host_only"],
    [{ telegram: { botToken: "x" } }, "host_only"], [{ mcp: { client: { servers: {} } } }, "unsupported"], [{ plugins: {} }, "unsupported"],
    [{ profile: { displayName: "Someone" } }, "client_setting"], [{ ui: { theme: "light" } }, "client_setting"],
    [{ ui: { sendKey: "mod-enter" } }, "client_setting"], [{ ui: { shortcuts: { newChat: "Mod+KeyK" } } }, "client_setting"],
    // Mixed with an allowed change: refused whole.
    [{ ui: { language: "ru" }, filesystem: { allowedDirectories: ["/"] } }, "host_only"],
    [{ providers: { openai: { model: "x", baseUrl: "https://attacker.example" } } }, "host_only"],
    [{}, "invalid_request"], [{ providers: { openai: { apiKey: "plain-string-key" } } }, "invalid_request"],
    [{ providers: { unknown: { enabled: true } } }, "invalid_request"], [{ llm: { defaultProvider: "unknown" } }, "invalid_request"],
    [{ providers: { ollama: { apiKey: { set: "abcdefgh" } } } }, "invalid_request"], [{ providers: { openai: { version: "1" } } }, "invalid_request"],
    [{ providers: { openai: { apiKey: { set: "two words" } } } }, "invalid_request"], [{ ui: { language: "fr" } }, "invalid_request"],
    // Names an object has through its prototype are not providers.
    [{ providers: { toString: { apiKey: { set: "sk-planted-key-1234" } } } }, "invalid_request"], [{ providers: { hasOwnProperty: { enabled: true } } }, "invalid_request"],
    [{ llm: { defaultProvider: "toString" } }, "invalid_request"], [{ llm: { defaultProvider: "constructor" } }, "invalid_request"],
    [JSON.parse('{"providers":{"__proto__":{"enabled":true}}}'), "invalid_request"]
  ];
  for (const [patch, expected] of refused) await assert.rejects(f.call("settings.update", patch), code(expected), JSON.stringify(patch));
  assert.equal(await fs.readFile(f.file, "utf8"), before, "the settings file is byte for byte the same");
});

test("a key is written or cleared from a device but never read back", async t => {
  const f = await setup(t);
  const set = await f.call("settings.update", { providers: { anthropic: { apiKey: { set: "sk-ant-new-key-abcdef" } } } });
  assert.equal(set.settings.providers.anthropic.apiKeyState, "set");
  assert.equal(JSON.stringify(set).includes("sk-ant-new-key-abcdef"), false);
  assert.equal((await f.store.get()).providers.anthropic.apiKey, "sk-ant-new-key-abcdef");
  const cleared = await f.call("settings.update", { providers: { openai: { apiKey: { clear: true } } } });
  assert.equal(cleared.settings.providers.openai.apiKeyState, "unset");
  assert.equal((await f.store.get()).providers.openai.apiKey ?? "", "");
});

test("a provider test uses the saved key on the host and answers without it", async t => {
  const f = await setup(t);
  const passed = await f.call("providers.test", { providerId: "openai" });
  assert.equal(passed.ok, true);
  assert.equal(f.state.requests.at(-1)!.providerId, "openai");
  assert.ok(f.state.requests.at(-1)!.request.signal, "a device that goes away stops the test");
  f.state.generate = async () => ({ provider: "openai", model: "gpt", text: "", error: `401 Incorrect API key provided: ${KEY}. See ${f.root}/logs for more. Also sk-other-leaked-key-123456` });
  const failed = await f.call("providers.test", { providerId: "openai", model: "gpt" });
  assert.equal(failed.ok, false);
  for (const secret of [KEY, "sk-other-leaked-key-123456", f.root]) assert.equal(JSON.stringify(failed).includes(secret), false, `${secret} reached the device`);
  assert.match(failed.message, /Incorrect API key provided: <key>/);
  f.state.generate = async () => { throw new Error(`connect ECONNREFUSED with ${KEY}`); };
  assert.equal(JSON.stringify(await f.call("providers.test", { providerId: "openai" })).includes(KEY), false);
  await f.call("settings.update", { providers: { gemini: { enabled: false } } });
  assert.deepEqual(await f.call("providers.test", { providerId: "gemini" }), { ok: false, providerId: "gemini", message: "Provider is disabled." });
  await assert.rejects(f.call("providers.test", { providerId: "llamacpp" }), code("unsupported"));
  await assert.rejects(f.call("providers.test", { providerId: "nope" }), code("invalid_request"));
  await assert.rejects(f.call("providers.test", { providerId: "toString" }), code("invalid_request"));
});

test("while the host drains, changes and tests are refused and reading still answers", async t => {
  const f = await setup(t);
  f.state.draining = true;
  await assert.rejects(f.call("settings.update", { ui: { language: "en" } }), code("host_draining"));
  await assert.rejects(f.call("providers.test", { providerId: "openai" }), code("host_draining"));
  assert.ok((await f.call("settings.get")).settings);
});


test("a device adds a preset to the server with its key and model, never an address; the server picks the id", async t => {
  const f = await setup(t);
  const added = await f.call("providers.add", { preset: "deepseek", apiKey: { set: "sk-device-deepseek-1234567" }, model: "deepseek-flash" });
  assert.equal(added.id, "deepseek");
  const saved = (await f.store.get()).providers.deepseek!;
  assert.deepEqual([saved.kind, saved.dialect, saved.preset, saved.name, saved.baseUrl, saved.model, saved.enabled], ["openai-compatible", "deepseek", "deepseek", "DeepSeek", providerPreset("deepseek")!.baseUrl, "deepseek-flash", true]);
  assert.equal(JSON.stringify(added).includes("sk-device-deepseek"), false, "the key comes back in no answer");
  assert.deepEqual(added.settings.providers.deepseek, { enabled: true, model: "deepseek-flash", timeoutMs: 300000, baseUrl: "https://api.deepseek.com", kind: "openai-compatible", name: "DeepSeek",
    preset: "deepseek", removable: true, apiKeyState: "set" });
  const second = await f.call("providers.add", { preset: "deepseek", apiKey: { set: "sk-device-deepseek-7654321" }, model: "deepseek-v4-pro" });
  assert.deepEqual([second.id, (await f.store.get()).providers["deepseek-2"]!.name], ["deepseek-2", "DeepSeek 2"]);
  for (const payload of [
    { preset: "deepseek", apiKey: { set: "sk-x-1234567" }, model: "m", baseUrl: "http://169.254.169.254/latest" },
    { preset: "deepseek", apiKey: { set: "sk-x-1234567" }, model: "m", region: "sg" },
    { preset: "qwen", apiKey: { set: "sk-x-1234567" }, model: "m" },
    { preset: "openai", apiKey: { set: "sk-x-1234567" }, model: "m" },
    { preset: "__proto__", apiKey: { set: "sk-x-1234567" }, model: "m" },
    { preset: "deepseek", apiKey: { clear: true }, model: "m" },
    { preset: "deepseek", apiKey: { set: "sk-x-1234567" } }
  ]) await assert.rejects(async () => f.call("providers.add", payload), code("invalid_request"), JSON.stringify(payload));
  const { presets } = await f.call("settings.get");
  assert.deepEqual(presets.map((preset: { id: string }) => preset.id), ["deepseek", "openrouter", "groq", "perplexity"]);
  assert.equal(JSON.stringify(presets).includes("API_KEY"), false, "no environment names");
});

test("a device renames and removes a provider added on the server, never a built-in, Qwen, the default or one the environment sets", async t => {
  const f = await setup(t, { ...config, compatibleProviders: environmentProviders({ PERPLEXITY_API_KEY: "pplx-environment-key-123" }, 300000).providers });
  await f.call("providers.add", { preset: "groq", apiKey: { set: "gsk-device-groq-1234567" }, model: "openai/gpt-oss-120b" });
  await f.call("settings.update", { providers: { groq: { name: "Groq (fast)" } } });
  assert.equal((await f.store.get()).providers.groq!.name, "Groq (fast)");
  const view = (await f.call("settings.get")).settings.providers;
  assert.deepEqual([view.perplexity.source, view.perplexity.apiKeyState, view.perplexity.removable], ["environment", "environment", false]);
  assert.equal(JSON.stringify(view).includes("pplx-environment"), false);
  await assert.rejects(f.call("settings.update", { providers: { perplexity: null } }), code("host_only"));
  await assert.rejects(f.call("settings.update", { providers: { perplexity: { apiKey: { set: "pplx-other-123456" } } } }), code("host_only"));
  await assert.rejects(f.call("settings.update", { providers: { perplexity: { name: "Mine" } } }), code("host_only"));
  for (const id of ["openai", "qwen"]) {
    await assert.rejects(f.call("settings.update", { providers: { [id]: null } }), code("invalid_request"), id);
    await assert.rejects(f.call("settings.update", { providers: { [id]: { name: "Renamed" } } }), code("invalid_request"), id);
  }
  await f.call("settings.update", { llm: { defaultProvider: "groq" } });
  await assert.rejects(f.call("settings.update", { providers: { groq: null } }), code("invalid_request"), "the default provider stays");
  assert.equal((await f.call("settings.get")).settings.providers.groq.removable, false);
  await f.call("settings.update", { llm: { defaultProvider: "llamacpp" } });
  await f.call("settings.update", { providers: { groq: null } });
  assert.equal((await f.store.get()).providers.groq, undefined);
});

test("Add provider reads the preset's models at the server's own address for it; a refused key says so; keys never come back", async t => {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url} ${request.headers.authorization}`);
    if (request.headers.authorization !== "Bearer sk-good-key-1234567") { response.writeHead(401).end(JSON.stringify({ error: { message: "bad key sk-good-key-1234567" } })); return; }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const previous = process.env.DEEPSEEK_BASE_URL;
  // The owner's override in the server's environment is the address; a device never sends one.
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  t.after(() => { if (previous === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = previous; });
  const f = await setup(t);
  assert.deepEqual(await f.call("providers.discover", { preset: "deepseek", apiKey: { set: "sk-good-key-1234567" } }), { models: ["deepseek-flash", "deepseek-v4-pro"] });
  await assert.rejects(f.call("providers.discover", { preset: "deepseek", apiKey: { set: "sk-wrong-key-1234567" } }), (error: unknown) =>
    error instanceof RemoteOperationError && error.code === "provider_unreachable" && /refused this key/.test(error.message) && !error.message.includes("sk-"));
  await assert.rejects(async () => f.call("providers.discover", { preset: "deepseek", apiKey: { set: "sk-good-key-1234567" }, baseUrl: "http://10.0.0.1" }), code("invalid_request"));
  assert.ok(seen.every(line => line.startsWith("GET /models")), seen.join("\n"));
  assert.equal(seen.length, 2, "nothing is saved, nothing else is called");
  assert.equal((await f.store.get()).providers.deepseek, undefined);
});

test("a provider test's answer never carries a key the server has from its environment", async t => {
  const previous = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = "pplx-environment-secret-98765";
  t.after(() => { if (previous === undefined) delete process.env.PERPLEXITY_API_KEY; else process.env.PERPLEXITY_API_KEY = previous; });
  const f = await setup(t);
  f.state.generate = async (_request, providerId) => ({ provider: providerId, model: "m", text: "", error: "401 for key pplx-environment-secret-98765" });
  const result = await f.call("providers.test", { providerId: "openai" });
  assert.equal(result.ok, false);
  assert.equal(result.message.includes("pplx-environment-secret"), false, result.message);
});
