import { LLMRequest, LLMResponse, ProviderDescriptor } from "../types";
import { Logger } from "../utils/Logger";
import { LLMProvider } from "./LLMProvider";
import { buildFallbackResponse, createDescriptor, HttpProviderOptions, readUsage } from "./provider-utils";

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
    return Boolean(this.options.apiKey);
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

  async generateText(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model ?? this.options.model;

    try {
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
              content: request.prompt
            }
          ]
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs)
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
        usage: readUsage(payload)
      };
    } catch (error) {
      this.logger.warn("Falling back to mock Anthropic response", {
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
