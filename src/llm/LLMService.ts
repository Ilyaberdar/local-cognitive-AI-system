import { LLMRequest, LLMResponse } from "../types";
import { Logger } from "../utils/Logger";
import { tryParseJson } from "../utils/Json";
import { OutputSanitizer } from "./OutputSanitizer";
import { LLMRegistry } from "./LLMRegistry";
import { currentInferenceProgress } from "./InferenceProgress";
import { currentInferenceImages, validateImages } from "./InferenceImages";

export class LLMService {
  constructor(
    private readonly registry: LLMRegistry,
    private readonly defaultProviderId: string,
    private readonly logger: Logger,
    private readonly sanitizer: OutputSanitizer
  ) {}

  async generateText(request: LLMRequest, providerId?: string): Promise<LLMResponse> {
    request.signal?.throwIfAborted();
    const targetProviderId = providerId ?? this.defaultProviderId;
    const provider = this.registry.get(targetProviderId);
    if (!provider.isConfigured()) {
      return { provider: provider.id, model: request.model ?? provider.defaultModel, text: "", error: `Provider ${provider.name} is disabled or not configured.` };
    }
    const images = validateImages(request.images ?? currentInferenceImages());
    const response = await provider.generateText({ ...request, images, onProgress: request.onProgress ?? currentInferenceProgress() });
    request.signal?.throwIfAborted();
    const text = this.sanitizer.sanitize(response.text);

    return {
      ...response,
      text,
      error: response.error || (!text ? "The model returned an empty response." : undefined)
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
          this.registry.get(targetProviderId).getDescriptor().capabilities?.jsonMode
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
