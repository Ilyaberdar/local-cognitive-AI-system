import { z } from "zod";
import type { RuntimeManager } from "../app/RuntimeManager";
import { loadSessionMessages } from "../conversations/sessionHistory";
import { isReasoningEffort } from "../llm/ReasoningEffort";
import { RemoteOperationError, type OperationContext, type RemoteOperation } from "../remote/host/RemoteHost";
import type { SessionIndexStore } from "../session/SessionIndexStore";
import type { ChatMessage, SessionSettingsPatch } from "../types";
import type { EventJournal } from "./EventJournal";
import { publicError } from "./publicError";
import { MAX_INPUT_CHARS, RunServiceError, streamOf, type RunService } from "./RunService";

const MAX_HISTORY_BYTES = 768 * 1024;
const id = z.string().min(1).max(200);
const uuid = z.uuid();
const schemas = {
  sessionsCreate: z.object({ title: z.string().max(200).optional() }).strict().optional(),
  session: z.object({ sessionId: id }).strict(),
  settingsUpdate: z.object({ sessionId: id, patch: z.object({
    defaultTarget: z.object({ providerId: z.string().min(1).max(100), model: z.string().max(300).optional() }).strict().optional(),
    mode: z.enum(["auto", "general", "code", "hypothesis"]).optional(),
    reasoningEffort: z.string().refine(isReasoningEffort).optional(),
    language: z.enum(["auto", "ru", "en"]).optional(),
    outputStyle: z.enum(["compact", "balanced", "detailed", "exhaustive"]).optional()
  }).strict() }).strict(),
  start: z.object({ commandId: z.string().min(8).max(100), sessionId: id, input: z.string().min(1).max(MAX_INPUT_CHARS) }).strict(),
  run: z.object({ runId: uuid }).strict(),
  approval: z.object({ runId: uuid, approvalId: uuid, approved: z.boolean() }).strict()
};

const parse = <T>(schema: z.ZodType<T>, payload: unknown): T => {
  const result = schema.safeParse(payload);
  if (!result.success) throw new RemoteOperationError("The request is not valid.", "invalid_request");
  return result.data;
};
/** Run service refusals keep their code; anything else is reported generically by the dispatcher. */
const known = <T>(task: () => Promise<T> | T): Promise<T> => Promise.resolve().then(task).catch((error: unknown) => {
  if (error instanceof RunServiceError) throw new RemoteOperationError(error.message, error.code);
  throw error;
});
/** Attachments stay on the host: history carries their names and sizes, not their contents. */
const withoutData = (message: ChatMessage): ChatMessage => message.attachments?.length
  ? { ...message, attachments: message.attachments.map(({ dataUrl: _dataUrl, textContent: _textContent, ...rest }) => rest) }
  : message;

export interface ChatOperationDependencies {
  runtimeManager: RuntimeManager;
  sessionIndexStore: SessionIndexStore;
  runService: RunService;
  journal: EventJournal;
  /** Idempotency scope of a caller: commands from different devices never collide. */
  scopeOf(context: OperationContext): string;
}

/** Chat on the host for a remote device (R4): text turns in ordinary chats, with durable runs,
 * history and an event journal the device polls. Project chats and attachments come in R5. */
/** A chat a device may use: it exists and is not a project chat (R4). */
export const requireRemoteSession = async (store: SessionIndexStore, sessionId: string) => {
  const session = await store.get(sessionId);
  if (!session) throw new RemoteOperationError("The chat does not exist on the server.", "session_unknown");
  if (session.projectId) throw new RemoteOperationError("Project chats are not available remotely yet.", "unsupported");
  return session;
};

export const createChatOperations = (deps: ChatOperationDependencies): Record<string, RemoteOperation> => {
  const runtime = () => deps.runtimeManager.getRuntime();
  const requireSession = (sessionId: string) => requireRemoteSession(deps.sessionIndexStore, sessionId);
  return {
    "sessions.list": async () => (await deps.sessionIndexStore.list()).filter(session => !session.projectId).map(session => ({
      id: session.id, title: session.title, updatedAt: session.updatedAt, ...(deps.runService.activeRun(session.id) ? { activeRunId: deps.runService.activeRun(session.id)!.runId } : {})
    })),

    "sessions.create": async payload => {
      const { title } = parse(schemas.sessionsCreate, payload) ?? {};
      const session = await deps.sessionIndexStore.create(title, "http");
      const defaults = (await deps.runtimeManager.getSettings()).ui;
      if (defaults) await runtime().sessionSettingsStore.update(session.id, { language: defaults.language, outputStyle: defaults.outputStyle, mode: defaults.mode });
      return { id: session.id, title: session.title, updatedAt: session.updatedAt };
    },

    /** A snapshot plus the cursor to follow it: the async history read happens first, so events
     * after the cursor are exactly what the snapshot does not contain. */
    "sessions.messages.list": async payload => {
      const { sessionId } = parse(schemas.session, payload);
      await requireSession(sessionId);
      const { messages } = await loadSessionMessages(deps.runtimeManager, sessionId);
      const unfinished = deps.runService.unfinishedTurns(sessionId);
      const activeRun = deps.runService.activeRun(sessionId);
      const streamId = streamOf(sessionId), { epoch, head } = deps.journal.head(streamId);
      let merged = [...messages, ...unfinished].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(withoutData);
      while (merged.length > 2 && JSON.stringify(merged).length > MAX_HISTORY_BYTES) merged = merged.slice(2);
      return { messages: merged, ...(activeRun ? { activeRun } : {}), cursor: { streamId, epoch, after: head } };
    },

    "sessions.settings.get": async payload => {
      const { sessionId } = parse(schemas.session, payload);
      await requireSession(sessionId);
      return runtime().sessionSettingsStore.get(sessionId);
    },

    "sessions.settings.update": async payload => {
      const { sessionId, patch } = parse(schemas.settingsUpdate, payload);
      await requireSession(sessionId);
      // The chat type is mode plus debate, as the local chat screen saves it.
      const debate = patch.mode ? { debate: { enabled: patch.mode === "hypothesis" } } : {};
      return runtime().sessionSettingsStore.update(sessionId, { ...patch, ...debate } as SessionSettingsPatch);
    },

    "models.available": async () => {
      const current = runtime();
      const [availableModels, loadedModels, allManagedModels, settings] = await Promise.all([current.modelCatalog.listAll(),
        current.localModelManager.listLoadedModels(), current.localModelManager.listAllModels(), deps.runtimeManager.getSettings()]);
      // Only the default model per provider: provider settings also hold API keys.
      const appSettings = { llm: { defaultProvider: settings.llm.defaultProvider },
        providers: Object.fromEntries(Object.entries(settings.providers).map(([providerId, provider]) => [providerId, { model: (provider as { model?: string }).model }])) };
      // A model's load error can hold the runtime's log with server paths: devices get its summary.
      const safe = <T extends object>(model: T): T => {
        const error = (model as { error?: unknown }).error;
        return typeof error === "string" && error ? { ...model, error: publicError(error) } : model;
      };
      return { providers: current.providerDescriptors, availableModels, loadedModels: loadedModels.map(safe), allManagedModels: allManagedModels.map(safe), appSettings };
    },

    "chat.runs.start": (payload, context) => known(async () => {
      const request = parse(schemas.start, payload);
      await requireSession(request.sessionId);
      return deps.runService.start(deps.scopeOf(context), request);
    }),

    "chat.runs.get": payload => known(() => {
      const run = deps.runService.get(parse(schemas.run, payload).runId);
      if (!run) throw new RemoteOperationError("The run does not exist on the server.", "run_unknown");
      return run;
    }),

    "chat.runs.cancel": payload => known(() => deps.runService.cancel(parse(schemas.run, payload).runId)),

    "chat.approvals.resolve": payload => known(() => {
      const { runId, approvalId, approved } = parse(schemas.approval, payload);
      return deps.runService.resolveApproval(runId, approvalId, approved);
    }),
  };
};
