import { isProviderDialect } from "../llm/ProviderDialect";
import { BUILT_IN_PROVIDER_IDS, PROVIDER_PRESETS, providerPreset } from "../llm/providerCatalog";

/** An OpenAI-compatible service configured by the environment (a server's environment file). */
export interface EnvironmentProvider {
  name: string; dialect: string; baseUrl: string; model: string; timeoutMs: number; apiKey?: string;
  /** The preset it is (its regions, models and key page), when it is one. */
  preset?: string;
  /** Set and kept in the environment file, not in Settings: its address and key come from there. */
  source?: "environment";
}

/** Names of a service the owner adds in the environment: LOCAL_COGNITIVE_PROVIDER_<ID>_BASE_URL and its
 * _API_KEY, _MODEL, _NAME, _DIALECT and _TIMEOUT_MS. The id is <ID> in lower case, _ as -. */
export const CUSTOM_PROVIDER_ENV = /^LOCAL_COGNITIVE_PROVIDER_([A-Z][A-Z0-9_]{1,62})_(BASE_URL|API_KEY|MODEL|NAME|DIALECT|TIMEOUT_MS)$/;

const optional = (value: string | undefined) => value?.trim() ? value.trim() : undefined;
const webAddress = (value: string) => {
  try { const url = new URL(value); return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password; }
  catch { return false; }
};
const timeout = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1000 && parsed <= 3_600_000 ? parsed : fallback;
};

/** The OpenAI-compatible services an installation has from its environment:
 * - the built-in presets (Qwen), always, with their key when it is set;
 * - every other preset (DeepSeek, OpenRouter, Groq, Perplexity) whose key is set (DEEPSEEK_API_KEY…);
 * - the owner's own services, LOCAL_COGNITIVE_PROVIDER_<ID>_BASE_URL with its key and model.
 * An entry that is not valid (an id of a built-in or a preset, an address that is not a web address,
 * an unknown dialect) is left out and named in `refused`, never guessed. */
export function environmentProviders(env: NodeJS.ProcessEnv, defaultTimeoutMs: number): { providers: Record<string, EnvironmentProvider>; refused: string[] } {
  const providers: Record<string, EnvironmentProvider> = {}, refused: string[] = [];
  for (const preset of PROVIDER_PRESETS) {
    const apiKey = preset.env.apiKey.map(name => optional(env[name])).find(Boolean);
    if (!preset.builtIn && !apiKey) continue;
    providers[preset.id] = { name: preset.name, dialect: preset.dialect, baseUrl: optional(env[preset.env.baseUrl]) ?? preset.baseUrl,
      model: optional(env[preset.env.model]) ?? preset.model, timeoutMs: timeout(env[preset.env.timeoutMs], defaultTimeoutMs),
      ...(apiKey ? { apiKey } : {}), ...(preset.builtIn ? {} : { preset: preset.id, source: "environment" as const }) };
  }
  const custom = new Set<string>();
  for (const key of Object.keys(env)) { const match = CUSTOM_PROVIDER_ENV.exec(key); if (match) custom.add(match[1]!); }
  for (const name of [...custom].sort()) {
    const prefix = `LOCAL_COGNITIVE_PROVIDER_${name}_`;
    const id = name.toLowerCase().replace(/_/g, "-");
    const baseUrl = optional(env[`${prefix}BASE_URL`]), dialect = optional(env[`${prefix}DIALECT`]) ?? "chat";
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(id) || BUILT_IN_PROVIDER_IDS.includes(id) || providerPreset(id)) { refused.push(`${prefix}*: ${id} is a built-in or preset id`); continue; }
    if (!baseUrl || !webAddress(baseUrl)) { refused.push(`${prefix}BASE_URL: a web address (https://…) is required`); continue; }
    if (!isProviderDialect(dialect)) { refused.push(`${prefix}DIALECT: unknown dialect ${dialect}`); continue; }
    const apiKey = optional(env[`${prefix}API_KEY`]);
    const label = optional(env[`${prefix}NAME`]);
    providers[id] = { name: label && label.length <= 80 && !/[\u0000-\u001f\u007f]/.test(label) ? label : id, dialect, baseUrl,
      model: optional(env[`${prefix}MODEL`]) ?? "", timeoutMs: timeout(env[`${prefix}TIMEOUT_MS`], defaultTimeoutMs), ...(apiKey ? { apiKey } : {}), source: "environment" };
  }
  return { providers, refused };
}
