import { z } from "zod";
import type { RuntimeManager } from "../app/RuntimeManager";
import { loadSessionMessages } from "../conversations/sessionHistory";
import { isReasoningEffort } from "../llm/ReasoningEffort";
import { RemoteOperationError, type OperationContext, type RemoteOperation } from "../remote/host/RemoteHost";
import type { SessionIndexStore } from "../session/SessionIndexStore";
import type { ChatMessage, SessionSettings, SessionSettingsPatch } from "../types";
import type { EventJournal } from "./EventJournal";
import { publicError } from "./publicError";
import { MAX_INPUT_CHARS, RunServiceError, streamOf, type RunService } from "./RunService";

const MAX_HISTORY_BYTES = 768 * 1024;
const MAX_SUBAGENTS = 4, MAX_ADVISORS = 5;
/** Work the host set up with full access stays there: a device may stop, decline or delete it. */
export const CHAT_ON_HOST = "This chat has full access on the server, so it can only be used or changed there.";
const id = z.string().min(1).max(200);
const uuid = z.uuid();
const target = z.object({ providerId: z.string().min(1).max(100), model: z.string().max(300).optional() }).strict();
const agentFields = { id: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(60).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  providerId: z.string().min(1).max(100), model: z.string().max(300).optional() };
const schemas = {
  sessionsCreate: z.object({ title: z.string().max(200).optional() }).strict().optional(),
  session: z.object({ sessionId: id }).strict(),
  settingsUpdate: z.object({ sessionId: id, patch: z.object({
    defaultTarget: target.optional(),
    mode: z.enum(["auto", "general", "code", "hypothesis"]).optional(),
    reasoningEffort: z.string().refine(isReasoningEffort).optional(),
    language: z.enum(["auto", "ru", "en"]).optional(),
    outputStyle: z.enum(["compact", "balanced", "detailed", "exhaustive"]).optional(),
    // Agents run with the chat's access mode: a per-agent mode is not taken from a device.
    codeAgents: z.array(z.object(agentFields).strict()).max(MAX_SUBAGENTS).optional(),
    hypothesisAgents: z.array(z.object({ ...agentFields, role: z.enum(["support", "attack", "judge", "advisor"]) }).strict()).max(3 + MAX_ADVISORS).optional(),
    // Whether the chat debates follows its type (`mode`), as on this computer.
    debate: z.object({ profile: z.enum(["general", "technical", "product", "research", "security"]).optional(),
      support: target.optional(), attack: target.optional(), judge: target.optional() }).strict().optional()
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
/** Why a chat can be used only on the host, if it can: full access skips every approval. */
export const chatHostOnly = (settings: Pick<SessionSettings, "defaultAccessMode" | "codeAgents">): string | undefined =>
  settings.defaultAccessMode === "full" || settings.codeAgents?.some(agent => agent.accessMode === "full") ? CHAT_ON_HOST : undefined;

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
  /** Refuses using or changing a chat the host gave full access, checked at every use. */
  const requireUsable = async (sessionId: string) => {
    const reason = chatHostOnly(await runtime().sessionSettingsStore.get(sessionId));
    if (reason) throw new RemoteOperationError(reason, "unsupported");
  };
  /** Every model an agent names must be one of the host's providers ("local" only judges). */
  const checkProviders = (patch: z.infer<typeof schemas.settingsUpdate>["patch"]) => {
    const known = new Set(runtime().providerDescriptors.map(provider => provider.id));
    const judges = [...(patch.hypothesisAgents ?? []).filter(agent => agent.role === "judge"), ...(patch.debate?.judge ? [patch.debate.judge] : [])];
    const others = [patch.defaultTarget, ...(patch.codeAgents ?? []), ...(patch.hypothesisAgents ?? []).filter(agent => agent.role !== "judge"),
      patch.debate?.support, patch.debate?.attack].filter(item => item !== undefined);
    for (const item of [...judges.filter(judge => judge.providerId !== "local"), ...others]) {
      if (!known.has(item.providerId)) throw new RemoteOperationError(`The provider ${publicError(item.providerId)} does not exist on the server.`, "invalid_request");
    }
    const roles = patch.hypothesisAgents?.map(agent => agent.role) ?? [];
    for (const role of ["support", "attack", "judge"] as const) {
      if (roles.filter(item => item === role).length > 1) throw new RemoteOperationError(`A debate has one ${role} agent.`, "invalid_request");
    }
    if (roles.filter(role => role === "advisor").length > MAX_ADVISORS) throw new RemoteOperationError(`A debate has at most ${MAX_ADVISORS} advisors.`, "invalid_request");
  };
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

    /** The chat's setup as a device may change it (R5-4): its settings, the access modes a device
     * may choose, why the chat is the host's alone (if it is), and the agent limits. */
    "sessions.setup.get": async payload => {
      const { sessionId } = parse(schemas.session, payload);
      await requireSession(sessionId);
      const settings = await runtime().sessionSettingsStore.get(sessionId);
      const hostOnly = chatHostOnly(settings);
      return { settings, access: { modes: ["ask", "default"], ...(hostOnly ? { hostOnly } : {}) }, limits: { subagents: MAX_SUBAGENTS, advisors: MAX_ADVISORS } };
    },

    "sessions.settings.update": async payload => {
      const { sessionId, patch } = parse(schemas.settingsUpdate, payload);
      await requireSession(sessionId);
      checkProviders(patch);
      const current = await runtime().sessionSettingsStore.get(sessionId);
      if (chatHostOnly(current)) throw new RemoteOperationError(CHAT_ON_HOST, "unsupported");
      // The chat type is mode plus debate, as the local chat screen saves it.
      const debate = patch.mode || patch.debate ? { debate: { ...patch.debate, ...(patch.mode ? { enabled: patch.mode === "hypothesis" } : {}) } } : {};
      // Agents take the chat's access mode, which a device cannot make full.
      const codeAgents = patch.codeAgents ? { codeAgents: patch.codeAgents.map(agent => ({ ...agent, accessMode: current.defaultAccessMode })) } : {};
      return runtime().sessionSettingsStore.update(sessionId, { ...patch, ...debate, ...codeAgents } as SessionSettingsPatch);
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
      await requireUsable(request.sessionId);
      return deps.runService.start(deps.scopeOf(context), request);
    }),

    "chat.runs.get": payload => known(() => {
      const run = deps.runService.get(parse(schemas.run, payload).runId);
      if (!run) throw new RemoteOperationError("The run does not exist on the server.", "run_unknown");
      return run;
    }),

    "chat.runs.cancel": payload => known(() => deps.runService.cancel(parse(schemas.run, payload).runId)),

    "chat.approvals.resolve": payload => known(async () => {
      const { runId, approvalId, approved } = parse(schemas.approval, payload);
      // Declining is always allowed; approving only in a chat a device may use.
      const run = approved ? deps.runService.get(runId) : undefined;
      if (run) await requireUsable(run.sessionId);
      return deps.runService.resolveApproval(runId, approvalId, approved);
    }),
  };
};
