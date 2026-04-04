import { LLMRequest, LLMResponse, ProviderDescriptor, ProviderModel } from "../types";
import { Logger } from "../utils/Logger";
import { LLMProvider } from "./LLMProvider";
import {
  buildComposedPrompt,
  buildFallbackResponse,
  createDescriptor,
  HttpProviderOptions,
  readUsage
} from "./provider-utils";

export class OllamaProvider implements LLMProvider {
  readonly id = "ollama";
  readonly name = "Ollama";
  readonly defaultModel: string;

  constructor(
    private readonly options: Omit<HttpProviderOptions, "id" | "name">,
    private readonly logger: Logger
  ) {
    this.defaultModel = options.model;
  }

  isConfigured(): boolean {
    return true;
  }

  getDescriptor(): ProviderDescriptor {
    return createDescriptor(
      {
        id: this.id,
        name: this.name,
        ...this.options
      },
      true
    );
  }

  async listModels(): Promise<ProviderModel[]> {
    const response = await fetch(`${this.options.baseUrl}/api/tags`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(this.options.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`Ollama tags request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };

    return (
      payload.models
        ?.map((model) => model.name ?? model.model)
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
      const response = await fetch(`${this.options.baseUrl}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          prompt: buildComposedPrompt(request),
          stream: false,
          ...(typeof request.maxTokens === "number"
            ? {
                options: {
                  num_predict: request.maxTokens
                }
              }
            : {})
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs)
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as { response?: string };

      return {
        provider: this.id,
        model,
        text: payload.response?.trim() || buildFallbackResponse(request, this.id, model).text,
        raw: payload,
        usage: readUsage(payload)
      };
    } catch (error) {
      this.logger.warn("Falling back to mock Ollama response", {
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
