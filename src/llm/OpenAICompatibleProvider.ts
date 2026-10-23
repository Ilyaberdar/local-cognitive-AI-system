import { LLMFunctionTool, LLMRequest, LLMResponse, ProviderDescriptor, ProviderModel } from "../types";
import { answerStream, finalAnswerSoFar } from "./AnswerStream";
import { Logger } from "../utils/Logger";
import { LLMProvider } from "./LLMProvider";
import { ProviderHttpError, refusalMessage } from "./ProviderHttpError";
import { validateImages } from "./InferenceImages";
import { readLocalChatStream } from "./LocalChatStream";
import { readNativeAgentResponse, responseMessages } from "./ResponseItems";
import { chatAgentResponse } from "./NativeToolTransport";
import {
  buildFallbackResponse,
  createDescriptor,
  HttpProviderOptions,
  readRateLimit,
  readResponseText,
  readResponseError,
  resolveAbortSignal,
  resolveRequestTimeoutMs,
  readUsage,
  fetchWholeWithRetries,
  fetchWithRetries,
  countedFetch,
  promptWithTurn
} from "./provider-utils";
import { unsupportedFeature } from "./provider-utils";
import { dialectFor, type ProviderDialect } from "./ProviderDialect";

export class OpenAICompatibleProvider implements LLMProvider {
  /** Models that refused a reasoning effort (not reasoning models): asked without one from then on. */
  private readonly withoutEffort = new Set<string>();
  /** Models that refused xhigh/max: asked for high instead. */
  private readonly effortCap = new Set<string>();
  /** Models that refused encrypted reasoning items (not reasoning models). */
  private readonly withoutEncrypted = new Set<string>();
  /** Models that refused function tools (an OpenRouter model no endpoint serves with tools): their
   * agents act in JSON from then on, and a request with tools is answered as refused without sending it. */
  private readonly withoutTools = new Map<string, string>();
  /** Models that refused the last turn's tool_choice "none" (but not tools): asked without a tool_choice from then on. */
  private readonly withoutToolChoice = new Set<string>();
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  private readonly dialect: ProviderDialect;

  constructor(
    private readonly options: HttpProviderOptions & { dialect?: ProviderDialect; catalog?: ProviderDescriptor["catalog"] },
    private readonly logger: Logger,
    private readonly fetchImpl?: typeof fetch
  ) {
    this.id = options.id;
    this.name = options.name;
    this.defaultModel = options.model;
    this.dialect = options.dialect ?? dialectFor(options.id);
  }

  isConfigured(): boolean {
    return this.options.enabled !== false && Boolean(this.options.baseUrl && this.options.model && (!this.dialect.requiresKey || this.options.apiKey));
  }

  /** Whether this model refused function tools in this session. */
  toolsRefused(model?: string): boolean {
    return this.withoutTools.has(model ?? this.options.model);
  }

  getDescriptor(): ProviderDescriptor {
    const descriptor = createDescriptor(this.options, this.isConfigured(), this.dialect.capabilities);
    return this.options.catalog ? { ...descriptor, catalog: this.options.catalog } : descriptor;
  }

  /** The service's models. `strict` (adding a provider): a refused key or a wrong address is an
   * error instead of the models a dialect knows. */
  async listModels(options: { strict?: boolean } = {}): Promise<ProviderModel[]> {
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

    const known = this.dialect.models;
    if (!response.ok) {
      // A service that lists no models (or not on this path) still offers its known chat models.
      if (known && !options.strict) return known.fallback.map(id => ({ id, providerId: this.id, providerName: this.name }));
      throw new ProviderHttpError(`${this.id} models request failed with status ${response.status}`, response.status);
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };

    const listed = payload.data
      ?.map((model) => model.id)
      .filter((modelId): modelId is string => Boolean(modelId))
      .filter((modelId) => !known?.exclude?.test(modelId)) ?? [];
    const offered = listed.length || !known ? listed : known.fallback;
    return [...new Set([...(known?.pinned ?? []), ...offered])].map((modelId) => ({
      id: modelId,
      providerId: this.id,
      providerName: this.name
    }));
  }

  async generateText(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model ?? this.options.model;
    const timeoutMs = resolveRequestTimeoutMs(this.options.timeoutMs, request.timeoutMs);

    try {
      const images = validateImages(request.images);
      const dialect = this.dialect;
      const localBudget = dialect.local ? request.localReasoningBudget : undefined;
      // OpenAI's reasoning models take levels up to max (one that does not says so, and is asked for
      // high from then on); LM Studio's take low, medium or high.
      const requested = dialect.effort === "ignored" || this.withoutEffort.has(model) ? undefined : request.reasoningEffort ?? this.options.reasoningEffort;
      const effort = (dialect.effort !== "full" || this.effortCap.has(model)) && (requested === "xhigh" || requested === "max") ? "high" : requested;
      const localSampling = dialect.local ? request.sampling : undefined;
      const localTemperature = request.temperature ?? localSampling?.temperature;
      const stream = Boolean(dialect.streamChat) || Boolean(dialect.local) && Boolean(request.onProgress || request.onTextDelta && !request.responseFormat && request.outputPurpose !== "agent-action");
      if (localBudget !== undefined && (!Number.isInteger(localBudget) || localBudget < 0 || localBudget > 32768)) throw new Error("Local thinking budget must be 0–32768 tokens.");
      const useChat = Boolean(dialect.chatOnly) || stream || (images.length > 0 && !dialect.allOnResponses) || localBudget !== undefined ||
        Boolean(localSampling && Object.values(localSampling).some(value => value !== undefined)) ||
        (!dialect.allOnResponses && (request.responseFormat !== undefined || request.outputPurpose === "agent-action"));
      const nativeTools = dialect.nativeTools && request.outputPurpose === "agent-action" && request.tools?.length ? request.tools : undefined;
      const refusedTools = nativeTools ? this.withoutTools.get(model) : undefined;
      if (refusedTools !== undefined) return { provider: this.id, model, text: "", error: refusedTools, unsupportedFeature: "tools" };
      const url = `${this.options.baseUrl.replace(/\/+$/, "")}/${useChat ? "chat/completions" : "responses"}`;
      // A cloud service is retried on overload and rate limits as its SDK does; a local server is not.
      const fetchImpl = countedFetch(this.fetchImpl ?? fetch, request);
      // An answer that is not streamed is read whole, and asked for again when the connection cuts it off.
      const send = (init: RequestInit) => !dialect.retries ? fetchImpl(url, init) : stream ? fetchWithRetries(fetchImpl, url, init) : fetchWholeWithRetries(fetchImpl, url, init);
      // Thinking on from a medium effort up, as the service's own thinking models default to; off for
      // low, and when no effort is asked (a helper call).
      const thinking = dialect.thinking === "enable_thinking" ? Boolean(effort && effort !== "low") : undefined;
      const wantsJson = request.responseFormat?.type === "json_object" || request.responseFormat?.type === "json_schema";
      const systemPrompt = dialect.jsonKeyword && wantsJson && !/json/i.test(`${request.systemPrompt ?? ""} ${request.prompt}`)
        ? [request.systemPrompt, "Reply with a JSON object."].filter(Boolean).join("\n\n") : request.systemPrompt;
      const response = await send({
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
            ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
            { role: "user", content: images.length ? [
              { type: "text", text: promptWithTurn(request) },
              ...images.map(image => ({ type: "image_url", image_url: { url: image.dataUrl } }))
            ] : promptWithTurn(request) }
          ],
          // With thinking on, Qwen takes at most 32768 here.
          ...(typeof request.maxTokens === "number" ? { max_tokens: thinking ? Math.min(request.maxTokens, 32_768) : request.maxTokens } : {}),
          ...(typeof localTemperature === "number" ? { temperature: localTemperature } : {}),
          ...(localSampling?.topP !== undefined ? { top_p: localSampling.topP } : {}),
          ...(localSampling?.topK !== undefined ? { top_k: localSampling.topK } : {}),
          ...(localSampling?.minP !== undefined ? { min_p: localSampling.minP } : {}),
          ...(localSampling?.repeatPenalty !== undefined ? { repeat_penalty: localSampling.repeatPenalty } : {}),
          ...(localSampling?.seed !== undefined ? { seed: localSampling.seed } : {}),
          // LM Studio's reasoning models (gpt-oss) take the effort on chat completions too.
          ...(dialect.chatEffort && effort ? { reasoning_effort: effort } : {}),
          ...(thinking === undefined ? {} : { enable_thinking: thinking }),
          ...(dialect.thinking === "reasoning" && effort ? { reasoning: { effort } } : {}),
          ...(localBudget === undefined ? {} : { reasoning_budget_tokens: localBudget,
            ...(localBudget === 0 ? { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } } : {}) }),
          // Chat tool calls, one a turn (DeepSeek may send several anyway: the first runs).
          ...(nativeTools ? { tools: nativeTools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: chatSchema(tool) } })),
            ...(this.withoutToolChoice.has(model) ? {} : { tool_choice: request.toolChoice ?? "auto" }), parallel_tool_calls: false } : {}),
          ...(!nativeTools && request.responseFormat ? { response_format: request.responseFormat.type === "json_schema"
            ? { type: "json_schema", json_schema: { name: request.responseFormat.name, strict: true, schema: request.responseFormat.schema } }
            : request.responseFormat } : {})
        } : {
          // An agent's next action is about its own tools and files: web results would only stand in for them.
          ...(dialect.presets?.includes(model) ? { preset: model } : { model, ...(dialect.presets && request.outputPurpose !== "agent-action" ? { tools: [{ type: "web_search" }] } : {}) }),
          // The turn's guidance follows the continuation: the last thing the model reads, after its latest results.
          input: images.length || nativeTools || request.inputItems?.length ? [{ role: "user", content: [
            { type: "input_text", text: request.inputItems?.length ? request.prompt : promptWithTurn(request) },
            ...images.map(image => ({ type: "input_image", image_url: image.dataUrl, detail: "auto" }))
          ] }, ...(request.inputItems ?? []),
          ...(request.inputItems?.length && request.turnPrompt ? [{ role: "user", content: [{ type: "input_text", text: request.turnPrompt }] }] : [])] : promptWithTurn(request),
          instructions: request.systemPrompt,
          previous_response_id: request.previousResponseId,
          ...(effort ? { reasoning: { effort } } : {}),
          ...(typeof request.maxTokens === "number"
            ? {
                // A reasoning model's limit counts its reasoning too: a small cap (a judge's 1200)
                // would leave no answer. It is a cap; only what is generated is billed.
                max_output_tokens: dialect.responsesOutputFloor ? Math.max(request.maxTokens, dialect.responsesOutputFloor) : request.maxTokens
              }
            : dialect.defaultOutputTokens ? { max_output_tokens: dialect.defaultOutputTokens } : {}),
          ...(nativeTools ? {
            tools: nativeTools.map(({ name, description, parameters }) => ({ type: "function", name, description, parameters: strictSchema(parameters), strict: true })),
            parallel_tool_calls: false,
            ...(request.toolChoice && !this.withoutToolChoice.has(model) ? { tool_choice: request.toolChoice } : {}),
            store: false,
            ...(this.withoutEncrypted.has(model) ? {} : { include: ["reasoning.encrypted_content"] })
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
        let param = "";
        try { param = String(JSON.parse(body)?.error?.param ?? ""); } catch { /* No structured error. */ }
        // A model that does not take this effort (or any): asked again without it, and from then on.
        if (effort && response.status === 400 && (/^reasoning[._]effort$/.test(param) || /reasoning[._]effort/i.test(detail))) {
          if ((effort === "xhigh" || effort === "max") && !/not supported with this model|unsupported parameter/i.test(detail)) this.effortCap.add(model);
          else this.withoutEffort.add(model);
          return this.generateText(request);
        }
        if (nativeTools && !this.withoutEncrypted.has(model) && response.status === 400 && (/^include/.test(param) || /encrypted/i.test(detail))) {
          this.withoutEncrypted.add(model);
          return this.generateText(request);
        }
        // Groq reads the tool call (or the JSON) a model wrote and refuses one that does not parse, with what it
        // wrote: a malformed reply that costs the agent a correction, not its run.
        const failed = request.outputPurpose === "agent-action" && response.status === 400 ? failedGeneration(body) : undefined;
        if (failed) return { provider: this.id, model, text: failed.text, protocolError: failed.reason };
        const unsupported = unsupportedFeature(response.status, detail, request);
        // A refusal of the last turn's tool_choice "none" is not one of the tools: asked once more without a
        // tool_choice (and so from then on), and only a refusal of that says the model has no tools.
        if (nativeTools && request.toolChoice === "none" && !this.withoutToolChoice.has(model) && [400, 404, 422].includes(response.status) &&
          (unsupported === "tools" || /tool.?choice/i.test(detail))) {
          this.withoutToolChoice.add(model);
          return this.generateText(request);
        }
        if (unsupported === "tools" && nativeTools) this.withoutTools.set(model, detail);
        if (unsupported) return { provider: this.id, model, text: "", error: detail, unsupportedFeature: unsupported };
        // The app's own llama.cpp server has no key a person enters.
        const refused = this.id === "llamacpp" ? undefined : refusalMessage(this.name, response.status, body.slice(0, 1500));
        if (refused) throw new ProviderHttpError(refused, response.status);
        throw new Error(`${this.id} request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
      }

      let note = ""; let lastNoteAt = 0; let streamPhase = ""; let generated = 0;
      // llama.cpp streams one token per delta: a count of both answer and thinking deltas.
      const counted = () => request.onGenerated?.(++generated);
      const finalAnswer = request.outputPurpose === "agent-action" && request.onFinalAnswer ? answerStream(finalAnswerSoFar, request.onFinalAnswer) : undefined;
      const emitNote = () => { if (note) request.onProgress?.({ phase: "thinking", model, note }); };
      const payload = stream && response.headers.get("content-type")?.includes("text/event-stream")
        ? await readLocalChatStream(response, delta => {
          counted();
          if (streamPhase !== "responding") { emitNote(); streamPhase = "responding"; request.onProgress?.({ phase: "responding", model }); }
          // A partial JSON action is never a user-facing answer or an executable tool call.
          if (!request.responseFormat && request.outputPurpose !== "agent-action") request.onTextDelta?.(delta);
          // Of an action, only the text of a final answer is shown while it is written.
          finalAnswer?.push(delta);
        }, delta => {
          counted();
          note = (note + delta).slice(-6000);
          if (streamPhase !== "thinking" || Date.now() - lastNoteAt >= 400) { streamPhase = "thinking"; lastNoteAt = Date.now(); emitNote(); }
        })
        : (await response.json()) as Record<string, unknown>;
      if (streamPhase === "thinking") emitNote();
      const text = readResponseText(payload);
      const action = nativeTools ? useChat ? chatAgentResponse(payload, nativeTools) : readNativeAgentResponse(payload, nativeTools) : undefined;
      const ambiguousJson = !nativeTools && request.responseFormat && responseMessages(payload).length > 1
        ? "The provider returned multiple final messages for one JSON response; they were not concatenated." : undefined;
      // A bounded prose answer is usable; truncated JSON/tool actions must still fail closed.
      const choices = payload.choices as Array<Record<string, unknown>> | undefined;
      const boundedProse = dialect.local && text && !request.responseFormat && request.outputPurpose !== "agent-action" && choices?.[0]?.finish_reason === "length";
      const errorPayload = boundedProse ? { ...payload, choices: [{ ...choices![0], finish_reason: "stop" }] } : payload;
      const error = readResponseError(errorPayload) || (!text && !action ? noFinalAnswer(payload, note) : undefined);

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

/** A tool schema as OpenAI's strict mode takes it: string length limits are not supported there
 * (the arguments are still checked here against the full schema). A bound that bounds nothing (zod's
 * integer maximum, 2^53 − 1) is left out: it is only tokens in every request. */
function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key, value]) => key !== "minLength" && key !== "maxLength" &&
    !(key === "maximum" && value === Number.MAX_SAFE_INTEGER) && !(key === "minimum" && value === Number.MIN_SAFE_INTEGER)).map(([key, value]) => [key, strictSchema(value)]));
}

/** A tool schema for chat completions, which have no strict mode: an optional argument is optional (not
 * required and nullable, which Groq checks a call against and some models fill with every default). */
function chatSchema(tool: LLMFunctionTool): unknown {
  const schema = strictSchema(tool.parameters) as { properties?: Record<string, { anyOf?: Array<{ type?: string }> }>; required?: string[] };
  if (!schema.properties) return schema;
  const optional = new Set(tool.optionalArguments);
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => {
    const choices = value.anyOf;
    return [key, optional.has(key) && choices?.length === 2 && choices[1]?.type === "null" ? choices[0] : value];
  }));
  return { ...schema, properties, ...(schema.required ? { required: schema.required.filter(key => !optional.has(key)) } : {}) };
}

/** Groq's refusal of a tool call or JSON the model wrote that did not parse (400 tool_use_failed or
 * json_validate_failed): what the model wrote, and what to send instead. */
function failedGeneration(body: string): { text: string; reason: string } | undefined {
  let error: Record<string, unknown> | undefined;
  try { error = JSON.parse(body)?.error; } catch { return undefined; }
  if (!error || typeof error !== "object" || !["tool_use_failed", "json_validate_failed"].includes(String(error.code))) return undefined;
  const text = typeof error.failed_generation === "string" ? error.failed_generation : "";
  return { text, reason: error.code === "tool_use_failed"
    ? "Your function call could not be read, so nothing ran. Call one function, with its arguments as one JSON object."
    : "Your reply was not valid JSON, so nothing ran. Send only the one JSON object." };
}

/** Why an answer has no text: only reasoning, or the model stopped at once. The words before the colon
 * stay the same: callers recognize this failure by them. */
function noFinalAnswer(payload: Record<string, unknown>, streamedReasoning: string): string {
  const choice = (payload.choices as Array<Record<string, any>> | undefined)?.[0];
  const reasoning = streamedReasoning || (typeof choice?.message?.reasoning_content === "string" ? choice.message.reasoning_content : "");
  const tokens = Number((payload.usage as Record<string, unknown> | undefined)?.completion_tokens);
  const count = Number.isFinite(tokens) && tokens > 0 ? ` (${tokens} token${tokens === 1 ? "" : "s"})` : "";
  if (reasoning.trim()) return `The model returned no final answer: it wrote only reasoning${count}${choice?.finish_reason === "length" ? " and reached the token limit" : ""}.`;
  return `The model returned no final answer: it stopped${count} without writing any text.`;
}
