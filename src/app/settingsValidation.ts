import { AppSettingsPatch, UiPreferences } from "../types";

export const defaultUiPreferences: UiPreferences = {
  version: 1, theme: "dark", animations: true, fontScale: 100, language: "auto", outputStyle: "balanced", mode: "auto"
};

export class SettingsValidationError extends Error { readonly statusCode = 400; }

/** Validate supplied fields only. Missing fields and forward-compatible stored data stay untouched. */
export function validateSettingsPatch(patch: AppSettingsPatch): void {
  const object = (value: unknown, name: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SettingsValidationError(`${name} must be an object.`);
    if (Object.keys(value).some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw new SettingsValidationError(`Invalid ${name} key.`);
    return value as Record<string, unknown>;
  };
  const check = (values: Record<string, unknown>, name: string, kinds: Record<string, string | readonly string[] | readonly number[]>) => {
    for (const [key, value] of Object.entries(values)) {
      const kind = kinds[key];
      if (!kind || value === undefined) continue;
      const valid = Array.isArray(kind)
        ? typeof kind[0] === "number"
          ? typeof value === "number" && Number.isInteger(value) && value >= Number(kind[0]) && value <= Number(kind[1])
          : kind.includes(value as never)
        : typeof value === kind;
      if (!valid) throw new SettingsValidationError(`Invalid ${name}.${key}.`);
    }
  };
  object(patch, "Settings");
  if (patch.ui !== undefined) check(object(patch.ui, "ui"), "ui", {
    theme: ["dark", "light", "system"], animations: "boolean", fontScale: [85, 150], language: ["auto", "ru", "en"],
    outputStyle: ["compact", "balanced", "detailed", "exhaustive"], mode: ["auto", "general", "code", "hypothesis"]
  });
  if (patch.localModels !== undefined) check(object(patch.localModels, "localModels"), "localModels", {
    modelsDir: "string", contextSize: [512, 131072], gpuLayers: [0, 999], memoryLimitPercent: [10, 90],
    loadTimeoutMs: [10000, 1800000], generationTimeoutMs: [10000, 3600000]
  });
  if (patch.llm !== undefined) check(object(patch.llm, "llm"), "llm", { defaultProvider: "string" });
  if (patch.providers !== undefined) for (const [id, provider] of Object.entries(object(patch.providers, "providers"))) {
    check(object(provider, `providers.${id}`), `providers.${id}`, {
      enabled: "boolean", baseUrl: "string", apiKey: "string", model: "string", timeoutMs: [1000, 3600000],
      version: "string", maxTokens: [1, 1000000]
    });
  }
  if (patch.plugins !== undefined) for (const [id, plugin] of Object.entries(object(patch.plugins, "plugins"))) {
    const value = object(plugin, `plugins.${id}`);
    check(value, `plugins.${id}`, { enabled: "boolean" });
    if (value.values !== undefined) for (const field of Object.values(object(value.values, `plugins.${id}.values`))) {
      if (field !== undefined && !["string", "number", "boolean"].includes(typeof field)) throw new SettingsValidationError("Invalid plugin value.");
    }
  }
  if (patch.memory !== undefined) {
    const memory = object(patch.memory, "memory");
    check(memory, "memory", { adapter: ["local-json", "world-partition", "openmemory"], baseDir: "string", topK: [1, 1000] });
    if (memory.worldPartition !== undefined) check(object(memory.worldPartition, "worldPartition"), "memory.worldPartition", {
      crossSessionRecall: "boolean", strategy: ["auto", "global", "partitioned"], activationThreshold: [1, 1000000000],
      chunkCapacity: [32, 10000000], initialRadius: [0, 1000000], maxRadius: [0, 1000000],
      fallbackToGlobalSearch: "boolean", migrateLegacyOnStart: "boolean"
    });
    if (memory.openMemory !== undefined) check(object(memory.openMemory, "openMemory"), "memory.openMemory", { enabled: "boolean", dbPath: "string" });
  }
  if (patch.mcp !== undefined) {
    const mcp = object(patch.mcp, "mcp");
    if (mcp.server !== undefined) check(object(mcp.server, "mcp.server"), "mcp.server", {
      enabled: "boolean", transport: ["stdio"], defaultSessionId: "string"
    });
  }
}
