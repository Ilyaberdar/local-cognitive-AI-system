import { LLMRequest, LLMResponse, ProviderDescriptor } from "../types";
import { Logger } from "../utils/Logger";
import { LLMProvider } from "./LLMProvider";
import { buildFallbackResponse, createDescriptor, HttpProviderOptions, readUsage } from "./provider-utils";

type GeminiProviderOptions = Omit<HttpProviderOptions, "id" | "name">;

export class GeminiProvider implements LLMProvider {
  readonly id = "gemini";
  readonly name = "Gemini";
  readonly defaultModel: string;

  constructor(
    private readonly options: GeminiProviderOptions,
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
        ...this.options
      },
      this.isConfigured()
    );
  }

  async generateText(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model ?? this.options.model;
    const endpoint = `${this.options.baseUrl}/v1beta/models/${model}:generateContent`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.options.apiKey ?? ""
        },
        body: JSON.stringify({
          system_instruction: request.systemPrompt
            ? {
                parts: [{ text: request.systemPrompt }]
              }
            : undefined,
          contents: [
            {
              role: "user",
              parts: [{ text: request.prompt }]
            }
          ],
          generationConfig: {
            temperature: request.temperature,
            maxOutputTokens: request.maxTokens
          }
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs)
      });

      if (!response.ok) {
        throw new Error(`Gemini request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      };

      const text =
        payload.candidates?.[0]?.content?.parts
          ?.map((part) => part.text?.trim())
          .filter(Boolean)
          .join("\n") || buildFallbackResponse(request, this.id, model).text;

      return {
        provider: this.id,
        model,
        text,
        raw: payload,
        usage: readUsage(payload)
      };
    } catch (error) {
      this.logger.warn("Falling back to mock Gemini response", {
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
