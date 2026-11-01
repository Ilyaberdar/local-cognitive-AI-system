import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express, { NextFunction, Request, Response, Router } from "express";
import type { RuntimeManager } from "../../app/RuntimeManager";
import { maskKeyShapes } from "../../security/keyPatterns";
import type { LLMRequest, LLMResponse, LLMResponseFormat } from "../../types";
import { withUsageScope } from "../../usage/UsageScope";
import type { Logger } from "../../utils/Logger";
import { localApiOriginGuard } from "../integrationControllers";
import { InferenceApiError, InferenceApiStore, type InferenceApiConfig, type InferenceKeyInfo } from "./InferenceApiStore";
import { applyStop, openAiError, parseChatCompletion, translateChatCompletion, withoutThinking, type TranslatedRequest } from "./openaiCompat";

/** Requests one key may have running at once; more wait for an answer of 429. */
const PER_KEY_LIMIT = 4;
const KEEPALIVE_MS = 15_000;

export interface InferenceApiStatus extends InferenceApiConfig {
  /** Listening now (it may be on and still not listening: its port taken). */
  listening: boolean;
  /** The base URL clients use, on this computer. */
  url: string;
  error?: string;
  keys: InferenceKeyInfo[];
}

interface Target { providerId: string; model: string }

/**
 * An OpenAI-compatible API to this computer's models, on its own port: `GET /v1/models` and
 * `POST /v1/chat/completions` (with `stream`), for scripts, bots and other programs. Each request is
 * a model call alone: no memory, no tools, no chat is made or kept. It takes only the keys made for it
 * (never the app's own API key, which in turn opens nothing here), listens on 127.0.0.1 unless its
 * owner lets other devices on the network reach it, and loads no model: a local one must be loaded.
 */
export class InferenceApiServer {
  private server: Server | undefined;
  private listeningOn: { port: number; lan: boolean } | undefined;
  private lastError: string | undefined;
  private readonly running = new Map<string, number>();
  private applying: Promise<InferenceApiStatus> | undefined;

  constructor(private readonly deps: {
    store: InferenceApiStore;
    runtimeManager: RuntimeManager;
    logger: Logger;
    isDraining: () => boolean;
  }) {}

  /** Starts, moves or stops the listener to match the saved settings. A port in use is reported, never thrown. */
  apply(): Promise<InferenceApiStatus> {
    const next = (this.applying ?? Promise.resolve()).catch(() => undefined).then(() => this.applyNow());
    this.applying = next;
    return next;
  }

  async status(): Promise<InferenceApiStatus> {
    const config = await this.deps.store.config();
    return { ...config, listening: Boolean(this.server), url: `http://127.0.0.1:${this.listeningOn?.port ?? config.port}/v1`, ...(this.lastError ? { error: this.lastError } : {}) };
  }

  /** Changes the settings and applies them. */
  async configure(patch: Partial<InferenceApiConfig>): Promise<InferenceApiStatus> {
    await this.deps.store.setConfig(patch);
    return this.apply();
  }

  createKey(name: string) { return this.deps.store.createKey(name); }
  revokeKey(id: string) { return this.deps.store.revokeKey(id); }

  /** Requests being answered now. */
  activeCount(): number {
    return [...this.running.values()].reduce((sum, count) => sum + count, 0);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.listeningOn = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  /** The app's own routes for this API (settings, keys), behind the main API's key and origin checks. */
  managementRouter(): Router {
    const router = Router();
    router.use(localApiOriginGuard);
    router.get("/", async (_req, res, next) => { try { res.json(await this.status()); } catch (error) { next(error); } });
    router.put("/", async (req, res, next) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        if ((body.enabled !== undefined && typeof body.enabled !== "boolean") || (body.port !== undefined && typeof body.port !== "number") || (body.lan !== undefined && typeof body.lan !== "boolean")) {
          throw new InferenceApiError("enabled and lan are true or false, port a number.", "invalid_request");
        }
        res.json(await this.configure({ ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}), ...(body.port !== undefined ? { port: body.port as number } : {}), ...(body.lan !== undefined ? { lan: body.lan as boolean } : {}) }));
      } catch (error) { next(error); }
    });
    router.post("/keys", async (req, res, next) => {
      try { res.status(201).json(await this.deps.store.createKey(typeof req.body?.name === "string" ? req.body.name : "")); } catch (error) { next(error); }
    });
    router.delete("/keys/:keyId", async (req, res, next) => {
      try {
        if (!await this.deps.store.revokeKey(String(req.params.keyId))) { res.status(404).json({ error: "No key has that id." }); return; }
        res.status(204).send();
      } catch (error) { next(error); }
    });
    router.use((error: Error, _req: Request, res: Response, next: NextFunction) => {
      if (error instanceof InferenceApiError) { res.status(error.statusCode).json({ error: error.message, code: error.code }); return; }
      next(error);
    });
    return router;
  }

  private async applyNow(): Promise<InferenceApiStatus> {
    const config = await this.deps.store.config();
    const want = config.enabled ? { port: config.port, lan: config.lan } : undefined;
    if (this.server && (!want || want.port !== this.listeningOn?.port || want.lan !== this.listeningOn?.lan)) await this.close();
    if (!want) this.lastError = undefined;
    if (want && !this.server) {
      try {
        await this.listen(want.port, want.lan);
        this.lastError = undefined;
        this.deps.logger.info("The OpenAI-compatible API is listening", { port: want.port, lan: want.lan });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        this.lastError = code === "EADDRINUSE" ? `Port ${want.port} is used by another program: choose another port.`
          : code === "EACCES" ? `Port ${want.port} cannot be used: choose another port.` : `The API could not start: ${error instanceof Error ? error.message : String(error)}`;
        this.deps.logger.warn("The OpenAI-compatible API did not start", { port: want.port, code });
      }
    }
    return this.status();
  }

  private listen(port: number, lan: boolean): Promise<void> {
    const app = this.app(port, lan);
    return new Promise((resolve, reject) => {
      const server = app.listen(port, lan ? "0.0.0.0" : "127.0.0.1");
      server.once("error", reject);
      server.once("listening", () => {
        server.off("error", reject);
        server.on("error", (error) => this.deps.logger.warn("The OpenAI-compatible API failed", { message: error.message }));
        this.server = server;
        this.listeningOn = { port, lan };
        resolve();
      });
    });
  }

  private app(port: number, lan: boolean): express.Express {
    const app = express();
    app.disable("x-powered-by");
    // On this computer only, a page in a browser cannot reach it under another name (DNS rebinding).
    app.use((req, res, next) => {
      if (lan) return next();
      const host = (req.headers.host ?? "").toLowerCase();
      if ([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return next();
      res.status(403).json(openAiError("This API answers only at 127.0.0.1 or localhost.", "forbidden_host", "permission_error"));
    });
    app.use(async (req, res, next) => {
      try {
        const header = req.headers.authorization ?? "";
        const key = await this.deps.store.verify(/^Bearer\s+(\S+)$/i.exec(header)?.[1]);
        if (!key) {
          res.status(401).json(openAiError("Missing or unknown API key: make one in Local Cognitive (Settings → API) and send it as Authorization: Bearer <key>.", "invalid_api_key", "authentication_error"));
          return;
        }
        res.locals.key = key;
        next();
      } catch (error) { next(error); }
    });
    app.use(express.json({ limit: "16mb" }));
    app.get("/v1/models", (_req, res, next) => { void this.models().then((data) => res.json({ object: "list", data }), next); });
    app.post("/v1/chat/completions", (req, res, next) => { void this.complete(req, res).catch(next); });
    app.use((_req, res) => { res.status(404).json(openAiError("Not found: this API has GET /v1/models and POST /v1/chat/completions.", "not_found")); });
    app.use((error: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof InferenceApiError) { res.status(error.statusCode).json(openAiError(error.message, error.code)); return; }
      if (error.type === "entity.parse.failed") { res.status(400).json(openAiError("The body is not valid JSON.", "invalid_json")); return; }
      if (error.type === "entity.too.large") { res.status(413).json(openAiError("The request is larger than 16 MB.", "request_too_large")); return; }
      this.deps.logger.warn("An API request failed", { message: maskKeyShapes(error.message) });
      res.status(500).json(openAiError(maskKeyShapes(error.message) || "Internal error.", "internal_error", "server_error"));
    });
    return app;
  }

  /** The loaded local models (by their id), then each cloud provider set up here with its default model (as provider/model). */
  private async models() {
    const runtime = this.deps.runtimeManager.getRuntime();
    const settings = await this.deps.runtimeManager.getSettings();
    const created = Math.floor(Date.now() / 1000);
    const local = await runtime.localModelService.listAllModels().catch(() => []);
    const cloud = runtime.providerDescriptors.filter((provider) => provider.configured && !provider.capabilities?.local && settings.providers[provider.id]?.enabled);
    return [
      ...local.filter((model) => model.loaded).map((model) => ({ id: model.id, object: "model", created, owned_by: "local", name: model.displayName })),
      ...cloud.map((provider) => {
        const model = settings.providers[provider.id]?.model || provider.defaultModel;
        return { id: `${provider.id}/${model}`, object: "model", created, owned_by: provider.id, name: `${provider.name} · ${model}` };
      })
    ];
  }

  /** A model as named in the request: a loaded local model by its id, or provider/model for any other. */
  private async target(name: string): Promise<Target> {
    const runtime = this.deps.runtimeManager.getRuntime();
    const slash = name.indexOf("/");
    if (slash < 0 || name.startsWith("llamacpp/")) {
      const id = slash < 0 ? name : name.slice(slash + 1);
      const model = (await runtime.localModelService.listAllModels().catch(() => [])).find((item) => item.id === id);
      if (!model) throw new InferenceApiError(`No model "${id}" here: GET /v1/models lists the loaded ones; a cloud model is named provider/model.`, "model_not_found", 404);
      if (!model.loaded) throw new InferenceApiError(`"${id}" is not loaded: load it in Local Cognitive (Models) first.`, "model_not_loaded", 409);
      return { providerId: "llamacpp", model: id };
    }
    const providerId = name.slice(0, slash), model = name.slice(slash + 1).trim();
    const settings = await this.deps.runtimeManager.getSettings();
    const provider = runtime.providerDescriptors.find((item) => item.id === providerId);
    if (!provider || !provider.configured || !settings.providers[providerId]?.enabled || !model) {
      throw new InferenceApiError(`"${providerId}" is not set up here: GET /v1/models lists what is.`, "model_not_found", 404);
    }
    return { providerId, model };
  }

  private async complete(req: Request, res: Response): Promise<void> {
    if (this.deps.isDraining()) throw new InferenceApiError("Local Cognitive is stopping.", "unavailable", 503);
    const key = res.locals.key as InferenceKeyInfo;
    const body = parseChatCompletion(req.body);
    const request = translateChatCompletion(body);
    const target = await this.target(body.model);
    if ((this.running.get(key.id) ?? 0) >= PER_KEY_LIMIT) {
      res.setHeader("Retry-After", "2");
      throw new InferenceApiError(`This key already has ${PER_KEY_LIMIT} requests running.`, "rate_limit_exceeded", 429);
    }
    this.running.set(key.id, (this.running.get(key.id) ?? 0) + 1);
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableFinished) controller.abort(); });
    try {
      if (request.stream) await this.stream(res, request, target, body.model, key, controller.signal);
      else await this.answer(res, request, target, body.model, key, controller.signal);
    } finally {
      const left = (this.running.get(key.id) ?? 1) - 1;
      if (left > 0) this.running.set(key.id, left); else this.running.delete(key.id);
    }
  }

  private async answer(res: Response, request: TranslatedRequest, target: Target, model: string, key: InferenceKeyInfo, signal: AbortSignal): Promise<void> {
    const response = await this.generate(request, target, key, signal);
    if (signal.aborted) return;
    const failure = this.failure(response, request);
    if (failure) { res.status(failure.status).json(openAiError(failure.message, failure.code, failure.type)); return; }
    const { text } = applyStop(answerText(response.text, request), request.stop);
    res.json({
      id: `chatcmpl-${randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop", logprobs: null }],
      usage: usageOf(response)
    });
  }

  private async stream(res: Response, request: TranslatedRequest, target: Target, model: string, key: InferenceKeyInfo, signal: AbortSignal): Promise<void> {
    const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000);
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (value: unknown) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(value)}\n\n`); };
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] });
    chunk({ role: "assistant", content: "" });
    const keepalive = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, KEEPALIVE_MS);
    // What has been sent: never a reasoning block, never past a stop sequence, and nothing that could
    // still turn out to be the start of one.
    let raw = "", sent = "", stopped = false;
    const holdBack = Math.max(0, ...request.stop.map((item) => item.length - 1));
    const emit = (final: boolean) => {
      if (stopped) return;
      const cut = applyStop(withoutThinking(raw), request.stop);
      stopped = cut.stopped;
      const ready = cut.stopped || final ? cut.text : cut.text.slice(0, Math.max(0, cut.text.length - holdBack));
      if (ready.length > sent.length && ready.startsWith(sent)) { chunk({ content: ready.slice(sent.length) }); sent = ready; }
    };
    try {
      const streams = !request.responseFormat;
      const response = await this.generate(request, target, key, signal, streams ? (delta) => { raw += delta; emit(false); } : undefined);
      if (signal.aborted) return;
      const failure = this.failure(response, request);
      if (failure) { send(openAiError(failure.message, failure.code, failure.type)); return; }
      // The finished answer is the reference: what was not streamed (a cloud model, JSON) comes now.
      if (!stopped) { raw = answerText(response.text, request); emit(true); }
      chunk({}, "stop");
      if (request.includeUsage) send({ id, object: "chat.completion.chunk", created, model, choices: [], usage: usageOf(response) });
    } catch (error) {
      if (!signal.aborted) send(openAiError(maskKeyShapes(error instanceof Error ? error.message : String(error)), "internal_error", "server_error"));
    } finally {
      clearInterval(keepalive);
      if (!res.writableEnded) { res.write("data: [DONE]\n\n"); res.end(); }
    }
  }

  private async generate(request: TranslatedRequest, target: Target, key: InferenceKeyInfo, signal: AbortSignal, onTextDelta?: (delta: string) => void): Promise<LLMResponse> {
    const runtime = this.deps.runtimeManager.getRuntime();
    const { responseFormat, systemPrompt } = this.format(request, target.providerId);
    const llmRequest: LLMRequest = {
      usagePurpose: "api",
      prompt: request.prompt,
      ...(systemPrompt ? { systemPrompt } : {}),
      model: target.model,
      ...(request.images.length ? { images: request.images } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
      ...(request.topP !== undefined || request.seed !== undefined || request.temperature !== undefined
        ? { sampling: { ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), ...(request.topP !== undefined ? { topP: request.topP } : {}), ...(request.seed !== undefined ? { seed: request.seed } : {}) } }
        : {}),
      ...(responseFormat ? { responseFormat } : {}),
      holder: `the API (${key.name})`,
      signal,
      ...(onTextDelta ? { onTextDelta } : {})
    };
    return withUsageScope({ origin: "api", purpose: "api", runId: key.id }, () => runtime.llmService.generateText(llmRequest, target.providerId));
  }

  /** A JSON schema the provider cannot enforce becomes JSON mode with the schema in the instructions, or the instructions alone. */
  private format(request: TranslatedRequest, providerId: string): { responseFormat?: LLMResponseFormat; systemPrompt?: string } {
    const format = request.responseFormat;
    if (!format) return { systemPrompt: request.systemPrompt };
    const runtime = this.deps.runtimeManager.getRuntime();
    if (format.type === "json_schema" && runtime.llmService.supportsStructuredOutputs(providerId)) return { responseFormat: format, systemPrompt: request.systemPrompt };
    const jsonMode = runtime.providerDescriptors.find((item) => item.id === providerId)?.capabilities?.jsonMode === true;
    const instruction = format.type === "json_schema"
      ? `Answer with one JSON value that matches this JSON Schema, and nothing else:\n${JSON.stringify(format.schema)}`
      : "Answer with one JSON object and nothing else.";
    return { ...(jsonMode ? { responseFormat: { type: "json_object" as const } } : {}), systemPrompt: [request.systemPrompt, instruction].filter(Boolean).join("\n\n") };
  }

  /** Why a model call gave no answer to return, as an HTTP status and an OpenAI error code. */
  private failure(response: LLMResponse, request: TranslatedRequest): { status: number; code: string; message: string; type?: string } | undefined {
    const message = response.error ? maskKeyShapes(response.error) : undefined;
    if (message) {
      if (/refused the (?:API key|request) \(HTTP \d{3}/.test(message)) return { status: 502, code: "upstream_key_refused", message, type: "upstream_error" };
      if (/disabled or not configured/.test(message)) return { status: 404, code: "model_not_found", message };
      if (/context|too long|exceeds? the|n_ctx/i.test(message)) return { status: 400, code: "context_length_exceeded", message };
      if (/timed out|timeout/i.test(message)) return { status: 504, code: "upstream_timeout", message, type: "upstream_error" };
      return { status: 502, code: "upstream_error", message, type: "upstream_error" };
    }
    if (request.responseFormat && !isJson(answerText(response.text, request))) {
      return { status: 422, code: "invalid_json_output", message: "The model's answer was not valid JSON." };
    }
    return undefined;
  }
}

const usageOf = (response: LLMResponse) => {
  const prompt = response.usage?.inputTokens ?? 0, completion = response.usage?.outputTokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: response.usage?.totalTokens ?? prompt + completion };
};

/** The answer to return: without a reasoning block, and JSON without the code fence a model may put around it. */
const answerText = (text: string, request: TranslatedRequest): string => {
  const answer = withoutThinking(text);
  return request.responseFormat ? answer.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim() : answer;
};

const isJson = (text: string): boolean => {
  try { JSON.parse(text); return true; } catch { return false; }
};
