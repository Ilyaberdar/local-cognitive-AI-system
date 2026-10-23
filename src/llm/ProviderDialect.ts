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
  /** Agent actions are the service's own function calls: the Responses API's function tools, or chat
   * completions' tool calls (read without continuation: each turn is one request with the transcript). */
  readonly nativeTools?: "responses" | "chat";
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
  /** How chat completions ask for reasoning: Qwen's enable_thinking switch, or OpenRouter's reasoning object. */
  readonly thinking?: "enable_thinking" | "reasoning";
  /** JSON mode is refused unless the messages say "JSON" (Qwen): the instructions then ask for it. */
  readonly jsonKeyword?: boolean;
  /** Models offered when the service's list cannot be read, ids in its list that are not chat models,
   * and ids always offered first (Perplexity's presets, which its list does not name). */
  readonly models?: { fallback: string[]; exclude?: RegExp; pinned?: string[] };
  /** Perplexity: a model id that is one of these is sent as a preset; any other model gets the web
   * search tool, which an explicitly chosen model does not have on its own. */
  readonly presets?: string[];
  /** An output cap sent when the request has none (Perplexity's Anthropic models require one). */
  readonly defaultOutputTokens?: number;
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
 * because some Qwen models think only when streamed. JSON mode wants the word in the messages. Agents
 * act through its chat tool calls, read from the stream. */
export const QWEN_DIALECT: ProviderDialect = {
  id: "qwen", requiresKey: true, retries: true, chatOnly: true, streamChat: true, effort: "capped", thinking: "enable_thinking", jsonKeyword: true, nativeTools: "chat",
  models: {
    fallback: ["qwen3.8-max", "qwen3.7-plus", "qwen3.8-flash", "qwen3.7-flash", "qwen3-coder-plus", "qwen3-coder-flash", "qwen3-vl-plus"],
    exclude: /embed|rerank|tts|asr|audio|speech|image|wanx?\d|video|realtime|livetranslate|ocr/i
  },
  capabilities: { local: false, managed: false, jsonMode: true, nativeTools: true, structuredOutputs: false, reasoning: true, vision: true }
};

/** Any OpenAI-compatible cloud service: chat completions with a key, retried, JSON mode. Its agents act
 * in JSON unless the service answered a tool call when it was added (`withChatTools`). */
export const CHAT_DIALECT: ProviderDialect = {
  id: "chat", requiresKey: true, retries: true, chatOnly: true, effort: "capped",
  capabilities: { local: false, managed: false, jsonMode: true, nativeTools: false, structuredOutputs: false, reasoning: false, vision: false }
};

const CHAT_TOOLS = { ...CHAT_DIALECT.capabilities, nativeTools: true };
/** DeepSeek: JSON mode, like Qwen's, wants the word in the messages. Agents act through chat tool calls;
 * it may send several at once whatever parallel_tool_calls says (the first runs). */
export const DEEPSEEK_DIALECT: ProviderDialect = { ...CHAT_DIALECT, id: "deepseek", jsonKeyword: true, nativeTools: "chat", capabilities: CHAT_TOOLS,
  models: { fallback: ["deepseek-flash", "deepseek-v4-pro"] } };
/** Groq: its reasoning models (gpt-oss, Qwen) take the effort as reasoning_effort; one that does not says so. */
export const GROQ_DIALECT: ProviderDialect = { ...CHAT_DIALECT, id: "groq", chatEffort: true, nativeTools: "chat",
  capabilities: { ...CHAT_TOOLS, reasoning: true },
  models: { fallback: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"], exclude: /whisper|tts|orpheus|guard|playai|compound/i } };
/** OpenRouter: hundreds of models behind one key, its reasoning asked for in one shape for all of them.
 * A model without tool calls answers 404 "No endpoints found that support tool use": its agents act in JSON. */
export const OPENROUTER_DIALECT: ProviderDialect = { ...CHAT_DIALECT, id: "openrouter", thinking: "reasoning", nativeTools: "chat",
  capabilities: { ...CHAT_TOOLS, reasoning: true, vision: true } };
/** Perplexity's Agent API (Sonar moved there in September 2026): Responses-shaped requests, a preset
 * (fast to xhigh) or a model it hosts, answers searched on the web. Agents act through its function
 * tools, without web search beside them. A JSON schema is not used: it puts the keys in alphabetical
 * order, so an action's "type" would come after its arguments. */
const PERPLEXITY_PRESETS = ["fast", "low", "medium", "high", "xhigh"];
export const PERPLEXITY_DIALECT: ProviderDialect = { ...CHAT_DIALECT, id: "perplexity", chatOnly: false, allOnResponses: true, nativeTools: "responses", presets: PERPLEXITY_PRESETS, defaultOutputTokens: 16_000,
  capabilities: { ...CHAT_DIALECT.capabilities, jsonMode: false, nativeTools: true, reasoning: true, vision: true },
  models: { fallback: PERPLEXITY_PRESETS, pinned: PERPLEXITY_PRESETS } };

const DIALECTS: Record<string, ProviderDialect> = { qwen: QWEN_DIALECT, chat: CHAT_DIALECT, deepseek: DEEPSEEK_DIALECT,
  groq: GROQ_DIALECT, openrouter: OPENROUTER_DIALECT, perplexity: PERPLEXITY_DIALECT };
export const isProviderDialect = (name: unknown): boolean => typeof name === "string" && Object.hasOwn(DIALECTS, name);
/** The dialect a provider that is data names; an unknown name is a plain OpenAI-compatible service. */
export const compatibleDialect = (name: string | undefined): ProviderDialect => (name && DIALECTS[name]) || CHAT_DIALECT;
/** A dialect whose agents act through chat tool calls: a service added as Other that answered one when
 * it was added (its record says `nativeTools: "chat"`). A dialect with its own tools keeps them. */
export const withChatTools = (dialect: ProviderDialect): ProviderDialect => dialect.nativeTools ? dialect
  : { ...dialect, nativeTools: "chat", capabilities: { ...dialect.capabilities, nativeTools: true } };

/** The dialect of a provider constructed by id: the built-ins, or a plain OpenAI-compatible server. */
export function dialectFor(id: string): ProviderDialect {
  if (id === "openai") return OPENAI_DIALECT;
  if (id === "lmstudio") return LMSTUDIO_DIALECT;
  if (id === "llamacpp") return LLAMACPP_DIALECT;
  return { id: "compatible", requiresKey: false, retries: false, effort: "capped", capabilities: builtInCapabilities(id) };
}
