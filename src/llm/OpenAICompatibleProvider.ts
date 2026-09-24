import { LLMRequest, LLMResponse, ProviderDescriptor, ProviderModel } from "../types";
import { Logger } from "../utils/Logger";
import { LLMProvider } from "./LLMProvider";
import { validateImages } from "./InferenceImages";
import {
  buildFallbackResponse,
  createDescriptor,
  HttpProviderOptions,
  readRateLimit,
  readResponseText,
  readResponseError,
  resolveAbortSignal,
  resolveRequestTimeoutMs,
  readUsage
} from "./provider-utils";

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;

  constructor(
    private readonly options: HttpProviderOptions,
    private readonly logger: Logger,
    private readonly fetchImpl?: typeof fetch
  ) {
    this.id = options.id;
    this.name = options.name;
    this.defaultModel = options.model;
  }

  isConfigured(): boolean {
    return this.options.enabled !== false && Boolean(this.options.baseUrl && this.options.model && (this.id !== "openai" || this.options.apiKey));
  }

  getDescriptor(): ProviderDescriptor {
    return createDescriptor(this.options, this.isConfigured());
  }

  async listModels(): Promise<ProviderModel[]> {
    const response = await (this.fetchImpl ?? fetch)(`${this.options.baseUrl}/models`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(this.options.apiKey
          ? {
              Authorization: `Bearer ${this.options.apiKey}`
            }
          : {})
      },
      signal: AbortSignal.timeout(Math.min(this.options.timeoutMs, 5000))
    });

    if (!response.ok) {
      throw new Error(`${this.id} models request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };

    return (
      payload.data
        ?.map((model) => model.id)
        .filter((modelId): modelId is string => Boolean(modelId))
        .map((modelId) => ({
          id: modelId,
          providerId: this.id,
          providerName: this.name
        })) ?? []
    );
  }

  async generateText(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model ?? this.options.model;
    const timeoutMs = resolveRequestTimeoutMs(this.options.timeoutMs, request.timeoutMs);

    try {
      const images = validateImages(request.images);
      const localBudget = this.id === "llamacpp" ? request.localReasoningBudget : undefined;
      if (localBudget !== undefined && (!Number.isInteger(localBudget) || localBudget < 0 || localBudget > 32768)) throw new Error("Local thinking budget must be 0–32768 tokens.");
      const useChat = (images.length > 0 && this.id !== "openai") || localBudget !== undefined;
      const response = await (this.fetchImpl ?? fetch)(`${this.options.baseUrl}/${useChat ? "chat/completions" : "responses"}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.options.apiKey
            ? {
                Authorization: `Bearer ${this.options.apiKey}`
              }
            : {})
        },
        body: JSON.stringify(useChat ? {
          model,
          messages: [
            ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
            { role: "user", content: images.length ? [
              { type: "text", text: request.prompt },
              ...images.map(image => ({ type: "image_url", image_url: { url: image.dataUrl } }))
            ] : request.prompt }
          ],
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          ...(localBudget === undefined ? {} : { reasoning_budget_tokens: localBudget,
            ...(localBudget === 0 ? { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } } : {}) }),
          ...(request.responseFormat ? { response_format: request.responseFormat } : {})
        } : {
          model,
          input: images.length ? [{ role: "user", content: [
            { type: "input_text", text: request.prompt },
            ...images.map(image => ({ type: "input_image", image_url: image.dataUrl, detail: "auto" }))
          ] }] : request.prompt,
          instructions: request.systemPrompt,
          previous_response_id: request.previousResponseId,
          ...((request.reasoningEffort ?? this.options.reasoningEffort) ? { reasoning: { effort: request.reasoningEffort ?? this.options.reasoningEffort } } : {}),
          ...(typeof request.maxTokens === "number"
            ? {
                max_output_tokens: request.maxTokens
              }
            : {}),
          ...(request.responseFormat
            ? {
                text: {
                  format: request.responseFormat
                }
              }
            : {})
        }),
        signal: resolveAbortSignal(timeoutMs, request.signal)
      });

      if (!response.ok) {
        const body = await response.text();
        let detail = body.slice(0, 1500);
        try { detail = readResponseError(JSON.parse(body)) ?? detail; } catch { /* Keep plain HTTP error details. */ }
        throw new Error(`${this.id} request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const text = readResponseText(payload);
      const error = readResponseError(payload) || (!text ? "The model returned no final answer (its response may contain only reasoning)." : undefined);

      return {
        provider: this.id,
        model,
        text,
        error,
        raw: payload,
        responseId: typeof payload.id === "string" ? payload.id : undefined,
        usage: readUsage(payload),
        rateLimit: readRateLimit(response.headers)
      };
    } catch (error) {
      if (request.signal?.aborted) {
        throw new Error("Request cancelled");
      }
      this.logger.warn(`${this.id} generation failed`, {
        error: error instanceof Error ? error.message : "unknown_error"
      });
      return buildFallbackResponse(
        request,
        this.id,
        model,
        error instanceof Error ? error.message : "unknown_error"
      );
    }
  }
}
