import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import { config, type AppConfig } from "../src/config/config";
import { environmentProviders } from "../src/config/environmentProviders";
import { childProcessEnv } from "../src/config/secrets";
import { providerPreset } from "../src/llm/providerCatalog";
import { Logger } from "../src/utils/Logger";

test("the environment sets every cloud provider a server needs: presets by their key, the owner's own services by address", () => {
  const { providers, refused } = environmentProviders({
    DEEPSEEK_API_KEY: "sk-env-deepseek", PERPLEXITY_API_KEY: " pplx-env ", GROQ_API_KEY: "", OPENROUTER_BASE_URL: "https://openrouter.example/v1",
    LOCAL_COGNITIVE_PROVIDER_LAB_BASE_URL: "https://llm.lab.example/v1", LOCAL_COGNITIVE_PROVIDER_LAB_API_KEY: "sk-env-lab", LOCAL_COGNITIVE_PROVIDER_LAB_MODEL: "lab-large",
    LOCAL_COGNITIVE_PROVIDER_LAB_NAME: "Lab GPU", LOCAL_COGNITIVE_PROVIDER_LAB_TIMEOUT_MS: "120000",
    LOCAL_COGNITIVE_PROVIDER_MY_VLLM_BASE_URL: "http://10.0.0.5:8000/v1",
    LOCAL_COGNITIVE_PROVIDER_OPENAI_BASE_URL: "https://elsewhere.example/v1", LOCAL_COGNITIVE_PROVIDER_DEEPSEEK_BASE_URL: "https://elsewhere.example/v1",
    LOCAL_COGNITIVE_PROVIDER_BAD_BASE_URL: "ftp://files.example", LOCAL_COGNITIVE_PROVIDER_CREDS_BASE_URL: "https://user:pass@llm.example/v1",
    LOCAL_COGNITIVE_PROVIDER_ODD_BASE_URL: "https://odd.example/v1", LOCAL_COGNITIVE_PROVIDER_ODD_DIALECT: "nonsense"
  }, 300_000);
  assert.deepEqual(Object.keys(providers).sort(), ["deepseek", "lab", "my-vllm", "perplexity", "qwen"], "Groq's key is empty; OpenRouter has only an address");
  assert.deepEqual(providers.deepseek, { name: "DeepSeek", dialect: "deepseek", baseUrl: providerPreset("deepseek")!.baseUrl, model: "deepseek-flash", timeoutMs: 300_000,
    apiKey: "sk-env-deepseek", preset: "deepseek", source: "environment" });
  assert.equal(providers.perplexity!.apiKey, "pplx-env", "a key is trimmed");
  assert.equal(providers.qwen!.source, undefined, "Qwen is in every installation, not only the environment's");
  assert.equal(providers.qwen!.apiKey, undefined);
  assert.deepEqual(providers.lab, { name: "Lab GPU", dialect: "chat", baseUrl: "https://llm.lab.example/v1", model: "lab-large", timeoutMs: 120_000, apiKey: "sk-env-lab", source: "environment" });
  assert.deepEqual(providers["my-vllm"], { name: "my-vllm", dialect: "chat", baseUrl: "http://10.0.0.5:8000/v1", model: "", timeoutMs: 300_000, source: "environment" }, "a service on the owner's network needs no key");
  assert.equal(refused.length, 5);
  for (const pattern of [/OPENAI_\*: openai is a built-in/, /DEEPSEEK_\*: deepseek is a built-in or preset/, /BAD_BASE_URL/, /CREDS_BASE_URL/, /ODD_DIALECT: unknown dialect nonsense/]) {
    assert.ok(refused.some(item => pattern.test(item)), String(pattern));
  }
  assert.equal(refused.join(" ").includes("pass"), false, "a refusal never repeats an address's credentials");
});

test("their keys never reach child processes", () => {
  const env = childProcessEnv({ PATH: "/bin", DEEPSEEK_API_KEY: "sk-1", PERPLEXITY_API_KEY: "p-1", OPENROUTER_API_KEY: "o-1", GROQ_API_KEY: "g-1",
    LOCAL_COGNITIVE_PROVIDER_LAB_API_KEY: "sk-lab", LOCAL_COGNITIVE_PROVIDER_LAB_BASE_URL: "https://llm.lab.example/v1" });
  assert.deepEqual(Object.keys(env).sort(), ["LOCAL_COGNITIVE_PROVIDER_LAB_BASE_URL", "PATH"]);
});

async function manager(t: TestContext, env: NodeJS.ProcessEnv, root?: string) {
  const { RuntimeManager } = await import("../src/app/RuntimeManager");
  const base = root ?? await fs.mkdtemp(path.join(os.tmpdir(), "server-providers-"));
  if (!root) t.after(() => fs.rm(base, { recursive: true, force: true }));
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, options]) => [id, { ...options, enabled: false, apiKey: "" }])) as typeof config.providers;
  const options: AppConfig = { ...config, providers, compatibleProviders: environmentProviders(env, 300_000).providers, appDataDir: path.join(base, "app"), llm: { defaultProvider: "llamacpp" },
    sessions: { baseDir: path.join(base, "sessions") }, memory: { ...config.memory, adapter: "local-json" as const, baseDir: path.join(base, "memory") }, outputDir: path.join(base, "output"),
    plugins: { dir: path.join(base, "plugins"), overrides: {} }, telegram: { ...config.telegram, enabled: false, botToken: "" },
    localModels: { ...config.localModels!, runtimeDir: path.join(base, "runtime"), executablePath: undefined, modelsDir: path.join(base, "models"), contextSize: 4096 } };
  const runtime = new RuntimeManager(options, new AppSettingsStore(options.appDataDir, options), new Logger());
  await runtime.init();
  t.after(() => runtime.dispose());
  return { manager: runtime, root: base, settingsFile: path.join(options.appDataDir, "settings.json") };
}

test("a provider the environment sets works on the server, its key stays in the environment, and Settings cannot remove or rekey it", async t => {
  const env = { DEEPSEEK_API_KEY: "sk-env-deepseek-key", LOCAL_COGNITIVE_PROVIDER_LAB_BASE_URL: "https://llm.lab.example/v1", LOCAL_COGNITIVE_PROVIDER_LAB_API_KEY: "sk-env-lab-key", LOCAL_COGNITIVE_PROVIDER_LAB_MODEL: "lab-large" };
  const first = await manager(t, env);
  const descriptors = first.manager.getRuntime().providerDescriptors;
  assert.equal(descriptors.find(item => item.id === "deepseek")?.configured, true, "Synthesis, chats and agents can name it");
  assert.deepEqual(descriptors.find(item => item.id === "deepseek")?.catalog?.models, providerPreset("deepseek")!.models);
  assert.equal(descriptors.find(item => item.id === "lab")?.configured, true);
  const { settings } = await first.manager.updateSettings({ providers: { deepseek: { model: "deepseek-v4-pro" } } });
  assert.equal(settings.providers.deepseek!.model, "deepseek-v4-pro", "its model is a setting");
  assert.equal(settings.providers.deepseek!.source, "environment");
  const saved = await fs.readFile(first.settingsFile, "utf8");
  assert.equal(saved.includes("sk-env-deepseek-key") || saved.includes("sk-env-lab-key"), false, "an environment's key is never copied into settings.json");
  for (const patch of [{ deepseek: null }, { deepseek: { apiKey: "sk-other" } }, { lab: { baseUrl: "https://elsewhere.example/v1" } }, { lab: null }]) {
    await assert.rejects(first.manager.updateSettings({ providers: patch as never }), /set in the server's environment file/, JSON.stringify(patch));
  }
  await assert.rejects(first.manager.updateSettings({ providers: { "deepseek-2": { kind: "openai-compatible", dialect: "deepseek", preset: "deepseek", name: "x", baseUrl: "https://api.deepseek.com", model: "m", enabled: true, source: "environment" } as never } }), /source cannot be set/);
  await first.manager.dispose();
  // The key changed in the environment is the one used; removed there, the provider is gone.
  const rekeyed = await manager(t, { ...env, DEEPSEEK_API_KEY: "sk-env-deepseek-rotated" }, first.root);
  assert.equal(rekeyed.manager.getRuntime().providerDescriptors.find(item => item.id === "deepseek")?.configured, true);
  assert.equal((await rekeyed.manager.getSettings()).providers.deepseek!.model, "deepseek-v4-pro", "its model stays");
  await rekeyed.manager.dispose();
  const removed = await manager(t, { LOCAL_COGNITIVE_PROVIDER_LAB_BASE_URL: env.LOCAL_COGNITIVE_PROVIDER_LAB_BASE_URL, LOCAL_COGNITIVE_PROVIDER_LAB_MODEL: "lab-large" }, first.root);
  assert.equal((await removed.manager.getSettings()).providers.deepseek, undefined);
  assert.equal(removed.manager.getRuntime().providerDescriptors.some(item => item.id === "deepseek"), false);
  // Its key removed too: listed, not configured (a service that takes no key gets any value as its key).
  assert.equal(removed.manager.getRuntime().providerDescriptors.find(item => item.id === "lab")?.configured, false);
});
