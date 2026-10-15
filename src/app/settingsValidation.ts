import { AppSettingsPatch, UiPreferences } from "../types";
import { isProviderDialect } from "../llm/ProviderDialect";
import { BUILT_IN_PROVIDER_IDS, providerPreset } from "../llm/providerCatalog";

const isWebAddress = (value: string): boolean => {
  try { const url = new URL(value); return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password; }
  catch { return false; }
};

export const defaultUiPreferences: UiPreferences = {
  version: 1, theme: "dark", animations: true, fontScale: 100, codeFontSize: 12, language: "auto", outputStyle: "balanced", mode: "auto", sendKey: "enter"
};

export class SettingsValidationError extends Error { readonly statusCode = 400; }

// A shortcut as public/assets/shortcuts.js writes it: modifiers in this order, then a physical key.
const shortcutKeys = /^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:Mod\+)?(?:Key[A-Z]|Digit[0-9]|Comma|Period|Slash|Backslash|BracketLeft|BracketRight|Semicolon|Quote|Backquote|Minus|Equal|Space|Escape|F(?:[1-9]|1[0-9]|2[0-4]))$/;
const shortcutAction = /^[a-z][A-Za-z0-9]{0,39}$/;

/** The readable entries of stored shortcuts (no two actions with the same keys); undefined if none is. */
export function readShortcuts(value: unknown): Record<string, string | null> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string | null> = {}, taken = new Set<string>();
  for (const [action, keys] of Object.entries(value).slice(0, 64)) {
    if (!shortcutAction.test(action)) continue;
    if (keys === null) result[action] = null;
    else if (typeof keys === "string" && shortcutKeys.test(keys) && !taken.has(keys)) { result[action] = keys; taken.add(keys); }
  }
  return result;
}

const hexColor = /^#[0-9a-f]{6}$/i;
const avatarDataUrl = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i;
const MAX_AVATAR_DATA_URL_LENGTH = 1_500_000;

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
  if (patch.filesystem !== undefined) {
    check(object(patch.filesystem, "filesystem"), "filesystem", { outputDir: "string", accessMode: ["restricted", "full"] });
    if (patch.filesystem.allowedDirectories !== undefined && (!Array.isArray(patch.filesystem.allowedDirectories) || patch.filesystem.allowedDirectories.some(value => typeof value !== "string"))) throw new SettingsValidationError("Invalid filesystem.allowedDirectories.");
  }
  if (patch.ui !== undefined) {
    const ui = object(patch.ui, "ui");
    check(ui, "ui", {
    theme: ["dark", "light", "system", "midnight"], animations: "boolean", fontScale: [85, 150], codeFontSize: [10, 20], language: ["auto", "ru", "en"],
    outputStyle: ["compact", "balanced", "detailed", "exhaustive"], mode: ["auto", "general", "code", "hypothesis"], sendKey: ["enter", "mod-enter"]
    });
    for (const key of ["accentColor", "backgroundColor", "foregroundColor"] as const) {
      const value = ui[key];
      if (value !== undefined && (typeof value !== "string" || (value !== "" && !hexColor.test(value)))) throw new SettingsValidationError(`Invalid ui.${key}.`);
    }
    if (ui.shortcuts !== undefined) {
      const shortcuts = object(ui.shortcuts, "ui.shortcuts"), entries = Object.entries(shortcuts);
      if (entries.length > 64 || Object.keys(readShortcuts(shortcuts) ?? {}).length !== entries.length) throw new SettingsValidationError("Invalid ui.shortcuts.");
    }
  }
  if (patch.profile !== undefined) {
    const profile = object(patch.profile, "profile");
    check(profile, "profile", { displayName: "string", avatarDataUrl: "string" });
    if (profile.displayName !== undefined && (typeof profile.displayName !== "string" || !profile.displayName.trim() || profile.displayName.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(profile.displayName))) {
      throw new SettingsValidationError("Invalid profile.displayName.");
    }
    if (profile.avatarDataUrl !== undefined && (typeof profile.avatarDataUrl !== "string" || (profile.avatarDataUrl !== "" && (!avatarDataUrl.test(profile.avatarDataUrl) || profile.avatarDataUrl.length > MAX_AVATAR_DATA_URL_LENGTH)))) {
      throw new SettingsValidationError("Invalid profile.avatarDataUrl.");
    }
  }
  if (patch.localModels !== undefined) {
    const localModels = object(patch.localModels, "localModels");
    check(localModels, "localModels", {
      modelsDir: "string", contextSize: [512, 131072], memoryLimitPercent: [10, 90],
      loadTimeoutMs: [10000, 1800000], generationTimeoutMs: [10000, 3600000]
    });
    if (localModels.multiGpu !== undefined) {
      const multiGpu = object(localModels.multiGpu, "localModels.multiGpu");
      for (const key of Object.keys(multiGpu)) if (!["split", "mode", "devices", "pins"].includes(key)) throw new SettingsValidationError(`Invalid localModels.multiGpu.${key}.`);
      if (multiGpu.split !== undefined && !["auto", "always", "never"].includes(multiGpu.split as string)) throw new SettingsValidationError("Invalid localModels.multiGpu.split.");
      if (multiGpu.mode !== undefined && !["layer", "row"].includes(multiGpu.mode as string)) throw new SettingsValidationError("Invalid localModels.multiGpu.mode.");
      const deviceIds = (value: unknown, name: string) => {
        if (!Array.isArray(value) || value.length > 16 || value.some(id => typeof id !== "string" || !/^[\w:.-]{1,100}$/.test(id)) || new Set(value).size !== value.length) throw new SettingsValidationError(`Invalid ${name}.`);
      };
      if (multiGpu.devices !== undefined) deviceIds(multiGpu.devices, "localModels.multiGpu.devices");
      if (multiGpu.pins !== undefined) {
        const pins = object(multiGpu.pins, "localModels.multiGpu.pins");
        const entries = Object.entries(pins);
        if (entries.length > 64) throw new SettingsValidationError("Invalid localModels.multiGpu.pins.");
        for (const [model, ids] of entries) {
          if (["__proto__", "constructor", "prototype"].includes(model) || model.length > 200) throw new SettingsValidationError("Invalid localModels.multiGpu.pins.");
          deviceIds(ids, "localModels.multiGpu.pins");
        }
      }
    }
    const gpuLayers = localModels.gpuLayers;
    if (gpuLayers !== undefined && gpuLayers !== "auto" && !(typeof gpuLayers === "number" && Number.isInteger(gpuLayers) && gpuLayers >= 0 && gpuLayers <= 999)) {
      throw new SettingsValidationError("Invalid localModels.gpuLayers.");
    }
    if (localModels.generation !== undefined) {
      const generation = object(localModels.generation, "localModels.generation");
      if (generation.preset !== undefined && !["server", "precise", "balanced", "creative", "custom"].includes(generation.preset as string)) {
        throw new SettingsValidationError("Invalid localModels.generation.preset.");
      }
      const decimalRanges: Record<string, readonly [number, number]> = {
        temperature: [0, 2], topP: [0, 1], minP: [0, 1], repeatPenalty: [0, 2]
      };
      for (const [key, range] of Object.entries(decimalRanges)) {
        const value = generation[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < range[0] || value > range[1])) {
          throw new SettingsValidationError(`Invalid localModels.generation.${key}.`);
        }
      }
      const integerRanges: Record<string, readonly [number, number]> = {
        topK: [0, 200], maxTokens: [1, 32768], seed: [-1, 2147483647]
      };
      for (const [key, range] of Object.entries(integerRanges)) {
        const value = generation[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < range[0] || value > range[1])) {
          throw new SettingsValidationError(`Invalid localModels.generation.${key}.`);
        }
      }
    }
  }
  if (patch.agentLimits !== undefined) check(object(patch.agentLimits, "agentLimits"), "agentLimits", {
    maxSteps: [0, Number.MAX_SAFE_INTEGER], advisorMaxSteps: [0, Number.MAX_SAFE_INTEGER], maxTotalSteps: [0, Number.MAX_SAFE_INTEGER],
    maxActiveMs: [0, Number.MAX_SAFE_INTEGER], maxRepairs: [1, 10], contextChars: [4096, 200000]
  });
  if (patch.llm !== undefined) check(object(patch.llm, "llm"), "llm", { defaultProvider: "string" });
  if (patch.providers !== undefined) for (const [id, provider] of Object.entries(object(patch.providers, "providers"))) {
    // Removed: only a provider the user added; the built-ins and the services every installation has stay.
    if (provider === null) {
      if (BUILT_IN_PROVIDER_IDS.includes(id) || providerPreset(id)?.builtIn) throw new SettingsValidationError(`providers.${id} cannot be removed. Turn it off instead.`);
      continue;
    }
    const value = object(provider, `providers.${id}`);
    // Where a service comes from is the installation's to say, never a setting.
    if (value.source !== undefined) throw new SettingsValidationError(`providers.${id}.source cannot be set.`);
    check(value, `providers.${id}`, {
      enabled: "boolean", baseUrl: "string", apiKey: "string", model: "string", timeoutMs: [1000, 3600000],
      version: "string", maxTokens: [1, 1000000], kind: ["openai-compatible"], dialect: "string", name: "string", preset: "string"
    });
    // An OpenAI-compatible service is data: a safe id, a known dialect, a short name and a web address.
    const compatible = value.kind !== undefined || value.dialect !== undefined || value.name !== undefined || value.preset !== undefined;
    if (value.preset !== undefined && !providerPreset(String(value.preset))) throw new SettingsValidationError(`Invalid providers.${id}.preset.`);
    if (compatible && BUILT_IN_PROVIDER_IDS.includes(id)) throw new SettingsValidationError(`providers.${id} is built in.`);
    if (compatible && !/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new SettingsValidationError("Invalid provider id.");
    if (value.dialect !== undefined && !isProviderDialect(value.dialect)) throw new SettingsValidationError(`Invalid providers.${id}.dialect.`);
    if (typeof value.name === "string" && (!value.name.trim() || value.name.length > 80 || /[\u0000-\u001f\u007f]/.test(value.name))) throw new SettingsValidationError(`Invalid providers.${id}.name.`);
    if ((compatible || providerPreset(id)) && typeof value.baseUrl === "string" && value.baseUrl !== "" && !isWebAddress(value.baseUrl)) throw new SettingsValidationError(`Invalid providers.${id}.baseUrl.`);
  }
  if (patch.plugins !== undefined) for (const [id, plugin] of Object.entries(object(patch.plugins, "plugins"))) {
    if (["file", "notion", "vscode"].includes(id)) throw new SettingsValidationError("Legacy plugins were retired. Use Integrations or built-in filesystem settings.");
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
