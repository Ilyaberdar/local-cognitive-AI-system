import { LLMRequest, LLMResponse, ProviderDescriptor, ProviderModel } from "../types";
import { Logger } from "../utils/Logger";
import { LLMProvider } from "./LLMProvider";
import { decodeImage, validateImages } from "./InferenceImages";
import {
  buildFallbackResponse,
  createDescriptor,
  HttpProviderOptions,
  readRateLimit,
  resolveAbortSignal,
  resolveRequestTimeoutMs,
  readUsage
} from "./provider-utils";

interface AnthropicProviderOptions extends Omit<HttpProviderOptions, "id" | "name"> {
  version: string;
  maxTokens: number;
}

export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";
  readonly name = "Anthropic";
  readonly defaultModel: string;

  constructor(
    private readonly options: AnthropicProviderOptions,
    private readonly logger: Logger
  ) {
    this.defaultModel = options.model;
  }

  isConfigured(): boolean {
    return this.options.enabled !== false && Boolean(this.options.apiKey);
  }

  getDescriptor(): ProviderDescriptor {
    return createDescriptor(
      {
        id: this.id,
        name: this.name,
        baseUrl: this.options.baseUrl,
        model: this.options.model,
        timeoutMs: this.options.timeoutMs,
        apiKey: this.options.apiKey
      },
      this.isConfigured()
    );
  }

  async listModels(): Promise<ProviderModel[]> {
    const models: ProviderModel[] = [];
    let afterId: string | undefined;

    do {
      const url = new URL(`${this.options.baseUrl.replace(/\/+$/, "")}/v1/models`);
      url.searchParams.set("limit", "1000");
      if (afterId) url.searchParams.set("after_id", afterId);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "x-api-key": this.options.apiKey ?? "",
          "anthropic-version": this.options.version
        },
        signal: AbortSignal.timeout(Math.min(this.options.timeoutMs, 5000))
      });

      if (!response.ok) {
        throw new Error(`Anthropic models request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as {
        data?: Array<{ id?: string }>;
        has_more?: boolean;
        last_id?: string;
      };

      models.push(
        ...(payload.data ?? [])
          .filter((model): model is { id: string } => Boolean(model.id))
          .map((model) => ({
            id: model.id,
            providerId: this.id,
            providerName: this.name
          }))
      );
      afterId = payload.has_more && payload.last_id ? payload.last_id : undefined;
    } while (afterId);

    return models;
  }

  async generateText(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model ?? this.options.model;
    const timeoutMs = resolveRequestTimeoutMs(this.options.timeoutMs, request.timeoutMs);

    try {
      const images = validateImages(request.images);
      const response = await fetch(`${this.options.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.options.apiKey ?? "",
          "anthropic-version": this.options.version
        },
        body: JSON.stringify({
          model,
          max_tokens: request.maxTokens ?? this.options.maxTokens,
          system: request.systemPrompt,
          messages: [
            {
              role: "user",
              content: images.length ? [
                ...images.map(image => { const decoded = decodeImage(image); return {
                  type: "image", source: { type: "base64", media_type: decoded.mimeType, data: decoded.data }
                }; }),
                { type: "text", text: request.prompt }
              ] : request.prompt
            }
          ]
        }),
        signal: resolveAbortSignal(timeoutMs, request.signal)
      });

      if (!response.ok) {
        throw new Error(`Anthropic request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as {
        id?: string;
        content?: Array<{ type?: string; text?: string }>;
      };

      const text =
        payload.content
          ?.filter((item) => item.type === "text" && item.text)
          .map((item) => item.text?.trim())
          .filter(Boolean)
          .join("\n") || buildFallbackResponse(request, this.id, model).text;

      return {
        provider: this.id,
        model,
        text,
        raw: payload,
        responseId: payload.id,
        usage: readUsage(payload),
        rateLimit: readRateLimit(response.headers)
      };
    } catch (error) {
      if (request.signal?.aborted) {
        throw new Error("Request cancelled");
      }
      this.logger.warn("Anthropic generation failed", {
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
