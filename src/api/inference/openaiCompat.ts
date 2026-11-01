import { z } from "zod";
import { localThinkingBudgetForEffort } from "../../llm/ReasoningEffort";
import type { LLMImage, LLMResponse, LLMResponseFormat, ReasoningEffort } from "../../types";
import { InferenceApiError } from "./InferenceApiStore";

/** What an OpenAI chat completion request may carry here; anything else it sends is ignored. */
const textPart = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const imagePart = z.object({ type: z.literal("image_url"), image_url: z.union([z.string(), z.object({ url: z.string() }).passthrough()]) }).passthrough();
const content = z.union([z.string(), z.array(z.union([textPart, imagePart, z.object({ type: z.string() }).passthrough()])), z.null()]);
const message = z.object({ role: z.enum(["system", "developer", "user", "assistant", "tool", "function"]), content: content.optional() }).passthrough();
const stop = z.union([z.string(), z.array(z.string()).max(4)]).nullable().optional();
const finite = z.number().finite();

export const chatCompletionRequest = z.object({
  model: z.string().trim().min(1).max(300),
  messages: z.array(message).min(1).max(1000),
  stream: z.boolean().nullable().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().nullable().optional(),
  temperature: finite.min(0).max(2).nullable().optional(),
  top_p: finite.min(0).max(1).nullable().optional(),
  max_tokens: z.number().int().min(1).max(1_000_000).nullable().optional(),
  max_completion_tokens: z.number().int().min(1).max(1_000_000).nullable().optional(),
  stop,
  n: z.number().int().nullable().optional(),
  seed: z.number().int().nullable().optional(),
  reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).nullable().optional(),
  response_format: z.object({ type: z.string(), json_schema: z.object({ name: z.string().optional(), schema: z.record(z.string(), z.unknown()).optional() }).passthrough().optional() }).passthrough().nullable().optional(),
  tools: z.array(z.unknown()).nullable().optional()
}).passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequest>;

/** The request as the app's model layer takes it: one prompt with the conversation, a system prompt, images. */
export interface TranslatedRequest {
  systemPrompt?: string;
  prompt: string;
  images: LLMImage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop: string[];
  seed?: number;
  reasoning?: ReasoningEffort | "none";
  responseFormat?: LLMResponseFormat;
  stream: boolean;
  includeUsage: boolean;
}

const MAX_IMAGES = 5;

export const parseChatCompletion = (body: unknown): ChatCompletionRequest => {
  const parsed = chatCompletionRequest.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InferenceApiError(`Invalid request: ${issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "the body is not a chat completion."}`, "invalid_request_error");
  }
  return parsed.data;
};

/**
 * Turns an OpenAI chat completion into the model layer's request. System (and developer) messages
 * become the system prompt; a single user message is the prompt as it is, and a longer conversation
 * is written into the prompt turn by turn. Tools are not offered here, so a request with them, or with
 * several choices, is refused rather than answered differently from what was asked.
 */
export const translateChatCompletion = (request: ChatCompletionRequest): TranslatedRequest => {
  if (request.tools?.length) throw new InferenceApiError("Tools (function calling) are not supported by this API.", "unsupported_parameter");
  if (request.n !== undefined && request.n !== null && request.n !== 1) throw new InferenceApiError("Only one choice (n = 1) is supported.", "unsupported_parameter");
  const images: LLMImage[] = [];
  const system: string[] = [];
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];

  for (const item of request.messages) {
    if (item.role === "tool" || item.role === "function") throw new InferenceApiError("Tool messages are not supported by this API.", "unsupported_parameter");
    const parts = typeof item.content === "string" ? [{ type: "text", text: item.content }] : item.content ?? [];
    const texts: string[] = [];
    for (const part of parts as Array<Record<string, unknown>>) {
      if (part.type === "text" && typeof part.text === "string") { texts.push(part.text); continue; }
      if (part.type === "image_url") {
        if (item.role !== "user") throw new InferenceApiError("Images are taken only in user messages.", "invalid_request_error");
        const url = typeof part.image_url === "string" ? part.image_url : String((part.image_url as { url?: unknown })?.url ?? "");
        if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(url)) {
          throw new InferenceApiError("Images must be data: URLs (base64 PNG, JPEG, WebP or GIF); links are not fetched.", "invalid_image");
        }
        if (images.length >= MAX_IMAGES) throw new InferenceApiError(`At most ${MAX_IMAGES} images per request.`, "invalid_image");
        images.push({ name: `image-${images.length + 1}`, dataUrl: url });
        continue;
      }
      throw new InferenceApiError(`Message content of type "${String(part.type)}" is not supported.`, "unsupported_parameter");
    }
    const text = texts.join("\n");
    if (item.role === "system" || item.role === "developer") { if (text.trim()) system.push(text); continue; }
    turns.push({ role: item.role, text });
  }

  const last = turns[turns.length - 1];
  if (!last || last.role !== "user") throw new InferenceApiError("The last message must be the user's.", "invalid_request_error");
  const prompt = turns.length === 1
    ? last.text
    : [...turns.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`), "Assistant:"].join("\n\n");

  const stopList = request.stop == null ? [] : (Array.isArray(request.stop) ? request.stop : [request.stop]).filter(Boolean);
  const maxTokens = request.max_completion_tokens ?? request.max_tokens ?? undefined;
  return {
    ...(system.length ? { systemPrompt: system.join("\n\n") } : {}),
    prompt,
    images,
    ...(request.temperature != null ? { temperature: request.temperature } : {}),
    ...(request.top_p != null ? { topP: request.top_p } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    stop: stopList,
    ...(request.seed != null ? { seed: request.seed } : {}),
    ...(request.reasoning_effort ? { reasoning: request.reasoning_effort === "minimal" ? "low" as const : request.reasoning_effort } : {}),
    ...(responseFormat(request.response_format) ? { responseFormat: responseFormat(request.response_format) } : {}),
    stream: request.stream === true,
    includeUsage: request.stream_options?.include_usage === true
  };
};

const responseFormat = (format: ChatCompletionRequest["response_format"]): LLMResponseFormat | undefined => {
  if (!format || format.type === "text") return undefined;
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema") {
    const schema = format.json_schema?.schema;
    if (!schema) throw new InferenceApiError("response_format.json_schema.schema is required.", "invalid_request_error");
    const name = (format.json_schema?.name ?? "response").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "response";
    return { type: "json_schema", name, schema, strict: true };
  }
  throw new InferenceApiError(`response_format of type "${format.type}" is not supported.`, "unsupported_parameter");
};

/**
 * The tokens a local model may think before it answers: as in the app's chats, the budget of the level
 * asked for (Balanced otherwise), and at most half of max_tokens, so that thinking cannot take the whole answer.
 */
export const thinkingBudget = (request: TranslatedRequest): number => {
  if (request.reasoning === "none") return 0;
  const budget = localThinkingBudgetForEffort(request.reasoning);
  return request.maxTokens ? Math.min(budget, Math.floor(request.maxTokens / 2)) : budget;
};

/** The model stopped at its token limit, in each provider's words. To an OpenAI client that is an answer, finish_reason "length", and not a failure. */
export const reachedTokenLimit = (response: LLMResponse): boolean => {
  const raw = response.raw as { choices?: Array<{ finish_reason?: unknown }>; incomplete_details?: { reason?: unknown }; stop_reason?: unknown; done_reason?: unknown; candidates?: Array<{ finishReason?: unknown }> } | undefined;
  return raw?.choices?.[0]?.finish_reason === "length" || raw?.incomplete_details?.reason === "max_output_tokens" || raw?.stop_reason === "max_tokens"
    || raw?.done_reason === "length" || raw?.candidates?.[0]?.finishReason === "MAX_TOKENS";
};

/** Cuts the text at the first stop sequence: the sequence itself is left out, as OpenAI does. */
export const applyStop = (text: string, stops: string[]): { text: string; stopped: boolean } => {
  let cut = -1;
  for (const sequence of stops) {
    const at = text.indexOf(sequence);
    if (at >= 0 && (cut < 0 || at < cut)) cut = at;
  }
  return cut < 0 ? { text, stopped: false } : { text: text.slice(0, cut), stopped: true };
};

/** The answer without a reasoning block a model writes before it (`<think>…</think>`), as it grows. */
export const withoutThinking = (raw: string): string => {
  const start = raw.trimStart();
  if (start.startsWith("<think>")) {
    const end = start.indexOf("</think>");
    return end < 0 ? "" : start.slice(end + "</think>".length).trimStart();
  }
  return "<think>".startsWith(start) ? "" : raw;
};

/** An error as OpenAI clients read it. */
export const openAiError = (message: string, code: string, type = "invalid_request_error") => ({ error: { message, type, code, param: null } });
