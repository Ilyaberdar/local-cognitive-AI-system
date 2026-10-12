import type { ProviderDescriptor } from "../types";

export type ProviderCapabilities = NonNullable<ProviderDescriptor["capabilities"]>;

/** How one OpenAI-compatible service differs from the others. The client asks its dialect instead
 * of checking which provider it is, so a new service is a dialect (or a preset of one), not new code
 * in every place that once compared ids. */
export interface ProviderDialect {
  readonly id: string;
  /** A key is needed before the provider counts as configured. */
  readonly requiresKey: boolean;
  /** Overloads, dropped connections and rate limits that say when are retried, as SDKs do. */
  readonly retries: boolean;
  /** JSON, agent actions and images go to the Responses API too (OpenAI). Otherwise they use
   * chat completions, and only plain prose goes to Responses. */
  readonly allOnResponses?: boolean;
  /** Agent actions use the Responses API's function tools. */
  readonly nativeTools?: "responses";
  /** Reasoning effort: every level up to max, levels above high lowered to high, or none sent. */
  readonly effort: "full" | "capped" | "ignored";
  /** Chat completions carry the effort as reasoning_effort (LM Studio's gpt-oss). */
  readonly chatEffort?: boolean;
  /** The app's own runtime: sampling, a thinking budget, streaming and a bounded prose answer. */
  readonly local?: boolean;
  /** The smallest output cap sent to the Responses API: a reasoning model's cap counts its reasoning. */
  readonly responsesOutputFloor?: number;
  readonly capabilities: ProviderCapabilities;
}

const LOCAL_IDS = ["llamacpp", "lmstudio", "ollama"];

/** What a built-in provider can do, by id. A provider that is data (an OpenAI-compatible service)
 * takes its capabilities from its dialect instead. */
export const builtInCapabilities = (id: string): ProviderCapabilities => ({
  local: LOCAL_IDS.includes(id),
  managed: LOCAL_IDS.includes(id),
  jsonMode: ["openai", "llamacpp", "lmstudio", "ollama", "gemini"].includes(id),
  nativeTools: ["openai", "anthropic", "gemini"].includes(id),
  // Anthropic agents use native tools. If a compatibility endpoint rejects tools, fall back
  // directly to JSON rather than sending an unsupported output_config schema payload as a second
  // failed request.
  structuredOutputs: ["openai", "llamacpp", "lmstudio", "ollama", "gemini"].includes(id),
  reasoning: id === "openai",
  vision: ["openai", "anthropic", "gemini", "llamacpp", "lmstudio", "ollama"].includes(id)
});

export const OPENAI_DIALECT: ProviderDialect = {
  id: "openai", requiresKey: true, retries: true, allOnResponses: true, nativeTools: "responses", effort: "full",
  responsesOutputFloor: 16_000, capabilities: builtInCapabilities("openai")
};
export const LMSTUDIO_DIALECT: ProviderDialect = {
  id: "lmstudio", requiresKey: false, retries: false, effort: "capped", chatEffort: true, capabilities: builtInCapabilities("lmstudio")
};
export const LLAMACPP_DIALECT: ProviderDialect = {
  id: "llamacpp", requiresKey: false, retries: false, effort: "ignored", local: true, capabilities: builtInCapabilities("llamacpp")
};

/** The dialect of a provider constructed by id: the built-ins, or a plain OpenAI-compatible server. */
export function dialectFor(id: string): ProviderDialect {
  if (id === "openai") return OPENAI_DIALECT;
  if (id === "lmstudio") return LMSTUDIO_DIALECT;
  if (id === "llamacpp") return LLAMACPP_DIALECT;
  return { id: "compatible", requiresKey: false, retries: false, effort: "capped", capabilities: builtInCapabilities(id) };
}
