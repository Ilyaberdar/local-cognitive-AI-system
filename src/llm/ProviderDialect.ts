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
  /** Every request goes to chat completions: most cloud services offer only that, or only that fully. */
  readonly chatOnly?: boolean;
  /** Chat completions are always streamed: some thinking models answer only when streamed, and the
   * reasoning then shows while it is written. */
  readonly streamChat?: boolean;
  /** How chat completions ask for reasoning: Qwen's enable_thinking switch. */
  readonly thinking?: "enable_thinking";
  /** JSON mode is refused unless the messages say "JSON" (Qwen): the instructions then ask for it. */
  readonly jsonKeyword?: boolean;
  /** Models offered when the service's list cannot be read, and ids in its list that are not chat models. */
  readonly models?: { fallback: string[]; exclude?: RegExp };
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

/** Qwen through Alibaba Cloud Model Studio (QwenCloud, formerly DashScope): its OpenAI-compatible
 * chat completions. Thinking is switched by the effort (low or none: off), and its chat is streamed
 * because some Qwen models think only when streamed. JSON mode wants the word in the messages. Tools
 * run through the JSON protocol until chat tool calls are read. */
export const QWEN_DIALECT: ProviderDialect = {
  id: "qwen", requiresKey: true, retries: true, chatOnly: true, streamChat: true, effort: "capped", thinking: "enable_thinking", jsonKeyword: true,
  models: {
    fallback: ["qwen3.8-max", "qwen3.7-plus", "qwen3.8-flash", "qwen3.7-flash", "qwen3-coder-plus", "qwen3-coder-flash", "qwen3-vl-plus"],
    exclude: /embed|rerank|tts|asr|audio|speech|image|wanx?\d|video|realtime|livetranslate|ocr/i
  },
  capabilities: { local: false, managed: false, jsonMode: true, nativeTools: false, structuredOutputs: false, reasoning: true, vision: true }
};

/** Any OpenAI-compatible cloud service: chat completions with a key, retried, JSON mode. */
export const CHAT_DIALECT: ProviderDialect = {
  id: "chat", requiresKey: true, retries: true, chatOnly: true, effort: "capped",
  capabilities: { local: false, managed: false, jsonMode: true, nativeTools: false, structuredOutputs: false, reasoning: false, vision: false }
};

const DIALECTS: Record<string, ProviderDialect> = { qwen: QWEN_DIALECT, chat: CHAT_DIALECT };
export const isProviderDialect = (name: unknown): boolean => typeof name === "string" && Object.hasOwn(DIALECTS, name);
/** The dialect a provider that is data names; an unknown name is a plain OpenAI-compatible service. */
export const compatibleDialect = (name: string | undefined): ProviderDialect => (name && DIALECTS[name]) || CHAT_DIALECT;

/** The dialect of a provider constructed by id: the built-ins, or a plain OpenAI-compatible server. */
export function dialectFor(id: string): ProviderDialect {
  if (id === "openai") return OPENAI_DIALECT;
  if (id === "lmstudio") return LMSTUDIO_DIALECT;
  if (id === "llamacpp") return LLAMACPP_DIALECT;
  return { id: "compatible", requiresKey: false, retries: false, effort: "capped", capabilities: builtInCapabilities(id) };
}
