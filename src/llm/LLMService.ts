import { LLMRequest, LLMResponse } from "../types";
import { Logger } from "../utils/Logger";
import { tryParseJson } from "../utils/Json";
import { OutputSanitizer } from "./OutputSanitizer";
import { LLMRegistry } from "./LLMRegistry";

export class LLMService {
  constructor(
    private readonly registry: LLMRegistry,
    private readonly defaultProviderId: string,
    private readonly logger: Logger,
    private readonly sanitizer: OutputSanitizer
  ) {}

  async generateText(request: LLMRequest, providerId?: string): Promise<LLMResponse> {
    const targetProviderId = providerId ?? this.defaultProviderId;
    const provider = this.registry.get(targetProviderId);
    const response = await provider.generateText(request);

    return {
      ...response,
      text: this.sanitizer.sanitize(response.text)
    };
  }

  async generateObject<T extends object>(
    request: LLMRequest,
    providerId?: string
  ): Promise<{ data: T | null; response: LLMResponse }> {
    const targetProviderId = providerId ?? this.defaultProviderId;
    const schemaHint = [
      request.prompt,
      "",
      "Return valid JSON only. No markdown fence. No explanation outside JSON."
    ].join("\n");

    const response = await this.generateText(
      {
        ...request,
        prompt: schemaHint,
        responseFormat:
          targetProviderId === "openai"
            ? {
                type: "json_object" as const
              }
            : request.responseFormat
      },
      targetProviderId
    );

    const data = tryParseJson<T>(response.text);

    if (!data) {
      this.logger.warn("Failed to parse model JSON response", {
        provider: response.provider,
        model: response.model
      });
    }

    return { data, response };
  }
}
