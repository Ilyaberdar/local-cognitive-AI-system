import { LLMRequest, LLMResponse, ProviderDescriptor, ProviderModel } from "../types";
import { Logger } from "../utils/Logger";
import { LLMProvider } from "./LLMProvider";
import { decodeImage, validateImages } from "./InferenceImages";
import { geminiAgentResponse, geminiContinuation } from "./NativeToolTransport";
import { countedFetch, fetchWithRetries, unsupportedFeature } from "./provider-utils";
import {
  buildFallbackResponse,
  createDescriptor,
  HttpProviderOptions,
  resolveAbortSignal,
  resolveRequestTimeoutMs,
  readUsage
} from "./provider-utils";

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
    return this.options.enabled !== false && Boolean(this.options.apiKey);
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

  async listModels(): Promise<ProviderModel[]> {
    const models: ProviderModel[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${this.options.baseUrl.replace(/\/+$/, "")}/v1beta/models`);
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "x-goog-api-key": this.options.apiKey ?? ""
        },
        signal: AbortSignal.timeout(Math.min(this.options.timeoutMs, 5000))
      });

      if (!response.ok) {
        throw new Error(`Gemini models request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as {
        models?: Array<{
          name?: string;
          baseModelId?: string;
          supportedGenerationMethods?: string[];
          supported_generation_methods?: string[];
          supportedActions?: string[];
          supported_actions?: string[];
        }>;
        nextPageToken?: string;
      };

      models.push(
        ...(payload.models ?? [])
          .filter((model) => {
            const methods = model.supportedGenerationMethods ?? model.supported_generation_methods ?? model.supportedActions ?? model.supported_actions;
            return !methods || methods.some((method) => method.toLowerCase() === "generatecontent");
          })
          .flatMap((model) => {
            const id = model.baseModelId || model.name?.replace(/^models\//, "");
            return id
              ? [{
                  id,
                  providerId: this.id,
                  providerName: this.name
                }]
              : [];
          })
      );
      pageToken = payload.nextPageToken;
    } while (pageToken);

    return models;
  }

  async generateText(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model ?? this.options.model;
    const endpoint = `${this.options.baseUrl}/v1beta/models/${model.split("/").map(encodeURIComponent).join("/")}:generateContent`;
    const timeoutMs = resolveRequestTimeoutMs(this.options.timeoutMs, request.timeoutMs);

    try {
      const images = validateImages(request.images);
      const tools = request.outputPurpose === "agent-action" ? request.tools : undefined;
      const response = await fetchWithRetries(countedFetch(fetch, request), endpoint, {
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
          ...(tools?.length ? { tools: [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })) }],
            toolConfig: { functionCallingConfig: { mode: "AUTO" } } } : {}),
          contents: [
            {
              role: "user",
              parts: [{ text: request.prompt }, ...images.map(image => {
                const decoded = decodeImage(image);
                return { inline_data: { mime_type: decoded.mimeType, data: decoded.data } };
              })]
            },
            ...geminiContinuation(request.inputItems)
          ],
          generationConfig: {
            temperature: request.temperature,
            // Thinking models (2.5 and later) spend this on thinking too: a small cap would leave no answer.
            maxOutputTokens: request.maxTokens === undefined ? undefined : Math.max(request.maxTokens, 8192),
            ...(!tools?.length && request.responseFormat ? { responseMimeType: "application/json",
              ...(request.responseFormat.type === "json_schema" ? { responseJsonSchema: request.responseFormat.schema } : {}) } : {})
          }
        }),
        signal: resolveAbortSignal(timeoutMs, request.signal)
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1500);
        const unsupported = unsupportedFeature(response.status, detail, request);
        if (unsupported) return { provider: this.id, model, text: "", error: detail, unsupportedFeature: unsupported };
        throw new Error(`Gemini request failed with status ${response.status}: ${detail}`);
      }

      const payload = (await response.json()) as {
        candidates?: Array<{
          finishReason?: string;
          content?: {
            parts?: Array<{ text?: string; thought?: boolean }>;
          };
        }>;
      };

      const text =
        payload.candidates?.[0]?.content?.parts
          ?.filter(part => !part.thought)
          ?.map((part) => part.text?.trim())
          .filter(Boolean)
          .join("\n") || buildFallbackResponse(request, this.id, model).text;

      return {
        provider: this.id,
        model,
        text,
        ...(tools?.length ? geminiAgentResponse(payload.candidates?.[0]?.content ?? {}, tools) : {}),
        ...(payload.candidates?.[0]?.finishReason && payload.candidates[0].finishReason !== "STOP"
          ? { error: `Gemini response stopped: ${payload.candidates[0].finishReason}.` } : {}),
        raw: payload,
        usage: readUsage(payload)
      };
    } catch (error) {
      if (request.signal?.aborted) {
        throw new Error("Request cancelled");
      }
      this.logger.warn("Gemini generation failed", {
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
