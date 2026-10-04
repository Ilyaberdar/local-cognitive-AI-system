import { LLMRequest, LLMResponse } from "../types";
import { Logger } from "../utils/Logger";
import { tryParseJson } from "../utils/Json";
import { OutputSanitizer } from "./OutputSanitizer";
import { LLMRegistry } from "./LLMRegistry";
import { currentInferenceProgress } from "./InferenceProgress";
import { currentInferenceImages, validateImages } from "./InferenceImages";
import { currentLocalThinkingBudget } from "./InferenceThinking";
import { parseJsonDocument, validateStructuredObject } from "./StructuredOutput";

export class LLMService {
  constructor(
    private readonly registry: LLMRegistry,
    private readonly defaultProviderId: string,
    private readonly logger: Logger,
    private readonly sanitizer: OutputSanitizer
  ) {}

  getContextWindow(providerId: string, modelId?: string): number | undefined {
    return this.registry.get(providerId).getContextWindow?.(modelId);
  }

  supportsNativeTools(providerId: string): boolean {
    return this.registry.get(providerId).getDescriptor().capabilities?.nativeTools === true;
  }

  supportsStructuredOutputs(providerId: string): boolean {
    return this.registry.get(providerId).getDescriptor().capabilities?.structuredOutputs === true;
  }

  async generateText(request: LLMRequest, providerId?: string): Promise<LLMResponse> {
    request.signal?.throwIfAborted();
    const targetProviderId = providerId ?? this.defaultProviderId;
    const provider = this.registry.get(targetProviderId);
    if (!provider.isConfigured()) {
      return { provider: provider.id, model: request.model ?? provider.defaultModel, text: "", error: `Provider ${provider.name} is disabled or not configured.` };
    }
    const images = validateImages(request.images ?? currentInferenceImages());
    const onProgress = request.onProgress ?? currentInferenceProgress();
    if (targetProviderId !== "llamacpp") onProgress?.({ phase: "waiting", model: request.model ?? provider.defaultModel });
    const response = await provider.generateText({ ...request, images, onProgress,
      localReasoningBudget: request.localReasoningBudget ?? currentLocalThinkingBudget() });
    request.signal?.throwIfAborted();
    // Machine actions cannot be extracted from examples, prose or an "Answer:" prefix.
    const text = request.outputPurpose === "agent-action"
      ? response.text.trim().replace(/^(?:\s*<(think|thinking|analysis)>[\s\S]*?<\/\1>\s*)+/i, "")
      : this.sanitizer.sanitize(response.text);

    return {
      ...response,
      text,
      error: response.error || (!text && !response.agentAction && !response.protocolError ? "The model returned an empty response." : undefined)
    };
  }

  async generateObject<T extends object>(
    request: LLMRequest,
    providerId?: string
  ): Promise<{ data: T | null; response: LLMResponse }> {
    const targetProviderId = providerId ?? this.defaultProviderId;
    const capabilities = this.registry.get(targetProviderId).getDescriptor().capabilities;
    const native = request.outputPurpose === "agent-action" && capabilities?.nativeTools && request.tools?.length;
    const schemaHint = [
      request.prompt,
      "",
      "Return valid JSON only. No markdown fence. No explanation outside JSON."
    ].join("\n");

    let generation: LLMRequest = {
        ...request,
        prompt: native ? request.prompt : schemaHint,
        responseFormat: native || request.responseFormat === null ? undefined : request.responseFormat?.type === "json_schema" && capabilities?.structuredOutputs
          ? request.responseFormat : capabilities?.jsonMode ? { type: "json_object" } : undefined
      };
    let response = await this.generateText(generation, targetProviderId);
    // Agent actions negotiate inside their persisted loop, where retries count against its budget.
    // Other structured requests use the same conservative compatibility fallback here.
    if (request.outputPurpose !== "agent-action") {
      for (let attempt = 0; attempt < 2 && response.unsupportedFeature; attempt++) {
        generation = { ...generation, responseFormat: generation.responseFormat?.type === "json_schema" && capabilities?.jsonMode
          ? { type: "json_object" } : null };
        response = await this.generateText(generation, targetProviderId);
      }
    }

    let data: T | null = null;
    if (!response.error && !response.protocolError) {
      if (response.agentAction) data = response.agentAction as unknown as T;
      else if (request.outputPurpose === "agent-action") {
        try { data = parseJsonDocument(response.text) as T; } catch { /* The saved agent loop supplies its bounded correction. */ }
      } else data = tryParseJson<T>(response.text);
    }
    if (!response.error && !response.protocolError && request.outputPurpose !== "agent-action" && request.responseFormat?.type === "json_schema") {
      try {
        data = parseJsonDocument(response.text) as T;
        const error = validateStructuredObject(data, request.responseFormat.schema);
        if (error) throw new Error(error);
      } catch (error) {
        data = null;
        response.error = `Invalid structured response: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (response.protocolError && request.outputPurpose !== "agent-action") response.error ??= response.protocolError;

    if (!data) {
      this.logger.warn("Failed to parse model JSON response", {
        provider: response.provider,
        model: response.model
      });
    }

    return { data, response };
  }
}
