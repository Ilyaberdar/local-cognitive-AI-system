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
  if (![400, 404, 422, 501].includes(status) || !/not support|unsupported|not available|not implemented|not permitted|unknown (?:field|parameter|name)|unrecognized|extra inputs|invalid json payload/i.test(detail)) return;
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

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
const sum = (...values: Array<number | undefined>): number | undefined =>
  values.some(value => value !== undefined) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : undefined;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};

/** The tokens a provider reported for one response, in one shape for every provider: the input
 * includes cached prompt tokens, the output includes reasoning, and nothing unreported becomes 0.
 * OpenAI chat and Responses, Anthropic (whose input excludes the cache), Gemini's usageMetadata
 * (whose thoughts are outside the candidates), Ollama's eval counts and llama.cpp's timings. */
export const readUsage = (payload: unknown): TokenUsage | undefined => {
  const body = record(payload);
  let usage: TokenUsage;
  if (body.usage && typeof body.usage === "object") {
    const u = record(body.usage);
    const cacheWrite = count(u.cache_creation_input_tokens), cacheRead = count(u.cache_read_input_tokens);
    const anthropic = cacheWrite !== undefined || cacheRead !== undefined;
    const prompt = count(u.input_tokens) ?? count(u.prompt_tokens);
    const inputDetails = record(u.input_tokens_details ?? u.prompt_tokens_details);
    const outputDetails = record(u.output_tokens_details ?? u.completion_tokens_details);
    usage = {
      inputTokens: anthropic ? sum(prompt, cacheWrite, cacheRead) : prompt,
      outputTokens: count(u.output_tokens) ?? count(u.completion_tokens),
      totalTokens: count(u.total_tokens),
      cachedInputTokens: anthropic ? cacheRead : count(inputDetails.cached_tokens),
      cacheWriteTokens: cacheWrite,
      reasoningTokens: count(outputDetails.reasoning_tokens)
    };
  } else if (body.usageMetadata && typeof body.usageMetadata === "object") {
    const u = record(body.usageMetadata);
    const candidates = count(u.candidatesTokenCount), thoughts = count(u.thoughtsTokenCount);
    usage = {
      inputTokens: sum(count(u.promptTokenCount), count(u.toolUsePromptTokenCount)),
      // A response with only thinking reports no candidates; its output is still the thoughts.
      outputTokens: candidates === undefined && thoughts === undefined ? undefined : sum(candidates, thoughts),
      totalTokens: count(u.totalTokenCount),
      cachedInputTokens: count(u.cachedContentTokenCount),
      reasoningTokens: thoughts
    };
  } else if (count(body.prompt_eval_count) !== undefined || count(body.eval_count) !== undefined) {
    usage = { inputTokens: count(body.prompt_eval_count), outputTokens: count(body.eval_count) };
  } else {
    usage = {};
  }
  // llama.cpp's own timings fill what its OpenAI-style usage left out.
  const timings = record(body.timings);
  if (usage.inputTokens === undefined && count(timings.prompt_n) !== undefined) usage.inputTokens = sum(count(timings.prompt_n), count(timings.cache_n));
  if (usage.outputTokens === undefined) usage.outputTokens = count(timings.predicted_n);
  if (usage.cachedInputTokens === undefined && count(timings.cache_n)) usage.cachedInputTokens = count(timings.cache_n);
  if (usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) usage.totalTokens = usage.inputTokens + usage.outputTokens;
  const known = Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) as TokenUsage;
  return known.inputTokens === undefined && known.outputTokens === undefined && known.totalTokens === undefined ? undefined : known;
};

/** A fetch that marks each request it sends on the call's usage hook: every retry and repeat is
 * a request of its own in the usage ledger. */
export const countedFetch = (fetchImpl: typeof fetch, request: LLMRequest): typeof fetch => {
  const hook = request.usageCall;
  if (!hook) return fetchImpl;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const attempt = hook.attempt();
    try {
      const response = await fetchImpl(input, init);
      attempt.responded(response.status);
      return response;
    } catch (error) {
      attempt.failed(Boolean(request.signal?.aborted));
      throw error;
    }
  }) as typeof fetch;
};

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);
const retryAfterMs = (headers: Headers): number | undefined => {
  const exact = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(exact) && exact >= 0) return exact;
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
};
const pause = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal!.reason); };
  signal?.addEventListener("abort", stop, { once: true });
});

/** A cloud model request, retried as the providers' own SDKs do: up to twice on an overload,
 * a server error, a timeout status, a dropped connection, or a rate limit that says when to try
 * again (a 429 without that is usually a spending limit, which waiting does not fix). Waits
 * follow retry-after (at most 30 s) and end when the request is cancelled or times out. */
export async function fetchWithRetries(fetchImpl: typeof fetch, url: string, init: RequestInit, retries = 2): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try { response = await fetchImpl(url, init); }
    catch (error) {
      if (init.signal?.aborted || attempt >= retries || !(error instanceof TypeError)) throw error;
      await pause(500 * 2 ** attempt, init.signal);
      continue;
    }
    if (attempt >= retries || !RETRYABLE.has(response.status)) return response;
    const after = retryAfterMs(response.headers);
    if (response.status === 429 && after === undefined) return response;
    if (after !== undefined && after > 30_000) return response;
    await response.body?.cancel().catch(() => undefined);
    await pause(after ?? 500 * 2 ** attempt + Math.floor(Math.random() * 250), init.signal);
  }
}
