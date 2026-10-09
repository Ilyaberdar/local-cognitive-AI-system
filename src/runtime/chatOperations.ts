import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RuntimeManager } from "../app/RuntimeManager";
import { loadSessionMessages } from "../conversations/sessionHistory";
import { isReasoningEffort } from "../llm/ReasoningEffort";
import { RemoteOperationError, type OperationContext, type RemoteOperation } from "../remote/host/RemoteHost";
import type { SessionIndexStore } from "../session/SessionIndexStore";
import type { ChatMessage, SessionSettings, SessionSettingsPatch } from "../types";
import type { EventJournal } from "./EventJournal";
import { pathScrubber } from "./orchestrationDto";
import { publicError } from "./publicError";
import { MAX_INPUT_CHARS, RunServiceError, streamOf, type RunService } from "./RunService";
import { CHUNK_CHARS, MAX_CONTENT_CHARS, type UploadStore } from "./uploadStore";

const MAX_HISTORY_BYTES = 768 * 1024;
const MAX_SUBAGENTS = 4, MAX_ADVISORS = 5;
/** Work the host set up with full access stays there: a device may stop, decline or delete it. */
export const CHAT_ON_HOST = "This chat has full access on the server, so it can only be used or changed there.";
const FULL_FROM_DEVICE = "Full access can only be given on the server itself.";
const id = z.string().min(1).max(200);
const uuid = z.uuid();
const target = z.object({ providerId: z.string().min(1).max(100), model: z.string().max(300).optional() }).strict();
const agentFields = { id: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(60).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  providerId: z.string().min(1).max(100), model: z.string().max(300).optional() };
// An agent's id names its task and progress row; its name is how a message @mentions it.
const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/, AGENT_NAME = /^[\p{L}\p{N}_-]{1,60}$/u;
const schemas = {
  sessionsCreate: z.object({ title: z.string().max(200).optional() }).strict().optional(),
  session: z.object({ sessionId: id }).strict(),
  rename: z.object({ sessionId: id, title: z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value)) }).strict(),
  settingsUpdate: z.object({ sessionId: id, patch: z.object({
    defaultTarget: target.optional(),
    mode: z.enum(["auto", "general", "code", "hypothesis"]).optional(),
    reasoningEffort: z.string().refine(isReasoningEffort).optional(),
    language: z.enum(["auto", "ru", "en"]).optional(),
    outputStyle: z.enum(["compact", "balanced", "detailed", "exhaustive"]).optional(),
    // "full" is refused before the schema, with the reason.
    defaultAccessMode: z.enum(["ask", "default"]).optional(),
    // Agents run with the chat's access mode: a per-agent mode is not taken from a device.
    codeAgents: z.array(z.object(agentFields).strict()).max(MAX_SUBAGENTS).optional(),
    hypothesisAgents: z.array(z.object({ ...agentFields, role: z.enum(["support", "attack", "judge", "advisor"]) }).strict()).max(3 + MAX_ADVISORS).optional(),
    // Whether the chat debates follows its type (`mode`), as on this computer.
    debate: z.object({ profile: z.enum(["general", "technical", "product", "research", "security"]).optional(),
      support: target.optional(), attack: target.optional(), judge: target.optional() }).strict().optional()
  }).strict() }).strict(),
  start: z.object({ commandId: z.string().min(8).max(100), sessionId: id, input: z.string().min(1).max(MAX_INPUT_CHARS),
    attachmentIds: z.array(uuid).max(5).optional() }).strict(),
  uploadBegin: z.object({ uploadId: uuid, sessionId: id, name: z.string().trim().min(1).max(255).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
    mimeType: z.string().regex(/^[\w.+-]{1,100}\/[\w.+-]{1,100}$/), kind: z.enum(["image", "text"]), sizeBytes: z.number().int().min(0).max(5 * 1024 ** 2),
    length: z.number().int().min(1).max(MAX_CONTENT_CHARS), sha256: z.string().regex(/^[a-f0-9]{64}$/i), truncated: z.boolean().optional(),
    warning: z.string().max(1000).optional() }).strict(),
  uploadChunk: z.object({ uploadId: uuid, index: z.number().int().min(0), data: z.string().min(1).max(CHUNK_CHARS) }).strict(),
  upload: z.object({ uploadId: uuid }).strict(),
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
export const withoutAttachmentData = (message: ChatMessage): ChatMessage => message.attachments?.length
  ? { ...message, attachments: message.attachments.map(({ dataUrl: _dataUrl, textContent: _textContent, ...rest }) => rest) }
  : message;

export interface ChatOperationDependencies {
  runtimeManager: RuntimeManager;
  sessionIndexStore: SessionIndexStore;
  runService: RunService;
  journal: EventJournal;
  /** Idempotency scope of a caller: commands from different devices never collide. */
  scopeOf(context: OperationContext): string;
  /** Folders of the host named `<server>` in what a device receives (its data directory). */
  hostDirectories?: string[];
  /** Attachments devices send for their next turn; without it, chats take text only. */
  uploads?: UploadStore;
}

/** Replaces the host's folders in a chat's history, approvals and events: the chat output folder
 * (`<output>`), the folders file tools may use (`<folder>`) and the host's data (`<server>`). Paths
 * elsewhere stay, so an approval still says exactly what it is for. */
export const createChatScrubber = (deps: { runtimeManager: RuntimeManager; hostDirectories?: string[] }) => async () => {
  const filesystem = (await deps.runtimeManager.getSettings()).filesystem;
  const real = (dir: string) => { try { return fs.realpathSync(dir); } catch { return dir; } };
  const both = (dir: string | undefined) => dir ? [...new Set([dir, path.resolve(dir), real(path.resolve(dir))])] : [];
  return pathScrubber([
    ...both(filesystem?.outputDir).map(dir => [dir, "<output>"] as [string, string]),
    ...(filesystem?.allowedDirectories ?? []).flatMap(both).map(dir => [dir, "<folder>"] as [string, string]),
    ...(deps.hostDirectories ?? []).flatMap(both).map(dir => [dir, "<server>"] as [string, string])
  ]);
};

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
  const scrubber = createChatScrubber(deps);
  /** Refuses using or changing a chat the host gave full access, checked at every use. */
  const requireUsable = async (sessionId: string) => {
    const reason = chatHostOnly(await runtime().sessionSettingsStore.get(sessionId));
    if (reason) throw new RemoteOperationError(reason, "unsupported");
  };
  /** Every model an agent names must be one of the host's providers ("local" only judges); ids and
   * names must be usable and unique. Agents saved as they are on the host are taken as they are. */
  const checkAgents = (patch: z.infer<typeof schemas.settingsUpdate>["patch"], current: SessionSettings) => {
    const known = new Set(runtime().providerDescriptors.map(provider => provider.id));
    const same = (agent: { id: string; name: string; providerId: string; model?: string }, saved: Array<{ id: string; name: string; providerId: string; model?: string }>) =>
      saved.some(item => item.id === agent.id && item.name === agent.name && item.providerId === agent.providerId && (item.model ?? "") === (agent.model ?? ""));
    const codeAgents = (patch.codeAgents ?? []).filter(agent => !same(agent, current.codeAgents));
    const hypothesisAgents = (patch.hypothesisAgents ?? []).filter(agent => !same(agent, current.hypothesisAgents));
    for (const list of [patch.codeAgents ?? [], patch.hypothesisAgents ?? []]) {
      if (new Set(list.map(agent => agent.id)).size < list.length) throw new RemoteOperationError("Two agents have the same id.", "invalid_request");
      if (new Set(list.map(agent => agent.name.toLowerCase())).size < list.length) throw new RemoteOperationError("Two agents have the same name.", "invalid_request");
    }
    for (const agent of [...codeAgents, ...hypothesisAgents]) {
      if (!AGENT_ID.test(agent.id) || agent.id === "main-model") throw new RemoteOperationError("An agent's id is letters, digits, - or _.", "invalid_request");
      if (!AGENT_NAME.test(agent.name)) throw new RemoteOperationError(`Name ${publicError(agent.name)} cannot be @mentioned: use one word of letters, digits, - or _.`, "invalid_request");
    }
    const judges = [...hypothesisAgents.filter(agent => agent.role === "judge"), ...(patch.debate?.judge ? [patch.debate.judge] : [])];
    const others = [patch.defaultTarget, ...codeAgents, ...hypothesisAgents.filter(agent => agent.role !== "judge"),
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
  /** Attachments for a device's next turn (R5-4d): begun for a chat the device may use, sent in
   * chunks, then checked and validated as a whole. Requests, not commands: chunks never enter the
   * command ledger, and an upload id makes each step safe to repeat. */
  const uploadOperations = (uploads: UploadStore): Record<string, RemoteOperation> => ({
    "uploads.begin": async (payload, context) => {
      const { uploadId, sessionId, ...meta } = parse(schemas.uploadBegin, payload);
      await requireSession(sessionId);
      await requireUsable(sessionId);
      return uploads.begin(deps.scopeOf(context), uploadId, sessionId, meta);
    },
    "uploads.chunk": async (payload, context) => {
      const { uploadId, index, data } = parse(schemas.uploadChunk, payload);
      return uploads.chunk(deps.scopeOf(context), uploadId, index, data);
    },
    "uploads.commit": async (payload, context) => uploads.commit(deps.scopeOf(context), parse(schemas.upload, payload).uploadId),
    "uploads.cancel": async (payload, context) => uploads.cancel(deps.scopeOf(context), parse(schemas.upload, payload).uploadId)
  });

  return {
    // A title is the start of a message, which may name a folder of the host.
    "sessions.list": async () => (await scrubber())((await deps.sessionIndexStore.list()).filter(session => !session.projectId).map(session => ({
      id: session.id, title: session.title, updatedAt: session.updatedAt, ...(deps.runService.activeRun(session.id) ? { activeRunId: deps.runService.activeRun(session.id)!.runId } : {})
    }))),

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
      const scrub = await scrubber();
      let merged = scrub([...messages, ...unfinished].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(withoutAttachmentData));
      while (merged.length > 2 && JSON.stringify(merged).length > MAX_HISTORY_BYTES) merged = merged.slice(2);
      return { messages: merged, ...(activeRun ? { activeRun: scrub(activeRun) } : {}), cursor: { streamId, epoch, after: head } };
    },

    "sessions.rename": async payload => {
      const { sessionId, title } = parse(schemas.rename, payload);
      await requireSession(sessionId);
      await requireUsable(sessionId);
      const session = await deps.sessionIndexStore.rename(sessionId, title);
      if (!session) throw new RemoteOperationError("The chat does not exist on the server.", "session_unknown");
      return { id: session.id, title: session.title, updatedAt: session.updatedAt };
    },

    /** Deletes a chat with its settings, memory, turns and events; allowed for a chat that is the
     * host's alone too (a device may always delete), refused while it answers. */
    "sessions.delete": payload => known(async () => {
      const { sessionId } = parse(schemas.session, payload);
      await requireSession(sessionId);
      // Turns are refused from here on; the index goes last, so a failed step can be retried.
      deps.runService.forgetSession(sessionId);
      let deleted = false;
      try {
        const current = runtime();
        await current.sessionSettingsStore.delete(sessionId);
        await current.memoryService.deleteSession(sessionId);
        if (!await deps.sessionIndexStore.delete(sessionId)) throw new RemoteOperationError("The chat does not exist on the server.", "session_unknown");
        deleted = true;
      } finally { deps.runService.forgotSession(sessionId, deleted); }
      return { deleted: true };
    }),

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
      const raw = (payload as { patch?: Record<string, unknown> } | undefined)?.patch;
      if (raw && typeof raw === "object" && (raw.defaultAccessMode === "full" || (Array.isArray(raw.codeAgents) && raw.codeAgents.some(agent => agent?.accessMode === "full")))) {
        throw new RemoteOperationError(FULL_FROM_DEVICE, "unsupported");
      }
      const { sessionId, patch } = parse(schemas.settingsUpdate, payload);
      await requireSession(sessionId);
      const current = await runtime().sessionSettingsStore.get(sessionId);
      if (chatHostOnly(current)) throw new RemoteOperationError(CHAT_ON_HOST, "unsupported");
      checkAgents(patch, current);
      // The chat type is mode plus debate, as the local chat screen saves it.
      const debate = patch.mode || patch.debate ? { debate: { ...patch.debate, ...(patch.mode ? { enabled: patch.mode === "hypothesis" } : {}) } } : {};
      // Agents take the chat's access mode, which a device cannot make full.
      const mode = patch.defaultAccessMode ?? current.defaultAccessMode;
      const agents = patch.codeAgents ?? (patch.defaultAccessMode ? current.codeAgents : undefined);
      const codeAgents = agents ? { codeAgents: agents.map(agent => ({ ...agent, accessMode: mode })) } : {};
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
      const owner = deps.scopeOf(context), ids = request.attachmentIds ?? [];
      if (ids.length && !deps.uploads) throw new RemoteOperationError("This server takes text messages only.", "unsupported");
      // Checked after a resent command got its first answer, and again by the engine when it runs.
      const ack = await deps.runService.start(owner, request, async () => {
        await requireUsable(request.sessionId);
        return { attachments: ids.length ? deps.uploads!.attachments(owner, request.sessionId, ids) : [] };
      });
      if (ack.status === "accepted" && !ack.replayed && ids.length) deps.uploads!.remove(ids);
      return ack;
    }),

    ...(deps.uploads ? uploadOperations(deps.uploads) : {}),

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
