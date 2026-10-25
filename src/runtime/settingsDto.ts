import { defaultUiPreferences } from "../app/settingsValidation";
import { BUILT_IN_PROVIDER_IDS, providerPreset } from "../llm/providerCatalog";
import type { ApiKeyState, ResolvedKeys } from "../app/ProviderKeyStore";
import type { AppSettings } from "../types";
import { publicError } from "./publicError";
import { maskKeyShapes } from "../security/keyPatterns";

/** Providers that take an API key on the host. */
export const takesKey = (providerId: string): boolean => !["llamacpp", "ollama"].includes(providerId);

const keyState = (keys: ResolvedKeys, providerId: string): ApiKeyState => keys.providers[providerId]?.state ?? "unset";

/** What this computer's own API returns of its settings (GET and PUT /app/settings, the dashboard):
 * all of them but keys. A provider that takes a key has its state instead, as a paired device sees
 * it (set, unset, environment, unreadable, unprotected, address-changed), and Telegram has its bot
 * token's; neither the key nor its vault record is in it. */
export const localSettingsView = (settings: AppSettings, keys: ResolvedKeys) => {
  const { botToken: _botToken, botTokenRef: _botTokenRef, ...telegram } = settings.telegram ?? {};
  return {
    ...settings,
    providers: Object.fromEntries(Object.entries(settings.providers ?? {}).map(([id, { apiKey: _apiKey, apiKeyRef: _apiKeyRef, ...provider }]) =>
      [id, { ...provider, ...(takesKey(id) ? { apiKeyState: keyState(keys, id) } : {}) }])),
    telegram: { ...telegram, botTokenState: keys.telegram.state }
  };
};

/** An address shown without credentials, path or query. */
export const originOnly = (value: unknown): string => {
  try { const origin = new URL(String(value)).origin; return origin === "null" ? "" : origin; }
  catch { return ""; }
};

/** What a paired device sees of the host's settings (R5-3), built field by field: chat
 * defaults, providers (whether a key is saved, never the key; the address as an origin), the
 * runtime without its folder, agent limits, memory tuning without paths, and only counts for
 * filesystem access and MCP servers. Appearance, profile, telegram and internal ids stay out. */
export const hostSettingsView = (settings: AppSettings, keys: ResolvedKeys) => {
  const ui = settings.ui, models = settings.localModels, memory = settings.memory, limits = settings.agentLimits;
  const partition = memory?.worldPartition;
  return {
    ui: { language: ui?.language ?? defaultUiPreferences.language, outputStyle: ui?.outputStyle ?? defaultUiPreferences.outputStyle, mode: ui?.mode ?? defaultUiPreferences.mode },
    llm: { defaultProvider: settings.llm?.defaultProvider ?? "" },
    providers: Object.fromEntries(Object.entries(settings.providers ?? {}).map(([id, provider]) => [id, id === "llamacpp"
      ? { enabled: Boolean(provider.enabled), model: provider.model ?? "" }
      : {
        enabled: Boolean(provider.enabled), model: provider.model ?? "", timeoutMs: provider.timeoutMs, baseUrl: originOnly(provider.baseUrl),
        ...(id === "anthropic" ? { version: provider.version, maxTokens: provider.maxTokens } : {}),
        // An OpenAI-compatible service: its name and preset, whether the environment file sets it, and
        // whether a device may remove it (one added on the server, not the default).
        ...(provider.kind === "openai-compatible" && !BUILT_IN_PROVIDER_IDS.includes(id) ? { kind: provider.kind, ...(provider.name ? { name: provider.name } : {}),
          ...(provider.preset ? { preset: provider.preset } : {}), ...(provider.source === "environment" ? { source: "environment" } : {}),
          removable: !providerPreset(id)?.builtIn && provider.source !== "environment" && settings.llm?.defaultProvider !== id } : {}),
        ...(takesKey(id) ? { apiKeyState: keyState(keys, id) } : {})
      }])),
    localModels: models ? { contextSize: models.contextSize, gpuLayers: models.gpuLayers, memoryLimitPercent: models.memoryLimitPercent, loadTimeoutMs: models.loadTimeoutMs,
      generationTimeoutMs: models.generationTimeoutMs, generation: models.generation, ...(models.multiGpu ? { multiGpu: models.multiGpu } : {}) } : {},
    agentLimits: { maxSteps: limits?.maxSteps, advisorMaxSteps: limits?.advisorMaxSteps, maxTotalSteps: limits?.maxTotalSteps, maxActiveMs: limits?.maxActiveMs },
    memory: {
      adapter: memory?.adapter, topK: memory?.topK,
      worldPartition: partition ? { crossSessionRecall: partition.crossSessionRecall, strategy: partition.strategy, activationThreshold: partition.activationThreshold,
        chunkCapacity: partition.chunkCapacity, initialRadius: partition.initialRadius, maxRadius: partition.maxRadius,
        fallbackToGlobalSearch: partition.fallbackToGlobalSearch, migrateLegacyOnStart: partition.migrateLegacyOnStart } : {},
      openMemory: { enabled: Boolean(memory?.openMemory?.enabled) }
    },
    filesystem: { accessMode: settings.filesystem?.accessMode ?? "restricted", allowedDirectoryCount: settings.filesystem?.allowedDirectories?.length ?? 0 },
    mcp: { serverCount: Object.keys(settings.mcp?.client?.servers ?? {}).length }
  };
};

/** Text with every occurrence of these keys replaced (the longest first, so none is left in part). */
export const maskSecrets = (text: unknown, secrets: Array<string | undefined>): string => {
  let value = String(text ?? "");
  for (const secret of secrets.filter((item): item is string => typeof item === "string" && item.length >= 6).sort((a, b) => b.length - a.length)) value = value.split(secret).join("<key>");
  return value;
};
/** A provider's message for a device: saved keys and anything shaped like a key are replaced,
 * then reduced like every other error (first line, no paths, short). */
export const withoutSecrets = (text: unknown, secrets: string[]): string => publicError(maskKeyShapes(maskSecrets(text, secrets)));
