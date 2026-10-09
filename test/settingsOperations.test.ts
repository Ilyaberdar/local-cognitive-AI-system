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
import type { AppSettingsPatch, LLMRequest } from "../src/types";

const KEY = "sk-saved-secret-key-1234567890";
const code = (expected: string) => (error: unknown) => error instanceof RemoteOperationError && error.code === expected;
const context = (signal = new AbortController().signal): OperationContext => ({ accountId: "account", deviceId: "mac", signal });

async function setup(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "settings-ops-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new AppSettingsStore(root, config);
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
    // Mixed with an allowed change: refused whole.
    [{ ui: { language: "ru" }, filesystem: { allowedDirectories: ["/"] } }, "host_only"],
    [{ providers: { openai: { model: "x", baseUrl: "https://attacker.example" } } }, "host_only"],
    [{}, "invalid_request"], [{ providers: { openai: { apiKey: "plain-string-key" } } }, "invalid_request"],
    [{ providers: { unknown: { enabled: true } } }, "invalid_request"], [{ llm: { defaultProvider: "unknown" } }, "invalid_request"],
    [{ providers: { ollama: { apiKey: { set: "abcdefgh" } } } }, "invalid_request"], [{ providers: { openai: { version: "1" } } }, "invalid_request"],
    [{ providers: { openai: { apiKey: { set: "two words" } } } }, "invalid_request"], [{ ui: { language: "fr" } }, "invalid_request"]
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
});

test("while the host drains, changes and tests are refused and reading still answers", async t => {
  const f = await setup(t);
  f.state.draining = true;
  await assert.rejects(f.call("settings.update", { ui: { language: "en" } }), code("host_draining"));
  await assert.rejects(f.call("providers.test", { providerId: "openai" }), code("host_draining"));
  assert.ok((await f.call("settings.get")).settings);
});
