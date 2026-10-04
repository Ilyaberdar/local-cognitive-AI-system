import { LLMRequest, LLMResponse, ProviderDescriptor, ProviderModel } from "../types";
import { Logger } from "../utils/Logger";
import { LLMProvider } from "./LLMProvider";
import { validateImages } from "./InferenceImages";
import { readLocalChatStream } from "./LocalChatStream";
import { readNativeAgentResponse, responseMessages } from "./ResponseItems";
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
import { unsupportedFeature } from "./provider-utils";

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
      const localSampling = this.id === "llamacpp" ? request.sampling : undefined;
      const localTemperature = request.temperature ?? localSampling?.temperature;
      const stream = this.id === "llamacpp" && Boolean(request.onProgress || request.onTextDelta && !request.responseFormat && request.outputPurpose !== "agent-action");
      if (localBudget !== undefined && (!Number.isInteger(localBudget) || localBudget < 0 || localBudget > 32768)) throw new Error("Local thinking budget must be 0–32768 tokens.");
      const useChat = stream || (images.length > 0 && this.id !== "openai") || localBudget !== undefined ||
        Boolean(localSampling && Object.values(localSampling).some(value => value !== undefined)) ||
        (this.id !== "openai" && (request.responseFormat !== undefined || request.outputPurpose === "agent-action"));
      const nativeTools = this.id === "openai" && request.outputPurpose === "agent-action" && request.tools?.length ? request.tools : undefined;
      const response = await (this.fetchImpl ?? fetch)(`${this.options.baseUrl.replace(/\/+$/, "")}/${useChat ? "chat/completions" : "responses"}`, {
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
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
          messages: [
            ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
            { role: "user", content: images.length ? [
              { type: "text", text: request.prompt },
              ...images.map(image => ({ type: "image_url", image_url: { url: image.dataUrl } }))
            ] : request.prompt }
          ],
          ...(typeof request.maxTokens === "number" ? { max_tokens: request.maxTokens } : {}),
          ...(typeof localTemperature === "number" ? { temperature: localTemperature } : {}),
          ...(localSampling?.topP !== undefined ? { top_p: localSampling.topP } : {}),
          ...(localSampling?.topK !== undefined ? { top_k: localSampling.topK } : {}),
          ...(localSampling?.minP !== undefined ? { min_p: localSampling.minP } : {}),
          ...(localSampling?.repeatPenalty !== undefined ? { repeat_penalty: localSampling.repeatPenalty } : {}),
          ...(localSampling?.seed !== undefined ? { seed: localSampling.seed } : {}),
          ...(localBudget === undefined ? {} : { reasoning_budget_tokens: localBudget,
            ...(localBudget === 0 ? { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } } : {}) }),
          ...(request.responseFormat ? { response_format: request.responseFormat.type === "json_schema"
            ? { type: "json_schema", json_schema: { name: request.responseFormat.name, strict: true, schema: request.responseFormat.schema } }
            : request.responseFormat } : {})
        } : {
          model,
          input: images.length || nativeTools || request.inputItems?.length ? [{ role: "user", content: [
            { type: "input_text", text: request.prompt },
            ...images.map(image => ({ type: "input_image", image_url: image.dataUrl, detail: "auto" }))
          ] }, ...(request.inputItems ?? [])] : request.prompt,
          instructions: request.systemPrompt,
          previous_response_id: request.previousResponseId,
          ...((request.reasoningEffort ?? this.options.reasoningEffort) ? { reasoning: { effort: request.reasoningEffort ?? this.options.reasoningEffort } } : {}),
          ...(typeof request.maxTokens === "number"
            ? {
                max_output_tokens: request.maxTokens
              }
            : {}),
          ...(nativeTools ? {
            tools: nativeTools.map(({ name, description, parameters }) => ({ type: "function", name, description, parameters, strict: true })),
            parallel_tool_calls: false,
            store: false,
            include: ["reasoning.encrypted_content"]
          } : {}),
          ...(!nativeTools && request.responseFormat
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
        const unsupported = unsupportedFeature(response.status, detail, request);
        if (unsupported) return { provider: this.id, model, text: "", error: detail, unsupportedFeature: unsupported };
        throw new Error(`${this.id} request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
      }

      let note = ""; let lastNoteAt = 0; let streamPhase = "";
      const emitNote = () => { if (note) request.onProgress?.({ phase: "thinking", model, note }); };
      const payload = stream && response.headers.get("content-type")?.includes("text/event-stream")
        ? await readLocalChatStream(response, delta => {
          if (streamPhase !== "responding") { emitNote(); streamPhase = "responding"; request.onProgress?.({ phase: "responding", model }); }
          // A partial JSON action is never a user-facing answer or an executable tool call.
          if (!request.responseFormat && request.outputPurpose !== "agent-action") request.onTextDelta?.(delta);
        }, delta => {
          note = (note + delta).slice(-6000);
          if (streamPhase !== "thinking" || Date.now() - lastNoteAt >= 400) { streamPhase = "thinking"; lastNoteAt = Date.now(); emitNote(); }
        })
        : (await response.json()) as Record<string, unknown>;
      if (streamPhase === "thinking") emitNote();
      const text = readResponseText(payload);
      const action = nativeTools ? readNativeAgentResponse(payload, nativeTools) : undefined;
      const ambiguousJson = !nativeTools && request.responseFormat && responseMessages(payload).length > 1
        ? "The provider returned multiple final messages for one JSON response; they were not concatenated." : undefined;
      // A bounded prose answer is usable; truncated JSON/tool actions must still fail closed.
      const choices = payload.choices as Array<Record<string, unknown>> | undefined;
      const boundedProse = this.id === "llamacpp" && text && !request.responseFormat && request.outputPurpose !== "agent-action" && choices?.[0]?.finish_reason === "length";
      const errorPayload = boundedProse ? { ...payload, choices: [{ ...choices![0], finish_reason: "stop" }] } : payload;
      const error = readResponseError(errorPayload) || (!text && !action ? "The model returned no final answer (its response may contain only reasoning)." : undefined);

      return {
        provider: this.id,
        model,
        text,
        error,
        ...action,
        ...(ambiguousJson ? { protocolError: ambiguousJson } : {}),
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
