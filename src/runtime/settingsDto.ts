import { defaultUiPreferences } from "../app/settingsValidation";
import type { AppSettings } from "../types";
import { publicError } from "./publicError";

/** Providers that take an API key on the host. */
export const takesKey = (providerId: string): boolean => !["llamacpp", "ollama"].includes(providerId);

/** An address shown without credentials, path or query. */
export const originOnly = (value: unknown): string => {
  try { const origin = new URL(String(value)).origin; return origin === "null" ? "" : origin; }
  catch { return ""; }
};

/** What a paired device sees of the host's settings (R5-3), built field by field: chat
 * defaults, providers (whether a key is saved, never the key; the address as an origin), the
 * runtime without its folder, agent limits, memory tuning without paths, and only counts for
 * filesystem access and MCP servers. Appearance, profile, telegram and internal ids stay out. */
export const hostSettingsView = (settings: AppSettings) => {
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
        ...(takesKey(id) ? { apiKeyState: provider.apiKey?.trim() ? "set" : "unset" } : {})
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

const KEY_SHAPES = /\b(?:sk-[A-Za-z0-9_\-*]{8,}|AIza[0-9A-Za-z_\-]{20,})/g;
/** A provider's message for a device: saved keys and anything shaped like a key are replaced,
 * then reduced like every other error (first line, no paths, short). */
export const withoutSecrets = (text: unknown, secrets: string[]): string => {
  let value = String(text ?? "");
  for (const secret of secrets.filter(item => item.length >= 6).sort((a, b) => b.length - a.length)) value = value.split(secret).join("<key>");
  return publicError(value.replace(KEY_SHAPES, "<key>"));
};
