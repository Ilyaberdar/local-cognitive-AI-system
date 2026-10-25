import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { createDashboardBootstrapController, createGetAppSettingsController, createUpdateAppSettingsController } from "../src/api/controller";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import { RuntimeManager } from "../src/app/RuntimeManager";
import { SettingsValidationError, validateSettingsPatch } from "../src/app/settingsValidation";
import { AppConfig, config } from "../src/config/config";
import type { CredentialVault } from "../src/plugins/contracts";
import { EncryptedCredentialVault } from "../src/plugins/EncryptedCredentialVault";
import { RemoteOperationError } from "../src/remote/host/RemoteHost";
import { createSettingsOperations } from "../src/runtime/settingsOperations";
import { createAeadVaultCipher } from "../src/security/AeadVaultCipher";
import { resolveHeadlessVault } from "../src/security/headlessVault";
import { initVaultKey, loadVaultKey } from "../src/security/vaultKey";
import { resolveRunVault, RUN_VAULT_REASON } from "../src/security/runVault";
import { environmentProviders } from "../src/config/environmentProviders";
import { AnthropicProvider } from "../src/llm/AnthropicProvider";
import { GeminiProvider } from "../src/llm/GeminiProvider";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { compatibleDialect } from "../src/llm/ProviderDialect";
import type { AppSettings, AppSettingsPatch } from "../src/types";
import { Logger } from "../src/utils/Logger";
import { keyVault } from "./fixtures/keyVault";

const OPENAI_KEY = "sk-canary-openai-0123456789", ANTHROPIC_KEY = "sk-ant-canary-0123456789", BOT_TOKEN = "123456:canary-bot-token-abcdef";
const QWEN_ENV = "sk-canary-qwen-environment-1234", OPENAI_ENV = "sk-canary-openai-environment-1234", BOT_ENV = "654321:canary-bot-environment";
const posix = process.platform !== "win32";

/** An app in a temporary folder, with only the keys its environment is given here. */
async function app(t: TestContext, env: { openai?: string; qwen?: string; telegram?: string; providers?: NodeJS.ProcessEnv } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "provider-keys-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, value]) => [id, { ...value, enabled: false, apiKey: "" }])) as AppConfig["providers"];
  providers.openai = { ...providers.openai, apiKey: env.openai ?? "" };
  const { apiKey: _apiKey, ...qwen } = config.compatibleProviders!.qwen!;
  const options: AppConfig = { ...config, providers, compatibleProviders: { ...(env.providers ? environmentProviders(env.providers, 300_000).providers : {}),
    qwen: { ...qwen, ...(env.qwen ? { apiKey: env.qwen } : {}) } },
    appDataDir: path.join(root, "app"), llm: { defaultProvider: "llamacpp" }, sessions: { baseDir: path.join(root, "sessions") },
    memory: { ...config.memory, adapter: "local-json", baseDir: path.join(root, "memory") }, outputDir: path.join(root, "output"),
    plugins: { dir: path.join(root, "plugins"), overrides: {} }, telegram: { ...config.telegram, enabled: false, botToken: env.telegram ?? "" },
    localModels: { ...config.localModels!, runtimeDir: path.join(root, "runtime"), executablePath: undefined, modelsDir: path.join(root, "models"), contextSize: 4096 } };
  const file = path.join(options.appDataDir, "settings.json");
  const start = async (vault?: CredentialVault, logger = new Logger()) => {
    const store = new AppSettingsStore(options.appDataDir, options, { vault, logger });
    const manager = new RuntimeManager(options, store, logger, {}, { vault });
    await manager.init();
    t.after(() => manager.dispose());
    return { store, manager };
  };
  /** settings.json as 0.1.9 left it: schema 5, with keys in it. */
  const legacy = async (keys: Record<string, string>, telegram?: string) => {
    const settings: any = JSON.parse(JSON.stringify(await new AppSettingsStore(options.appDataDir, options).get()));
    settings.schemaVersion = 5;
    for (const [id, key] of Object.entries(keys)) settings.providers[id].apiKey = key;
    if (telegram) settings.telegram.botToken = telegram;
    await fs.writeFile(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
    return settings;
  };
  return { root, options, file, start, legacy, text: () => fs.readFile(file, "utf8"), json: async () => JSON.parse(await fs.readFile(file, "utf8")) as AppSettings };
}
const record = (vault: ReturnType<typeof keyVault>, name: string) => JSON.parse(vault.values.get(name)!) as { key: string; origin: string };
const records = (vault: ReturnType<typeof keyVault>, prefix: string) => [...vault.values.keys()].filter(name => name.startsWith(prefix));
/** A controller's JSON answer. */
async function answer(controller: (req: any, res: any, next: any) => Promise<void>, body?: unknown): Promise<string> {
  let payload: unknown, failure: unknown;
  const res = { status() { return this; }, json(value: unknown) { payload = value; return this; } };
  await controller({ body, params: {}, query: {} }, res, (error: unknown) => { failure = error; });
  if (failure) throw failure;
  return JSON.stringify(payload);
}

test("keys in settings.json move to the vault, each read back first, and then leave the archives", async t => {
  const f = await app(t, { qwen: QWEN_ENV });
  const legacy = await f.legacy({ openai: OPENAI_KEY, anthropic: ANTHROPIC_KEY, lmstudio: "lm-studio", qwen: QWEN_ENV, gemini: "" }, BOT_TOKEN);
  await fs.writeFile(path.join(f.options.appDataDir, "settings.pre-llamacpp.json"), JSON.stringify(legacy), { mode: 0o644 });
  await fs.writeFile(path.join(f.options.appDataDir, "settings.pre-integrations.json"), JSON.stringify({ ...legacy, plugins: { notion: { enabled: true, values: { apiKey: "notion-legacy-key" } } } }), { mode: 0o600 });
  const vault = keyVault(), store = new AppSettingsStore(f.options.appDataDir, f.options, { vault });
  const settings = await store.get();

  const saved = await f.text();
  for (const secret of [OPENAI_KEY, ANTHROPIC_KEY, BOT_TOKEN, QWEN_ENV]) assert.equal(saved.includes(secret), false, `${secret} is still in settings.json`);
  assert.doesNotMatch(saved, /"apiKey"|"botToken"/);
  assert.equal(settings.schemaVersion, 6);
  assert.deepEqual(record(vault, `provider-key/openai/${settings.providers.openai.apiKeyRef}`), { key: OPENAI_KEY, origin: "https://api.openai.com" });
  assert.deepEqual(record(vault, `provider-key/anthropic/${settings.providers.anthropic.apiKeyRef}`), { key: ANTHROPIC_KEY, origin: "https://api.anthropic.com" });
  assert.equal(settings.providers.qwen.apiKeyRef, undefined, "the environment's own key is not stored");
  assert.equal(settings.providers.lmstudio.apiKeyRef, undefined, "LM Studio's stand-in is no key");
  assert.equal(vault.values.size, 3);
  const keys = await store.resolveKeys(settings);
  assert.deepEqual([keys.providers.openai, keys.providers.qwen, keys.providers.lmstudio, keys.providers.gemini, keys.telegram],
    [{ state: "set", key: OPENAI_KEY }, { state: "environment", key: QWEN_ENV }, { state: "unset" }, { state: "unset" }, { state: "set", key: BOT_TOKEN }]);

  for (const name of ["settings.pre-llamacpp.json", "settings.pre-integrations.json"]) {
    const archive = await fs.readFile(path.join(f.options.appDataDir, name), "utf8");
    for (const secret of [OPENAI_KEY, ANTHROPIC_KEY, BOT_TOKEN, QWEN_ENV]) assert.equal(archive.includes(secret), false, `${secret} is still in ${name}`);
    assert.equal(JSON.parse(archive).providers.openai.model, legacy.providers.openai.model, "the rest of the archive stays");
    if (posix) assert.equal((await fs.stat(path.join(f.options.appDataDir, name))).mode & 0o777, 0o600);
  }
  assert.match(await fs.readFile(path.join(f.options.appDataDir, "settings.pre-integrations.json"), "utf8"), /notion-legacy-key/, "the legacy Notion key never moved to the vault");

  // Once moved, nothing moves again.
  const again = await new AppSettingsStore(f.options.appDataDir, f.options, { vault }).get();
  assert.equal(again.providers.openai.apiKeyRef, settings.providers.openai.apiKeyRef);
  assert.equal(vault.values.size, 3);
});

test("an archive that cannot be read is left as it is, and the log says so", async t => {
  const f = await app(t);
  const legacy = await f.legacy({ openai: OPENAI_KEY });
  const damaged = path.join(f.options.appDataDir, "settings.pre-llamacpp.json");
  await fs.writeFile(damaged, `{"providers":{"openai":{"apiKey":"${OPENAI_KEY}"`);
  await fs.writeFile(path.join(f.options.appDataDir, "settings.pre-integrations.json"), JSON.stringify(legacy));
  const warnings: string[] = [];
  const logger = new (class extends Logger { override log(level: string, message: string) { if (level === "warn") warnings.push(message); } })();
  await new AppSettingsStore(f.options.appDataDir, f.options, { vault: keyVault(), logger }).get();
  assert.equal(await fs.readFile(damaged, "utf8"), `{"providers":{"openai":{"apiKey":"${OPENAI_KEY}"`);
  assert.ok(warnings.some(message => message.includes("settings.pre-llamacpp.json")), warnings.join("\n"));
  assert.equal((await fs.readFile(path.join(f.options.appDataDir, "settings.pre-integrations.json"), "utf8")).includes(OPENAI_KEY), false);
  assert.equal((await f.text()).includes(OPENAI_KEY), false);
});

test("without a usable vault nothing changes on disk: a key in settings.json works, unprotected, a new one is refused, and they move at a start with one", async t => {
  const f = await app(t);
  await f.legacy({ openai: OPENAI_KEY });
  const before = await f.text();
  const { store, manager } = await f.start();
  assert.equal(await f.text(), before, "settings.json is byte for byte the same");
  assert.equal(manager.getRuntime().config.providers.openai.apiKey, OPENAI_KEY, "the key keeps working");
  assert.deepEqual((await manager.providerKeys()).providers.openai, { state: "unprotected", key: OPENAI_KEY });
  const view = await answer(createGetAppSettingsController(manager));
  assert.equal(view.includes(OPENAI_KEY), false);
  assert.match(view, /"openai":\{[^}]*"apiKeyState":"unprotected"/);

  await assert.rejects(manager.updateSettings({ providers: { anthropic: { apiKey: ANTHROPIC_KEY } } }),
    (error: unknown) => error instanceof SettingsValidationError && error.statusCode === 503 && /The key was not saved/.test(error.message));
  assert.equal((await f.text()).includes(ANTHROPIC_KEY), false);
  // Other changes keep it, and it can still be removed.
  await manager.updateSettings({ providers: { openai: { model: "gpt-x" } } });
  assert.equal(manager.getRuntime().config.providers.openai.apiKey, OPENAI_KEY);
  assert.equal((await store.get()).schemaVersion, 5, "tried again at the next start");
  await manager.dispose();

  const vault = keyVault();
  const moved = await f.start(vault);
  assert.equal((await f.text()).includes(OPENAI_KEY), false);
  assert.equal(moved.manager.getRuntime().config.providers.openai.apiKey, OPENAI_KEY);
  assert.equal((await moved.manager.providerKeys()).providers.openai?.state, "set");
  await moved.manager.updateSettings({ providers: { openai: { apiKey: "" } } });
  assert.equal(moved.manager.getRuntime().config.providers.openai.apiKey, undefined);
  assert.equal(vault.values.size, 0);
});

test("a server without a vault key refuses to save a key and says how to set one up", async t => {
  const f = await app(t);
  const { vault } = resolveHeadlessVault(f.options, {});
  const store = new AppSettingsStore(f.options.appDataDir, f.options, { vault });
  await assert.rejects(store.update({ providers: { openai: { apiKey: OPENAI_KEY } } }),
    (error: unknown) => error instanceof SettingsValidationError && error.statusCode === 503 && /local-cognitive-server init/.test(error.message));
  await assert.rejects(store.update({ telegram: { botToken: BOT_TOKEN } }), /local-cognitive-server init/);
  const runtimeManager = { getSettings: () => store.get(), providerKeys: async (settings?: AppSettings) => store.resolveKeys(settings ?? await store.get()),
    updateSettings: async (patch: AppSettingsPatch) => ({ settings: await store.update(patch) }) } as unknown as RuntimeManager;
  const update = createSettingsOperations({ runtimeManager, isDraining: () => false })["settings.update"]!;
  await assert.rejects(Promise.resolve(update({ providers: { openai: { apiKey: { set: OPENAI_KEY } } } }, { accountId: "a", deviceId: "d", signal: new AbortController().signal })),
    (error: unknown) => error instanceof RemoteOperationError && error.code === "unavailable" && /local-cognitive-server init/.test(error.message));
  assert.equal((await f.text()).includes(OPENAI_KEY), false);
});

test("a saved key that cannot be read leaves only its provider without a key; a key entered again works", async t => {
  const f = await app(t);
  const vault = keyVault();
  const first = await f.start(vault);
  await first.manager.updateSettings({ providers: { openai: { apiKey: OPENAI_KEY, enabled: true }, anthropic: { apiKey: ANTHROPIC_KEY, enabled: true } }, agentLimits: { maxSteps: 7 } });
  await first.manager.dispose();
  const [unreadable] = records(vault, "provider-key/openai/");
  vault.unreadable.add(unreadable!);
  const before = await f.text();

  const { manager } = await f.start(vault);
  const configured = (id: string) => manager.getRuntime().providerDescriptors.find(item => item.id === id)?.configured;
  assert.equal(configured("openai"), false);
  assert.equal(configured("anthropic"), true, "the other provider keeps its key");
  assert.equal((await manager.getSettings()).agentLimits.maxSteps, 7);
  assert.equal(await f.text(), before, "no setting is touched");
  assert.ok(vault.values.has(unreadable!), "the record is not deleted");
  assert.match(await answer(createGetAppSettingsController(manager)), /"openai":\{[^}]*"apiKeyState":"unreadable"/);

  await manager.updateSettings({ providers: { openai: { apiKey: "sk-canary-entered-again-1234" } } });
  assert.equal(configured("openai"), true);
  assert.equal(manager.getRuntime().config.providers.openai.apiKey, "sk-canary-entered-again-1234");
  assert.equal(vault.values.has(unreadable!), false, "the unreadable record is removed once replaced");
});

test("a key saved with the server's vault key cannot be read with another one, and the record holds no key", { skip: !posix }, async t => {
  const f = await app(t);
  const keyFile = (name: string) => { const file = path.join(f.root, "keys", name); initVaultKey(file, { forbiddenRoots: [] }); return loadVaultKey(file, { forbiddenRoots: [] }); };
  const directory = path.join(f.options.appDataDir, "integrations", "host-vault");
  const first = await f.start(new EncryptedCredentialVault(directory, createAeadVaultCipher([keyFile("vault.key")])));
  await first.manager.updateSettings({ providers: { openai: { apiKey: OPENAI_KEY } } });
  await first.manager.dispose();
  for (const name of await fs.readdir(directory)) assert.equal((await fs.readFile(path.join(directory, name))).includes(Buffer.from(OPENAI_KEY)), false);
  const elsewhere = await f.start(new EncryptedCredentialVault(directory, createAeadVaultCipher([keyFile("other.key")])));
  assert.equal((await elsewhere.manager.providerKeys()).providers.openai?.state, "unreadable");
  assert.equal(elsewhere.manager.getRuntime().config.providers.openai.apiKey, undefined);
});

test("a settings change that fails keeps no new record, and the saved key stays", async t => {
  const f = await app(t);
  const vault = keyVault();
  const { manager } = await f.start(vault);
  const service = manager.getRuntime().localModelService, reconfigure = service.reconfigure.bind(service);
  t.mock.method(service, "reconfigure", async (options: { contextSize: number }) => { if (options.contextSize === 1024) throw new Error("Copy verification failed"); await reconfigure(options as never); });
  await assert.rejects(manager.updateSettings({ providers: { openai: { apiKey: OPENAI_KEY } }, localModels: { contextSize: 1024 } }), /Copy verification failed/);
  assert.equal(vault.values.size, 0, "no orphan record");
  assert.equal((await manager.providerKeys()).providers.openai?.state, "unset");
  await manager.updateSettings({ providers: { openai: { apiKey: OPENAI_KEY } } });
  const [saved] = records(vault, "provider-key/openai/");
  await assert.rejects(manager.updateSettings({ providers: { openai: { apiKey: "sk-canary-replacement-1234" } }, localModels: { contextSize: 1024 } }), /Copy verification failed/);
  assert.deepEqual(records(vault, "provider-key/openai/"), [saved]);
  assert.equal(manager.getRuntime().config.providers.openai.apiKey, OPENAI_KEY);
});

test("this computer's API returns no key and no bot token: GET and PUT /app/settings and the dashboard", async t => {
  const f = await app(t, { openai: OPENAI_ENV });
  const { manager } = await f.start(keyVault());
  const put = await answer(createUpdateAppSettingsController(manager), { providers: { anthropic: { apiKey: ANTHROPIC_KEY }, openai: { apiKey: OPENAI_KEY } }, telegram: { botToken: BOT_TOKEN } });
  const get = await answer(createGetAppSettingsController(manager));
  const bootstrap = await answer(createDashboardBootstrapController(manager, manager.getRuntime().sessionIndexStore));
  for (const [name, json] of Object.entries({ put, get, bootstrap })) {
    for (const secret of [OPENAI_KEY, ANTHROPIC_KEY, BOT_TOKEN, OPENAI_ENV]) assert.equal(json.includes(secret), false, `${name} carries ${secret}`);
    assert.doesNotMatch(json, /"apiKey"|"apiKeyRef"|"botToken"|"botTokenRef"/, name);
    assert.match(json, /"anthropic":\{[^}]*"apiKeyState":"set"/, name);
    assert.match(json, /"botTokenState":"set"/, name);
  }
  assert.doesNotMatch(get, /"ollama":\{[^}]*apiKeyState/, "a provider without keys has no key state, as on a device");
  const raw = await f.text();
  for (const secret of [OPENAI_KEY, ANTHROPIC_KEY, BOT_TOKEN, OPENAI_ENV]) assert.equal(raw.includes(secret), false);
});

test("a key from the environment is used while none is saved and is never written to settings.json", async t => {
  const f = await app(t, { openai: OPENAI_ENV, qwen: QWEN_ENV, telegram: BOT_ENV });
  const { manager } = await f.start(keyVault());
  const raw = await f.text();
  for (const secret of [OPENAI_ENV, QWEN_ENV, BOT_ENV]) assert.equal(raw.includes(secret), false);
  const keys = await manager.providerKeys();
  assert.deepEqual([keys.providers.openai, keys.providers.qwen, keys.telegram], [{ state: "environment", key: OPENAI_ENV }, { state: "environment", key: QWEN_ENV }, { state: "environment", key: BOT_ENV }]);
  assert.equal(manager.getRuntime().config.providers.openai.apiKey, OPENAI_ENV);
  await manager.updateSettings({ providers: { openai: { apiKey: OPENAI_KEY } } });
  assert.equal(manager.getRuntime().config.providers.openai.apiKey, OPENAI_KEY, "a saved key comes first");
  await manager.updateSettings({ providers: { openai: { apiKey: "" } } });
  assert.equal(manager.getRuntime().config.providers.openai.apiKey, OPENAI_ENV);
  // The environment's key is for the environment's address only.
  await manager.updateSettings({ providers: { openai: { baseUrl: "https://proxy.example/v1" } } });
  assert.equal((await manager.providerKeys()).providers.openai?.state, "environment-address-changed");
  assert.equal(manager.getRuntime().config.providers.openai.apiKey, undefined);
  for (const secret of [OPENAI_ENV, QWEN_ENV, BOT_ENV]) assert.equal((await f.text()).includes(secret), false);
});

test("a key never follows an address change: changing the origin removes it, and a record for another origin is not used", async t => {
  const f = await app(t);
  const vault = keyVault();
  const first = await f.start(vault);
  await first.manager.updateSettings({ providers: { openai: { apiKey: OPENAI_KEY } } });
  await first.manager.updateSettings({ providers: { openai: { baseUrl: "https://api.openai.com/v2" } } });
  assert.equal(first.manager.getRuntime().config.providers.openai.apiKey, OPENAI_KEY, "the same origin keeps it");
  await first.manager.updateSettings({ providers: { openai: { baseUrl: "https://proxy.example/v1" } } });
  assert.equal(first.manager.getRuntime().config.providers.openai.apiKey, undefined);
  assert.equal((await first.manager.providerKeys()).providers.openai?.state, "unset");
  assert.equal(vault.values.size, 0, "its record is removed");
  await first.manager.updateSettings({ providers: { openai: { baseUrl: "https://proxy.example/v1", apiKey: OPENAI_KEY } } });
  const [saved] = records(vault, "provider-key/openai/");
  assert.equal(record(vault, saved!).origin, "https://proxy.example");
  await first.manager.dispose();

  // An older version changed the address and kept the record's name.
  const moved = await f.json();
  moved.providers.openai.baseUrl = "https://elsewhere.example/v1";
  await fs.writeFile(f.file, JSON.stringify(moved));
  const { manager } = await f.start(vault);
  assert.equal((await manager.providerKeys()).providers.openai?.state, "address-changed");
  assert.equal(manager.getRuntime().config.providers.openai.apiKey, undefined);
  assert.match(await answer(createGetAppSettingsController(manager)), /"openai":\{[^}]*"apiKeyState":"address-changed"/);
});

test("a file an older version changed after the update: a key it saved wins over the record, and a key it removed is gone", async t => {
  const f = await app(t);
  const vault = keyVault();
  const store = new AppSettingsStore(f.options.appDataDir, f.options, { vault });
  await store.update({ providers: { openai: { apiKey: OPENAI_KEY }, anthropic: { apiKey: ANTHROPIC_KEY } } });
  const [openaiRecord] = records(vault, "provider-key/openai/"), [anthropicRecord] = records(vault, "provider-key/anthropic/");
  // Downgraded: the older version keeps the refs it does not know, saves a key in the file and removes another.
  const downgraded = await f.json();
  downgraded.providers.openai.apiKey = "sk-canary-entered-in-older-1234";
  downgraded.providers.anthropic.apiKey = "";
  await fs.writeFile(f.file, JSON.stringify(downgraded));
  const upgraded = new AppSettingsStore(f.options.appDataDir, f.options, { vault });
  const settings = await upgraded.get();
  const keys = await upgraded.resolveKeys(settings);
  assert.deepEqual([keys.providers.openai, keys.providers.anthropic], [{ state: "set", key: "sk-canary-entered-in-older-1234" }, { state: "unset" }]);
  assert.equal(vault.values.has(openaiRecord!), false);
  assert.equal(vault.values.has(anthropicRecord!), false);
  assert.equal((await f.text()).includes("sk-canary-entered-in-older-1234"), false);
});

test("the Telegram bot token is kept like a provider key; a patch cannot name a vault record", async t => {
  const f = await app(t);
  const vault = keyVault();
  const store = new AppSettingsStore(f.options.appDataDir, f.options, { vault });
  const saved = await store.update({ telegram: { botToken: BOT_TOKEN, enabled: false } });
  assert.equal((await f.text()).includes(BOT_TOKEN), false);
  assert.deepEqual(record(vault, `telegram-bot-token/${saved.telegram.botTokenRef}`), { key: BOT_TOKEN, origin: "https://api.telegram.org" });
  assert.deepEqual((await store.resolveKeys(saved)).telegram, { state: "set", key: BOT_TOKEN });
  const cleared = await store.update({ telegram: { botToken: "" } });
  assert.equal(cleared.telegram.botTokenRef, undefined);
  assert.equal(vault.values.size, 0);
  assert.throws(() => validateSettingsPatch({ providers: { openai: { apiKeyRef: "planted" } } } as never), /apiKeyRef cannot be set/);
  assert.throws(() => validateSettingsPatch({ telegram: { botTokenRef: "planted" } } as never), /botTokenRef cannot be set/);
  assert.throws(() => validateSettingsPatch({ telegram: { botToken: 42 } } as never), /Invalid telegram.botToken/);
});

test("a key that cannot be written or read back stays in settings.json, and moves at a later start", async t => {
  const f = await app(t);
  await f.legacy({ openai: OPENAI_KEY, anthropic: ANTHROPIC_KEY });
  // One record is not read back as written, and every write of anthropic's fails.
  const flaky = keyVault(), read = flaky.read, write = flaky.write;
  flaky.read = async name => name.startsWith("provider-key/openai/") ? "something else" : read(name);
  flaky.write = async (name, value) => { if (name.startsWith("provider-key/anthropic/")) throw new Error("EIO"); return write(name, value); };
  const first = new AppSettingsStore(f.options.appDataDir, f.options, { vault: flaky });
  const settings = await first.get();
  assert.equal(settings.schemaVersion, 5, "not complete: tried again at the next start");
  const raw = await f.text();
  assert.ok(raw.includes(OPENAI_KEY) && raw.includes(ANTHROPIC_KEY), "both stay where they were");
  assert.equal(flaky.values.size, 0, "the record that was not read back is removed");
  assert.deepEqual((await first.resolveKeys(settings)).providers.openai, { state: "unprotected", key: OPENAI_KEY });

  const vault = keyVault();
  const later = await new AppSettingsStore(f.options.appDataDir, f.options, { vault }).get();
  assert.equal(later.schemaVersion, 6);
  assert.equal((await f.text()).includes(OPENAI_KEY) || (await f.text()).includes(ANTHROPIC_KEY), false);
  assert.equal(vault.values.size, 2);
});

test("archives that still hold keys are cleaned at a later start, and leftovers of interrupted writes are removed", async t => {
  const f = await app(t);
  // As if the app stopped after settings.json was migrated and before the archive was rewritten.
  const vault = keyVault();
  await new AppSettingsStore(f.options.appDataDir, f.options, { vault }).update({ providers: { openai: { apiKey: OPENAI_KEY } } });
  const archive = path.join(f.options.appDataDir, "settings.pre-llamacpp.json");
  await fs.writeFile(archive, JSON.stringify({ providers: { openai: { apiKey: OPENAI_KEY, model: "gpt" } }, telegram: { botToken: BOT_TOKEN } }));
  const clean = path.join(f.options.appDataDir, "settings.pre-integrations.json");
  await fs.writeFile(clean, JSON.stringify({ providers: { openai: { model: "gpt" } } }));
  const cleanBefore = await fs.stat(clean);
  const leftover = path.join(f.options.appDataDir, "settings.json.0b6a3c3e-58a4-4c55-9a0e-3c7f5b1d2e90.tmp");
  await fs.writeFile(leftover, JSON.stringify({ providers: { openai: { apiKey: OPENAI_KEY } } }));
  const other = path.join(f.options.appDataDir, "provider-status.json.0b6a3c3e-58a4-4c55-9a0e-3c7f5b1d2e90.tmp");
  await fs.writeFile(other, "{}");

  await new AppSettingsStore(f.options.appDataDir, f.options, { vault }).get();
  const scrubbed = await fs.readFile(archive, "utf8");
  assert.equal(scrubbed.includes(OPENAI_KEY) || scrubbed.includes(BOT_TOKEN), false);
  assert.equal(JSON.parse(scrubbed).providers.openai.model, "gpt");
  assert.equal((await fs.stat(clean)).mtimeMs, cleanBefore.mtimeMs, "an archive without keys is not rewritten");
  await assert.rejects(fs.stat(leftover), /ENOENT/);
  assert.ok(await fs.stat(other), "another store's file is not this one's to remove");
});

test("a key stays through edits that keep the host: a name, preset, dialect, tool calls or another path", async t => {
  const f = await app(t);
  const vault = keyVault();
  const store = new AppSettingsStore(f.options.appDataDir, f.options, { vault });
  await store.update({ providers: { "my-vllm": { kind: "openai-compatible", dialect: "chat", name: "My vLLM", baseUrl: "https://llm.example/v1", apiKey: OPENAI_KEY, model: "m", enabled: true } } });
  const [saved] = records(vault, "provider-key/my-vllm/");
  for (const patch of [{ name: "Renamed" }, { preset: "groq" }, { dialect: "deepseek" }, { nativeTools: "chat" as const }, { baseUrl: "https://llm.example/v2" }, { enabled: false }]) {
    const settings = await store.update({ providers: { "my-vllm": patch } });
    assert.deepEqual((await store.resolveKeys(settings)).providers["my-vllm"], { state: "set", key: OPENAI_KEY }, JSON.stringify(patch));
  }
  assert.deepEqual(records(vault, "provider-key/my-vllm/"), [saved]);
});

test("a provider the environment sets cannot take a key, an address or a removal; a key saved for it before comes back after", async t => {
  const env = { DEEPSEEK_API_KEY: "sk-canary-deepseek-environment-1" };
  const plain = await app(t);
  const vault = keyVault();
  // Added here first, with a key of its own.
  await new AppSettingsStore(plain.options.appDataDir, plain.options, { vault }).update({ providers: { deepseek: { kind: "openai-compatible", dialect: "deepseek", preset: "deepseek",
    name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: OPENAI_KEY, model: "deepseek-flash", enabled: true } } });
  const [saved] = records(vault, "provider-key/deepseek/");
  // Then set in the environment for a while (on a GET too, nothing of the saved key is removed).
  const withEnv = { ...plain.options, compatibleProviders: { ...plain.options.compatibleProviders, ...environmentProviders(env, 300_000).providers } };
  const store = new AppSettingsStore(plain.options.appDataDir, withEnv, { vault });
  const settings = await store.get();
  assert.equal(settings.providers.deepseek!.source, "environment");
  assert.deepEqual((await store.resolveKeys(settings)).providers.deepseek, { state: "environment", key: env.DEEPSEEK_API_KEY });
  for (const patch of [{ deepseek: { apiKey: "sk-canary-other-1234" } }, { deepseek: { baseUrl: "https://elsewhere.example" } }, { deepseek: null }]) {
    await assert.rejects(store.update({ providers: patch }), /set in the server's environment file/, JSON.stringify(patch));
  }
  await store.update({ providers: { deepseek: { model: "deepseek-v4-pro" } } });
  assert.equal((await plain.json()).providers.deepseek!.source, "environment", "saved while the environment sets it");
  assert.ok(vault.values.has(saved!), "the saved key waits");
  assert.equal((await plain.text()).includes(env.DEEPSEEK_API_KEY), false);
  // The environment no longer sets it: the provider is the user's again, with its key.
  const after = new AppSettingsStore(plain.options.appDataDir, plain.options, { vault });
  const back = await after.get();
  assert.equal(back.providers.deepseek?.source, undefined);
  assert.equal(back.providers.deepseek?.model, "deepseek-v4-pro");
  assert.deepEqual((await after.resolveKeys(back)).providers.deepseek, { state: "set", key: OPENAI_KEY });
});

test("no key goes to a provider without a valid address: such an address is refused, drops the key, and never matches", async t => {
  const f = await app(t);
  const vault = keyVault();
  const store = new AppSettingsStore(f.options.appDataDir, f.options, { vault });
  for (const baseUrl of ["http:", "http://", "ftp://llm.example", "https://user:pass@llm.example/v1", "not an address"]) {
    for (const id of ["openai", "lmstudio", "my-vllm"]) assert.throws(() => validateSettingsPatch({ providers: { [id]: { baseUrl } } }), /Invalid providers\..*\.baseUrl/, `${id} ${baseUrl}`);
  }
  const custom = { kind: "openai-compatible" as const, dialect: "chat", name: "My vLLM", model: "m", enabled: true };
  await assert.rejects(store.update({ providers: { "my-vllm": { ...custom, baseUrl: "", apiKey: OPENAI_KEY } } }),
    (error: unknown) => error instanceof SettingsValidationError && error.statusCode === 400 && /address first/.test(error.message));
  assert.equal(vault.values.size, 0);
  await store.update({ providers: { "my-vllm": { ...custom, baseUrl: "https://llm.example/v1", apiKey: OPENAI_KEY } } });
  const emptied = await store.update({ providers: { "my-vllm": { baseUrl: "" } } });
  assert.equal(emptied.providers["my-vllm"]!.apiKeyRef, undefined, "an empty address drops the key");
  assert.equal(vault.values.size, 0);

  // A record saved for no address (by hand, or a bug) and a provider without one never match.
  const settings = await f.json();
  settings.providers["my-vllm"]!.apiKeyRef = "planted";
  (settings.providers as Record<string, unknown>).other = { ...custom, name: "Other", baseUrl: "http:", apiKey: ANTHROPIC_KEY, timeoutMs: 1000 };
  await fs.writeFile(f.file, JSON.stringify(settings));
  vault.values.set("provider-key/my-vllm/planted", JSON.stringify({ key: OPENAI_KEY, origin: "" }));
  const { manager } = await f.start(keyVault());
  const keys = await new AppSettingsStore(f.options.appDataDir, f.options, { vault }).resolveKeys(await manager.getSettings());
  assert.deepEqual([keys.providers["my-vllm"], keys.providers.other], [{ state: "address-changed" }, { state: "address-changed" }]);
  assert.ok(manager.getRuntime().config.compatibleProviders?.other);
  assert.equal(manager.getRuntime().config.compatibleProviders?.other?.apiKey, undefined, "a key kept from before is not sent to http:");
});

test("after a downgrade the environment's key an older version wrote into settings.json leaves the saved key in place", async t => {
  const f = await app(t, { openai: OPENAI_ENV });
  const vault = keyVault();
  await new AppSettingsStore(f.options.appDataDir, f.options, { vault }).update({ providers: { openai: { apiKey: OPENAI_KEY } } });
  const [saved] = records(vault, "provider-key/openai/");
  // 0.1.9 merges the environment's key into every provider it saves.
  const downgraded = await f.json();
  downgraded.providers.openai.apiKey = OPENAI_ENV;
  await fs.writeFile(f.file, JSON.stringify(downgraded));
  const store = new AppSettingsStore(f.options.appDataDir, f.options, { vault });
  const settings = await store.get();
  assert.equal(`provider-key/openai/${settings.providers.openai.apiKeyRef}`, saved);
  assert.ok(vault.values.has(saved!));
  assert.deepEqual((await store.resolveKeys(settings)).providers.openai, { state: "set", key: OPENAI_KEY });
  assert.equal((await f.text()).includes(OPENAI_ENV), false);
});

test("an address set back to the host its key was saved for keeps the key", async t => {
  const f = await app(t);
  const vault = keyVault();
  const first = await f.start(vault);
  await first.manager.updateSettings({ providers: { openai: { apiKey: OPENAI_KEY } } });
  await first.manager.dispose();
  const [saved] = records(vault, "provider-key/openai/");
  const moved = await f.json();
  moved.providers.openai.baseUrl = "https://elsewhere.example/v1";
  await fs.writeFile(f.file, JSON.stringify(moved));
  const { manager } = await f.start(vault);
  assert.equal((await manager.providerKeys()).providers.openai?.state, "address-changed");
  await manager.updateSettings({ providers: { openai: { baseUrl: "https://api.openai.com/v1" } } });
  assert.deepEqual(records(vault, "provider-key/openai/"), [saved]);
  assert.equal(manager.getRuntime().config.providers.openai.apiKey, OPENAI_KEY);
});

test("a provider masks every copy of its key in what the service said", async t => {
  const echo = { error: { type: "authentication_error", message: `bad key ${OPENAI_KEY} (${OPENAI_KEY})` } };
  const reply = (status: number) => new Response(JSON.stringify(echo), { status, headers: { "content-type": "application/json" } });
  t.mock.method(globalThis, "fetch", async () => reply(400));
  const said: string[] = [];
  const anthropic = new AnthropicProvider({ id: "anthropic", name: "Anthropic", model: "claude", baseUrl: "https://api.example", apiKey: OPENAI_KEY, timeoutMs: 5000, version: "2023-06-01", maxTokens: 1000 } as never, new Logger());
  const gemini = new GeminiProvider({ id: "gemini", name: "Gemini", model: "gemini-2.5-flash", baseUrl: "https://api.example", apiKey: OPENAI_KEY, timeoutMs: 5000 } as never, new Logger());
  said.push((await anthropic.generateText({ prompt: "hi" })).error ?? "", (await gemini.generateText({ prompt: "hi" })).error ?? "");
  await gemini.listModels().catch((error: Error) => said.push(error.message));
  for (const status of [400, 401]) {
    const openai = new OpenAICompatibleProvider({ id: "custom", name: "Custom", model: "m", baseUrl: "https://llm.example/v1", apiKey: OPENAI_KEY, timeoutMs: 5000, dialect: compatibleDialect("chat") }, new Logger(),
      (async () => reply(status)) as typeof fetch);
    said.push((await openai.generateText({ prompt: "hi" })).error ?? "");
  }
  // A request that fails before it is sent can name the header.
  const broken = new OpenAICompatibleProvider({ id: "custom", name: "Custom", model: "m", baseUrl: "https://llm.example/v1", apiKey: OPENAI_KEY, timeoutMs: 5000, dialect: compatibleDialect("chat") }, new Logger(),
    (async () => { throw new TypeError(`invalid header value "Bearer ${OPENAI_KEY}"`); }) as typeof fetch);
  said.push((await broken.generateText({ prompt: "hi" })).error ?? "");
  assert.equal(said.length, 6);
  for (const text of said) {
    assert.equal(text.includes(OPENAI_KEY), false, text);
    assert.match(text, /<key>/, text);
  }
});

test("npm start and npm run mcp:stdio choose one vault: a key file, else the development vault on a Mac, else none with how to set one up", async t => {
  const f = await app(t);
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "provider-keys-key-")));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const keyFile = path.join(outside, "keys", "vault.key");
  initVaultKey(keyFile, { forbiddenRoots: [] });
  const server = resolveRunVault(f.options, { env: { LOCAL_COGNITIVE_VAULT_KEY_FILE: keyFile }, platform: "linux" });
  assert.deepEqual([server.kind, server.vault.available(), server.error], ["key-file", true, undefined]);
  const devKeyFile = path.join(outside, "dev", "dev-vault.key");
  const mac = resolveRunVault(f.options, { env: {}, platform: "darwin", devKeyFile });
  assert.deepEqual([mac.kind, mac.vault.available()], ["development", true]);
  assert.ok(await fs.stat(devKeyFile), "its key is the one given, never the real profile's");
  // A key saved by one run is read by the other on the same data folder.
  const saved = await new AppSettingsStore(f.options.appDataDir, f.options, { vault: mac.vault }).update({ providers: { openai: { apiKey: OPENAI_KEY } } });
  const again = resolveRunVault(f.options, { env: {}, platform: "darwin", devKeyFile });
  assert.equal((await new AppSettingsStore(f.options.appDataDir, f.options, { vault: again.vault }).resolveKeys(saved)).providers.openai?.key, OPENAI_KEY);
  for (const [platform, env] of [["linux", {}], ["win32", {}], ["darwin", { LOCAL_COGNITIVE_DEV_KEYCHAIN: "1" }]] as const) {
    const none = resolveRunVault(f.options, { env, platform, devKeyFile });
    assert.deepEqual([none.kind, none.vault.available(), none.vault.unavailableReason()], ["none", false, RUN_VAULT_REASON], platform);
  }
  const none = resolveRunVault(f.options, { env: {}, platform: "linux" });
  await assert.rejects(new AppSettingsStore(f.options.appDataDir, f.options, { vault: none.vault }).update({ providers: { anthropic: { apiKey: ANTHROPIC_KEY } } }),
    (error: unknown) => error instanceof SettingsValidationError && error.statusCode === 503 && /LOCAL_COGNITIVE_VAULT_KEY_FILE/.test(error.message));
  assert.match(resolveRunVault(f.options, { env: { LOCAL_COGNITIVE_VAULT_KEY_FILE: path.join(outside, "absent.key") } }).error ?? "", /does not exist/);
});
