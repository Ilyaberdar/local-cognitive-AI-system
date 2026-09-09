import { LLMRequest, LLMResponse, ProviderDescriptor, ProviderRateLimit, TokenUsage } from "../types";

export interface HttpProviderOptions {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKey?: string;
}

export const createDescriptor = (
  options: HttpProviderOptions,
  configured: boolean
): ProviderDescriptor => ({
  id: options.id,
  name: options.name,
  configured,
  defaultModel: options.model
});

export const buildComposedPrompt = (request: LLMRequest): string =>
  request.systemPrompt ? `${request.systemPrompt}\n\n${request.prompt}` : request.prompt;

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

  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }

  if (typeof record.response === "string" && record.response.trim()) {
    return record.response.trim();
  }

  if (Array.isArray(record.output)) {
    const assistantMessageParts: string[] = [];
    const textParts: string[] = [];

    for (const item of record.output) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const outputItem = item as Record<string, unknown>;
      if (outputItem.type === "reasoning") continue;
      const isAssistantMessage =
        outputItem.type === "message" && outputItem.role === "assistant";
      const content = outputItem.content;

      if (!Array.isArray(content)) {
        continue;
      }

      for (const part of content) {
        if (!part || typeof part !== "object") {
          continue;
        }

        const contentPart = part as Record<string, unknown>;
        if (contentPart.type === "reasoning_text") continue;

        if (isAssistantMessage && typeof contentPart.output_text === "string") {
          assistantMessageParts.push(contentPart.output_text);
        }

        if (isAssistantMessage && typeof contentPart.text === "string") {
          assistantMessageParts.push(contentPart.text);
        }

        if (typeof contentPart.text === "string") {
          textParts.push(contentPart.text);
        }

        if (typeof contentPart.output_text === "string") {
          textParts.push(contentPart.output_text);
        }
      }
    }

    if (assistantMessageParts.length > 0) {
      return assistantMessageParts.join("\n").trim();
    }

    return textParts.join("\n").trim();
  }

  return "";
};

export const readResponseError = (payload: Record<string, unknown>): string | undefined => {
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
