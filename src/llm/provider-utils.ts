import { LLMRequest, LLMResponse, ProviderDescriptor, ProviderRateLimit, TokenUsage } from "../types";
import { messageText, responseMessages, responseRefusal } from "./ResponseItems";

export interface HttpProviderOptions {
  enabled?: boolean;
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKey?: string;
  reasoningEffort?: LLMRequest["reasoningEffort"];
}

export const createDescriptor = (
  options: HttpProviderOptions,
  configured: boolean
): ProviderDescriptor => ({
  id: options.id,
  name: options.name,
  configured,
  defaultModel: options.model,
  capabilities: {
    local: ["llamacpp", "lmstudio", "ollama"].includes(options.id),
    managed: ["llamacpp", "lmstudio", "ollama"].includes(options.id),
    jsonMode: ["openai", "llamacpp", "lmstudio", "ollama", "gemini"].includes(options.id),
    nativeTools: ["openai", "anthropic", "gemini"].includes(options.id),
    // Anthropic agents use native tools. If a compatibility endpoint rejects
    // tools, fall back directly to JSON rather than sending an unsupported
    // output_config schema payload as a second failed request.
    structuredOutputs: ["openai", "llamacpp", "lmstudio", "ollama", "gemini"].includes(options.id),
    reasoning: options.id === "openai",
    vision: ["openai", "anthropic", "gemini", "llamacpp", "lmstudio", "ollama"].includes(options.id)
  }
});

export const buildComposedPrompt = (request: LLMRequest): string =>
  request.systemPrompt ? `${request.systemPrompt}\n\n${request.prompt}` : request.prompt;

/** Downgrade only an explicitly unsupported protocol, never auth, quota, timeout or execution failures. */
export function unsupportedFeature(status: number, detail: string, request: LLMRequest): LLMResponse["unsupportedFeature"] {
  if (![400, 404, 422, 501].includes(status) || !/not support|unsupported|not available|not implemented|unknown (?:field|parameter)|unrecognized|extra inputs/i.test(detail)) return;
  if (request.tools?.length && /tool|function/i.test(detail)) return "tools";
  if (request.responseFormat && /schema|format|structured|json|grammar/i.test(detail)) return request.responseFormat.type === "json_schema" ? "schema" : "json";
}

export const resolveRequestTimeoutMs = (
  configuredTimeoutMs: number,
  requestTimeoutMs?: number
): number =>
  typeof requestTimeoutMs === "number" && Number.isFinite(requestTimeoutMs)
    ? Math.max(configuredTimeoutMs, requestTimeoutMs)
    : configuredTimeoutMs;

export const resolveAbortSignal = (timeoutMs: number, signal?: AbortSignal): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

export const buildFallbackResponse = (
  request: LLMRequest,
  provider: string,
  model: string,
  error?: string
): LLMResponse => {
  return {
    provider,
    model,
    text: "",
    error: error || "The model returned no final answer."
  };
};

export const readRateLimit = (headers: Headers): ProviderRateLimit | undefined => {
  const remainingRequests = headers.get("x-ratelimit-remaining-requests") ?? undefined;
  const remainingTokens = headers.get("x-ratelimit-remaining-tokens") ?? undefined;
  const resetRequests = headers.get("x-ratelimit-reset-requests") ?? undefined;
  const resetTokens = headers.get("x-ratelimit-reset-tokens") ?? undefined;

  if (!remainingRequests && !remainingTokens && !resetRequests && !resetTokens) {
    return undefined;
  }

  return {
    remainingRequests,
    remainingTokens,
    resetRequests,
    resetTokens
  };
};

export const readResponseText = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as Record<string, unknown>;

  if (Array.isArray(record.choices)) {
    const content = record.choices[0]?.message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) return content.filter(part => part?.type === "text").map(part => part.text ?? "").join("\n").trim();
  }

  // Preserve message/channel boundaries. A Responses convenience output_text may contain commentary too.
  if (Array.isArray(record.output)) {
    return responseMessages(record).map(messageText).filter(Boolean).join("\n").trim();
  }

  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }

  if (typeof record.response === "string" && record.response.trim()) {
    return record.response.trim();
  }


  return "";
};

export const readResponseError = (payload: Record<string, unknown>): string | undefined => {
  const refusal = responseRefusal(payload);
  if (refusal) return refusal;
  if (Array.isArray(payload.choices)) {
    const choice = payload.choices[0];
    if (choice?.message?.refusal) return `Model refused the request: ${choice.message.refusal}`;
    if (["length", "content_filter"].includes(choice?.finish_reason)) return `Model response stopped: ${choice.finish_reason}. No action was executed.`;
  }
  if (payload.done_reason === "length") return "Model response stopped at the token limit. No action was executed.";
  const error = payload.error;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const details = error as Record<string, unknown>;
    if (typeof details.message === "string") return details.message;
    if (typeof details.code === "string") return details.code;
    return "The provider reported a generation error.";
  }
  if (["failed", "cancelled", "incomplete"].includes(String(payload.status))) {
    const details = payload.incomplete_details as Record<string, unknown> | undefined;
    return `Model response ${payload.status}${typeof details?.reason === "string" ? `: ${details.reason}` : "."}`;
  }
  return undefined;
};

export const readUsage = (payload: unknown): TokenUsage | undefined => {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const usage = record.usage;

  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const usageRecord = usage as Record<string, unknown>;

  const inputTokens =
    typeof usageRecord.input_tokens === "number"
      ? usageRecord.input_tokens
      : typeof usageRecord.prompt_tokens === "number"
        ? usageRecord.prompt_tokens
        : undefined;
  const outputTokens =
    typeof usageRecord.output_tokens === "number"
      ? usageRecord.output_tokens
      : typeof usageRecord.completion_tokens === "number"
        ? usageRecord.completion_tokens
        : undefined;
  const totalTokens =
    typeof usageRecord.total_tokens === "number"
      ? usageRecord.total_tokens
      : typeof inputTokens === "number" || typeof outputTokens === "number"
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined;

  if (
    typeof inputTokens !== "number" &&
    typeof outputTokens !== "number" &&
    typeof totalTokens !== "number"
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
};
