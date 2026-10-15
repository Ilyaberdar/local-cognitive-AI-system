import { z } from "zod";
import type { RuntimeManager } from "../app/RuntimeManager";
import { SettingsValidationError } from "../app/settingsValidation";
import { RemoteOperationError, type OperationContext, type RemoteOperation } from "../remote/host/RemoteHost";
import type { AppSettingsPatch } from "../types";
import { localModelSettingsSchema } from "./modelOperations";
import { publicError } from "./publicError";
import { hostSettingsView, takesKey, withoutSecrets } from "./settingsDto";
import { OpenAICompatibleProvider } from "../llm/OpenAICompatibleProvider";
import { compatibleDialect } from "../llm/ProviderDialect";
import { PROVIDER_PRESETS, providerPreset, type ProviderPreset } from "../llm/providerCatalog";
import { SECRET_ENV_KEYS } from "../config/secrets";
import { CUSTOM_PROVIDER_ENV } from "../config/environmentProviders";
import { Logger } from "../utils/Logger";

const TEST_TIMEOUT_MS = 300_000;
const HOST_ONLY = "This is set on the server itself: filesystem access, folders, provider addresses, the models folder, the MCP server and Telegram can only be changed there.";
const LATER = "MCP servers and plugins on the server come in a later update.";
const CLIENT_SETTING = "Appearance, keyboard shortcuts and profile are kept on each device and are not sent to the server.";
const CLIENT_UI = ["theme", "accentColor", "backgroundColor", "foregroundColor", "fontScale", "codeFontSize", "animations", "sendKey", "shortcuts"];

const providerId = z.string().min(1).max(100);
// A key is written or cleared, never read back.
const apiKey = z.union([
  z.object({ set: z.string().trim().min(1).max(4096).refine(value => !/[\s\u0000-\u001f\u007f]/.test(value), "A key is one word without spaces.") }).strict(),
  z.object({ clear: z.literal(true) }).strict()
]);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// Adding a provider from a device: one of the server's presets, a key, a model; never an address.
const newKey = z.object({ set: z.string().trim().min(1).max(4096).refine(value => !/[\s\u0000-\u001f\u007f]/.test(value), "A key is one word without spaces.") }).strict();
const presetChoice = { preset: z.string().min(1).max(64), region: z.string().min(1).max(16).optional(), apiKey: newKey };
const schemas = {
  update: z.object({
    ui: z.object({ language: z.enum(["auto", "ru", "en"]), outputStyle: z.enum(["compact", "balanced", "detailed", "exhaustive"]),
      mode: z.enum(["auto", "general", "code", "hypothesis"]) }).partial().strict(),
    llm: z.object({ defaultProvider: providerId }).strict(),
    // null removes a provider a device added; name renames one.
    providers: z.record(providerId, z.union([z.null(), z.object({ enabled: z.boolean(), model: z.string().max(300), timeoutMs: z.number().int().min(1000).max(3_600_000),
      version: z.string().max(40), maxTokens: z.number().int().min(1).max(1_000_000), apiKey, name: z.string().trim().min(1).max(80) }).partial().strict()])),
    localModels: localModelSettingsSchema,
    agentLimits: z.object({ maxSteps: count, advisorMaxSteps: count, maxTotalSteps: count, maxActiveMs: count }).partial().strict(),
    memory: z.object({
      adapter: z.enum(["local-json", "openmemory", "world-partition"]), topK: z.number().int().min(1).max(1000),
      worldPartition: z.object({ crossSessionRecall: z.boolean(), strategy: z.enum(["auto", "global", "partitioned"]), activationThreshold: z.number().int().min(1).max(1_000_000_000),
        chunkCapacity: z.number().int().min(32).max(10_000_000), initialRadius: z.number().int().min(0).max(1_000_000), maxRadius: z.number().int().min(0).max(1_000_000),
        fallbackToGlobalSearch: z.boolean(), migrateLegacyOnStart: z.boolean() }).partial().strict(),
      openMemory: z.object({ enabled: z.boolean() }).strict()
    }).partial().strict()
  }).partial().strict().refine(value => Object.keys(value).length > 0),
  test: z.object({ providerId, model: z.string().max(300).optional() }).strict(),
  discover: z.object(presetChoice).strict(),
  add: z.object({ ...presetChoice, model: z.string().trim().min(1).max(300), name: z.string().trim().min(1).max(80).optional() }).strict()
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const has = (value: unknown, key: string) => Object.hasOwn(record(value), key);
const parse = <T>(schema: z.ZodType<T>, payload: unknown): T => {
  const result = schema.safeParse(payload);
  if (!result.success) throw new RemoteOperationError("The request is not valid.", "invalid_request");
  return result.data;
};

/** Settings a device may not make on the host, checked before the schema so the answer says
 * why. A patch with any of them is refused whole: nothing is stripped and nothing is written. */
const refuseByField = (raw: unknown): void => {
  const patch = record(raw);
  const memory = record(patch.memory);
  if (has(patch, "filesystem") || has(patch, "telegram") || has(patch.mcp, "server") || has(patch.localModels, "modelsDir")
    || has(memory, "baseDir") || has(memory.openMemory, "dbPath") || Object.values(record(patch.providers)).some(provider => has(provider, "baseUrl"))) {
    throw new RemoteOperationError(HOST_ONLY, "host_only");
  }
  if (has(patch.mcp, "client") || has(patch, "plugins")) throw new RemoteOperationError(LATER, "unsupported");
  if (has(patch, "profile") || CLIENT_UI.some(key => has(patch.ui, key))) throw new RemoteOperationError(CLIENT_SETTING, "client_setting");
};

/** Keys the server has from its environment: masked in every answer a device gets, like saved ones. */
const environmentSecrets = (): string[] => Object.entries(process.env)
  .filter(([name, value]) => value && ((SECRET_ENV_KEYS as readonly string[]).includes(name) || (CUSTOM_PROVIDER_ENV.test(name) && name.endsWith("_API_KEY"))))
  .map(([, value]) => value!.trim());
/** A preset a device may add, and the address it gets: the server's own (its region, or the owner's
 * override in the environment, or the catalog's), never one the device sends. */
const addablePreset = (id: string, region: string | undefined): { preset: ProviderPreset; baseUrl: string } => {
  const preset = providerPreset(id);
  if (!preset) throw new RemoteOperationError("The server has no such provider type.", "invalid_request");
  if (preset.builtIn) throw new RemoteOperationError(`${preset.name} is already on the server: enter its key on its page.`, "invalid_request");
  const area = region === undefined ? undefined : preset.regions?.find(item => item.id === region);
  if (region !== undefined && !area) throw new RemoteOperationError("The server has no such region for this provider.", "invalid_request");
  return { preset, baseUrl: area?.baseUrl ?? (process.env[preset.env.baseUrl]?.trim() || preset.baseUrl) };
};
/** The presets a device can add on this server: what Add provider shows, without their environment names. */
export const addablePresets = () => PROVIDER_PRESETS.filter(preset => !preset.builtIn).map(({ env: _env, ...preset }) => preset);

export interface SettingsOperationDependencies {
  runtimeManager: RuntimeManager;
  /** True while the host drains: changes and tests are refused, reading still answers. */
  isDraining(): boolean;
}

/** The Settings screen's host pages for a paired device (R5-3): a safe view of the host's
 * settings, changes within an allowlist (keys written or cleared, never read), and a provider
 * test whose answer never carries a key. Calls the settings store directly, never the HTTP API. */
export const createSettingsOperations = (deps: SettingsOperationDependencies): Record<string, RemoteOperation> => {
  const draining = () => new RemoteOperationError("The server is shutting down. Try again when it is back.", "host_draining");
  const runtimeStatus = () => {
    try { return deps.runtimeManager.getRuntime().localModelService.snapshot().runtime.status; } catch { return undefined; }
  };
  return {
    "settings.get": async () => ({ settings: hostSettingsView(await deps.runtimeManager.getSettings()), runtimeStatus: runtimeStatus(), presets: addablePresets() }),

    "settings.update": async payload => {
      refuseByField(payload);
      // The schema would drop such a key silently; it is refused instead.
      if (Object.keys(record(record(payload).providers)).some(id => ["__proto__", "constructor", "prototype"].includes(id))) {
        throw new RemoteOperationError("The request is not valid.", "invalid_request");
      }
      const input = parse(schemas.update, payload);
      if (deps.isDraining()) throw draining();
      const current = await deps.runtimeManager.getSettings();
      // Only providers the host has, as its own entries: an unknown id would create one, and a name
      // such as "toString" or "constructor" must not pass for a provider through the prototype.
      for (const id of [...Object.keys(input.providers ?? {}), ...(input.llm ? [input.llm.defaultProvider] : [])]) {
        if (!Object.hasOwn(current.providers, id)) throw new RemoteOperationError(`The provider ${publicError(id)} does not exist on the server.`, "invalid_request");
      }
      const providers: NonNullable<AppSettingsPatch["providers"]> = {};
      for (const [id, fields] of Object.entries(input.providers ?? {})) {
        // Removed or renamed: only a provider added on the server (not a built-in, Qwen or one the environment sets).
        const added = current.providers[id]?.kind === "openai-compatible" && !providerPreset(id)?.builtIn && current.providers[id]?.source !== "environment";
        if (fields === null || fields.name !== undefined) {
          if (current.providers[id]?.source === "environment") throw new RemoteOperationError(`${publicError(current.providers[id]?.name ?? id)} is set in the server's environment file: change it there.`, "host_only");
          if (!added) throw new RemoteOperationError(fields === null ? "Only a provider added on the server can be removed. Turn this one off instead." : "Only a provider added on the server can be renamed.", "invalid_request");
        }
        if (fields === null) { providers[id] = null; continue; }
        const { apiKey: key, ...rest } = fields;
        if (key && !takesKey(id)) throw new RemoteOperationError("This provider does not use an API key.", "invalid_request");
        if (key && current.providers[id]?.source === "environment") throw new RemoteOperationError(`${publicError(current.providers[id]?.name ?? id)} is set in the server's environment file: change its key there.`, "host_only");
        if ((rest.version !== undefined || rest.maxTokens !== undefined) && id !== "anthropic") throw new RemoteOperationError("Only Anthropic has a version and a token limit.", "invalid_request");
        if (id === "llamacpp" && rest.timeoutMs !== undefined) throw new RemoteOperationError("Local model timeouts are set in the runtime settings.", "invalid_request");
        providers[id] = { ...rest, ...(key ? { apiKey: "set" in key ? key.set : "" } : {}) };
      }
      const { providers: _providers, ...other } = input;
      const patch = { ...other, ...(input.providers ? { providers } : {}) } as AppSettingsPatch;
      try { await deps.runtimeManager.updateSettings(patch); }
      catch (error) {
        // Validation messages name the field, never its value.
        if (error instanceof SettingsValidationError) throw new RemoteOperationError(error.message, "invalid_request");
        throw error;
      }
      return { settings: hostSettingsView(await deps.runtimeManager.getSettings()) };
    },

    /** Add provider, first step: the models a preset's service lists for this key, read on the server
     * at the server's own address for it. Nothing is saved, and the key comes back in no answer. */
    "providers.discover": async payload => {
      const input = parse(schemas.discover, payload);
      if (deps.isDraining()) throw draining();
      const { preset, baseUrl } = addablePreset(input.preset, input.region);
      const key = input.apiKey.set.trim();
      const provider = new OpenAICompatibleProvider({ id: "discover", name: preset.name, baseUrl: baseUrl.replace(/\/+$/, ""), model: "", apiKey: key, timeoutMs: 15_000,
        dialect: compatibleDialect(preset.dialect) }, new Logger());
      try { return { models: (await provider.listModels({ strict: true })).map(model => model.id).slice(0, 2000) }; }
      catch (error) {
        const detail = error instanceof Error ? error.message : "";
        throw new RemoteOperationError(/status 40[13]/.test(detail) ? "The service refused this key." : `The service did not answer: ${withoutSecrets(detail, [key, ...environmentSecrets()])}`, "provider_unreachable");
      }
    },
    /** Add provider, second step: the preset saved on the server with its key and model, at the server's
     * own address for it, under an id the server chooses (the preset's, or the next free one). */
    "providers.add": async payload => {
      const input = parse(schemas.add, payload);
      if (deps.isDraining()) throw draining();
      const { preset, baseUrl } = addablePreset(input.preset, input.region);
      const current = await deps.runtimeManager.getSettings();
      let id = preset.id;
      for (let suffix = 2; Object.hasOwn(current.providers, id); suffix++) {
        if (suffix > 20) throw new RemoteOperationError(`The server has too many ${preset.name} providers already.`, "invalid_request");
        id = `${preset.id}-${suffix}`;
      }
      const name = input.name ?? (id === preset.id ? preset.name : `${preset.name} ${id.slice(preset.id.length + 1)}`);
      try {
        await deps.runtimeManager.updateSettings({ providers: { [id]: { kind: "openai-compatible", dialect: preset.dialect, preset: preset.id, name, baseUrl,
          apiKey: input.apiKey.set.trim(), model: input.model, enabled: true, timeoutMs: 300_000 } } });
      } catch (error) {
        if (error instanceof SettingsValidationError) throw new RemoteOperationError(error.message, "invalid_request");
        throw error;
      }
      return { id, settings: hostSettingsView(await deps.runtimeManager.getSettings()) };
    },

    /** Sends one short prompt with the provider's saved key on the host; the answer carries neither. */
    "providers.test": async (payload, context: OperationContext) => {
      const { providerId: id, model } = parse(schemas.test, payload);
      if (deps.isDraining()) throw draining();
      if (id === "llamacpp") throw new RemoteOperationError("Load and use the server's models from Models.", "unsupported");
      const settings = await deps.runtimeManager.getSettings();
      const provider = Object.hasOwn(settings.providers, id) ? settings.providers[id] : undefined;
      if (!provider) throw new RemoteOperationError("The provider does not exist on the server.", "invalid_request");
      if (!provider.enabled) return { ok: false, providerId: id, message: "Provider is disabled." };
      const secrets = [...Object.values(settings.providers).map(item => item.apiKey ?? "").filter(Boolean), ...environmentSecrets()];
      try {
        const response = await deps.runtimeManager.getRuntime().llmService.generateText({ usagePurpose: "provider-test", model: model ?? provider.model, prompt: "Reply exactly with: ok",
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(TEST_TIMEOUT_MS)]) }, id);
        const failed = response.error || !response.text.trim() || response.text.startsWith(`Mock response from ${id}`);
        return failed
          ? { ok: false, providerId: id, model: response.model, message: withoutSecrets(response.error || "Provider returned no usable final answer.", secrets) }
          : { ok: true, providerId: id, model: response.model, message: `Provider responded successfully with model ${response.model}.`, ...(response.usage ? { usage: response.usage } : {}) };
      } catch (error) {
        return { ok: false, providerId: id, message: withoutSecrets(error instanceof Error ? error.message : error, secrets) };
      }
    }
  };
};
