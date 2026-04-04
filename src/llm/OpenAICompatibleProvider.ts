import { LLMRequest, LLMResponse, ProviderDescriptor, ProviderModel } from "../types";
import { Logger } from "../utils/Logger";
import { LLMProvider } from "./LLMProvider";
import {
  buildFallbackResponse,
  createDescriptor,
  HttpProviderOptions,
  readRateLimit,
  readResponseText,
  readUsage
} from "./provider-utils";

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;

  constructor(
    private readonly options: HttpProviderOptions,
    private readonly logger: Logger
  ) {
    this.id = options.id;
    this.name = options.name;
    this.defaultModel = options.model;
  }

  isConfigured(): boolean {
    return Boolean(this.options.baseUrl && this.options.model);
  }

  getDescriptor(): ProviderDescriptor {
    return createDescriptor(this.options, this.isConfigured());
  }

  async listModels(): Promise<ProviderModel[]> {
    const response = await fetch(`${this.options.baseUrl}/models`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(this.options.apiKey
          ? {
              Authorization: `Bearer ${this.options.apiKey}`
            }
          : {})
      },
      signal: AbortSignal.timeout(this.options.timeoutMs)
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

    try {
      const response = await fetch(`${this.options.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.options.apiKey
            ? {
                Authorization: `Bearer ${this.options.apiKey}`
              }
            : {})
        },
        body: JSON.stringify({
          model,
          input: request.prompt,
          instructions: request.systemPrompt,
          previous_response_id: request.previousResponseId,
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
        signal: AbortSignal.timeout(this.options.timeoutMs)
      });

      if (!response.ok) {
        throw new Error(`${this.id} request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const text =
        readResponseText(payload) || buildFallbackResponse(request, this.id, model).text;

      return {
        provider: this.id,
        model,
        text,
        raw: payload,
        responseId: typeof payload.id === "string" ? payload.id : undefined,
        usage: readUsage(payload),
        rateLimit: readRateLimit(response.headers)
      };
    } catch (error) {
      this.logger.warn(`Falling back to mock ${this.id} response`, {
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
