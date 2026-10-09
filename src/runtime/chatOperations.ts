import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { chatFileGrants } from "../api/workspaceReview";
import type { RuntimeManager } from "../app/RuntimeManager";
import { loadSessionMessages } from "../conversations/sessionHistory";
import { isReasoningEffort } from "../llm/ReasoningEffort";
import { RemoteOperationError, type OperationContext, type RemoteOperation } from "../remote/host/RemoteHost";
import type { SessionIndexStore } from "../session/SessionIndexStore";
import type { ChatMessage, SessionSettings, SessionSettingsPatch } from "../types";
import type { EventJournal } from "./EventJournal";
import { pathScrubber, type Scrubber } from "./orchestrationDto";
import { publicError } from "./publicError";
import { MAX_INPUT_CHARS, RunServiceError, streamOf, type RunService } from "./RunService";
import { CHUNK_CHARS, MAX_CONTENT_CHARS, type UploadStore } from "./uploadStore";
import type { ProjectAccess } from "./projectOperations";

const MAX_HISTORY_BYTES = 768 * 1024;
const MAX_SUBAGENTS = 4, MAX_ADVISORS = 5;
/** A file's text for Review (its answer must fit one 1 MiB frame, escapes included), and bytes per
 * read of a copy being saved. */
const TEXT_LIMIT = 400 * 1024, FILE_CHUNK_BYTES = 512 * 1024, COPY_LIMIT = 100 * 1024 * 1024;
const UNAVAILABLE = "The file is not available to this chat: it was moved or deleted, or this chat did not create or open it.";
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
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
  sessionsCreate: z.object({ title: z.string().max(200).optional(), projectId: z.string().min(1).max(200).optional() }).strict().optional(),
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
  file: z.object({ sessionId: id, path: z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f]/.test(value)) }).strict(),
  fileRead: z.object({ sessionId: id, path: z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f]/.test(value)),
    as: z.enum(["text", "base64"]), offset: z.number().int().min(0).optional(), length: z.number().int().min(1).max(FILE_CHUNK_BYTES).optional() }).strict(),
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
  /** Projects a device may use (R5-4g); without it, project chats stay on the host. */
  projects?: ProjectAccess;
}

/** Replaces the host's folders in a chat's history, approvals and events: a project chat's project
 * folder (`<workspace>`), the chat output folder (`<output>`), the folders file tools may use
 * (`<folder>`) and the host's data (`<server>`). Paths elsewhere stay, so an approval still says
 * exactly what it is for. */
export const createChatScrubber = (deps: { runtimeManager: RuntimeManager; hostDirectories?: string[] }) => async (sessionId?: string) => {
  const filesystem = (await deps.runtimeManager.getSettings()).filesystem;
  const real = (dir: string) => { try { return fs.realpathSync(dir); } catch { return dir; } };
  const both = (dir: string | undefined) => dir ? [...new Set([dir, path.resolve(dir), real(path.resolve(dir))])] : [];
  const runtime = sessionId ? deps.runtimeManager.getRuntime() : undefined;
  const projectId = sessionId ? (await runtime!.sessionIndexStore.get(sessionId))?.projectId : undefined;
  const project = projectId ? await runtime!.projectStore.get(projectId) : undefined;
  return pathScrubber([
    ...both(project?.rootPath).map(dir => [dir, "<workspace>"] as [string, string]),
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

/** A chat a device may read: an ordinary chat, or one in a project whose folder is shared (a
 * project set up on the server keeps its chats there, as if they did not exist). Whether it may
 * also use it is `requireUsable` (full access; an archived or no longer shared project). */
export const requireRemoteSession = async (store: SessionIndexStore, sessionId: string, projects?: ProjectAccess) => {
  const session = await store.get(sessionId);
  if (!session || (session.projectId && !(projects && await projects.visible(session.projectId)))) {
    throw new RemoteOperationError("The chat does not exist on the server.", "session_unknown");
  }
  return session;
};

export const createChatOperations = (deps: ChatOperationDependencies): Record<string, RemoteOperation> => {
  const runtime = () => deps.runtimeManager.getRuntime();
  const requireSession = (sessionId: string) => requireRemoteSession(deps.sessionIndexStore, sessionId, deps.projects);
  const scrubber = createChatScrubber(deps);
  /** Why a device may not use or change a chat, if it may not: the host gave it full access, or
   * it belongs to a project set up on the server (or archived). Checked at every use. */
  const hostOnlyReason = async (sessionId: string): Promise<string | undefined> => {
    const reason = chatHostOnly(await runtime().sessionSettingsStore.get(sessionId));
    if (reason) return reason;
    const projectId = (await deps.sessionIndexStore.get(sessionId))?.projectId;
    if (!projectId) return undefined;
    if (!deps.projects) return "Project chats on this server are used there.";
    return (await deps.projects.usable(projectId)).reason;
  };
  const requireUsable = async (sessionId: string) => {
    const reason = await hostOnlyReason(sessionId);
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
  /** What a chat's file actions reached, kept briefly: a saved copy reads a file in many parts. */
  const grantCache = new Map<string, { at: number; grants: Promise<Awaited<ReturnType<typeof chatFileGrants>>> }>();
  const grantsOf = (sessionId: string) => {
    const cached = grantCache.get(sessionId);
    if (cached && Date.now() - cached.at < 15_000) return cached.grants;
    const grants = chatFileGrants(deps.runtimeManager, sessionId);
    grantCache.set(sessionId, { at: Date.now(), grants });
    if (grantCache.size > 100) grantCache.delete(grantCache.keys().next().value!);
    return grants;
  };
  /** A file a chat's agents wrote or read, as the device saw it in the chat (`<output>/report.md`):
   * its labels are mapped back to this host's folders, and it must be one the chat's grants name.
   * It is opened once, without following a link, and must still be the file that was granted. One
   * answer for a missing file and one that is not the chat's: nothing tells which paths exist. */
  const openChatFile = async (sessionId: string, ref: string) => {
    const [scrub, grants] = await Promise.all([scrubber(sessionId), grantsOf(sessionId)]);
    const label = /^(<[a-z]+>)(?=[\\/]|$)/.exec(ref)?.[1];
    const candidates = label ? scrub.pairs.filter(([, name]) => name === label).map(([dir]) => dir + ref.slice(label.length)) : path.isAbsolute(ref) ? [ref] : [];
    const granted = (file: string) => (grants.workspaceRoot && inside(file, grants.workspaceRoot)) || grants.files.has(file);
    for (const candidate of candidates.map(item => path.resolve(item))) {
      if (!granted(candidate)) continue;
      let real: string;
      try { real = await fsp.realpath(candidate); } catch { continue; }
      if (!granted(real)) continue;
      let handle: fsp.FileHandle;
      try { handle = await fsp.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { continue; }
      try {
        const [stat, now] = await Promise.all([handle.stat(), fsp.stat(await fsp.realpath(real))]);
        if (stat.dev !== now.dev || stat.ino !== now.ino) { await handle.close(); continue; }
        if (!stat.isFile()) { await handle.close(); throw new RemoteOperationError("This is a folder, not a file.", "invalid_request"); }
        return { handle, stat, path: scrub(real), name: path.basename(real) };
      } catch (error) { await handle.close().catch(() => undefined); throw error; }
    }
    throw new RemoteOperationError(UNAVAILABLE, "file_unavailable");
  };
  const fileOperations: Record<string, RemoteOperation> = {
    /** Size, time and hash of a chat's file, so a saved copy can be checked. */
    "files.stat": async payload => {
      const { sessionId, path: ref } = parse(schemas.file, payload);
      await requireSession(sessionId);
      // A chat with full access may have touched any file of the host: its files stay there.
      await requireUsable(sessionId);
      const { handle, stat, path: shown, name } = await openChatFile(sessionId, ref);
      try {
        if (stat.size > COPY_LIMIT) throw new RemoteOperationError("The file is larger than 100 MB.", "too_large");
        // Through the opened file and up to its size: a file swapped meanwhile is not followed.
        const hash = createHash("sha256"), buffer = Buffer.alloc(FILE_CHUNK_BYTES);
        for (let offset = 0; offset < stat.size;) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
          if (!bytesRead) break;
          hash.update(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
        return { path: shown, name, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), sha256: hash.digest("hex") };
      } finally { await handle.close(); }
    },
    /** A chat's file as text for Review (5 MB, no binary), or a part of it for a saved copy. */
    "files.read": async payload => {
      const { sessionId, path: ref, as, offset = 0, length = FILE_CHUNK_BYTES } = parse(schemas.fileRead, payload);
      await requireSession(sessionId);
      await requireUsable(sessionId);
      const { handle, stat, path: shown, name } = await openChatFile(sessionId, ref);
      try {
        if (as === "text") {
          const tooLarge = () => new RemoteOperationError("Review shows files up to 400 KB from a server. Save a copy to open this one.", "too_large");
          if (stat.size > TEXT_LIMIT) throw tooLarge();
          const { buffer, bytesRead } = await handle.read(Buffer.alloc(TEXT_LIMIT + 1), 0, TEXT_LIMIT + 1, 0);
          if (bytesRead > TEXT_LIMIT) throw tooLarge();
          const bytes = buffer.subarray(0, bytesRead);
          if (bytes.includes(0)) throw new RemoteOperationError("Review shows text files. Save a copy to open this one.", "binary_file");
          return { path: shown, name, sizeBytes: bytesRead, content: bytes.toString("utf8"), version: createHash("sha256").update(bytes).digest("hex") };
        }
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, offset);
        return { path: shown, name, sizeBytes: stat.size, offset, data: buffer.subarray(0, bytesRead).toString("base64"), eof: offset + bytesRead >= stat.size };
      } finally { await handle.close(); }
    }
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
    // Chats of projects a device may see are listed where the server offers projects (R5-4g). A
    // title is the start of a message, which may name a folder of the host (or of its project).
    "sessions.list": async () => {
      const sessions = await deps.sessionIndexStore.list();
      const visible = new Map<string, boolean>(), scrubs = new Map<string, Scrubber>();
      const listed = [];
      for (const session of sessions) {
        const key = session.projectId ?? "";
        if (key && !visible.has(key)) visible.set(key, Boolean(deps.projects && await deps.projects.visible(key)));
        if (key && !visible.get(key)) continue;
        if (!scrubs.has(key)) scrubs.set(key, await scrubber(key ? session.id : undefined));
        listed.push(scrubs.get(key)!({ id: session.id, title: session.title, updatedAt: session.updatedAt, ...(session.projectId ? { projectId: session.projectId } : {}),
          ...(deps.runService.activeRun(session.id) ? { activeRunId: deps.runService.activeRun(session.id)!.runId } : {}) }));
      }
      return listed;
    },

    "sessions.create": async payload => {
      const { title, projectId } = parse(schemas.sessionsCreate, payload) ?? {};
      if (projectId) {
        if (!deps.projects) throw new RemoteOperationError("Project chats on this server are used there.", "unsupported");
        const { reason } = await deps.projects.usable(projectId);
        if (reason) throw new RemoteOperationError(reason, "unsupported");
      }
      const session = await deps.sessionIndexStore.create(title, "http", projectId);
      const defaults = (await deps.runtimeManager.getSettings()).ui;
      if (defaults) await runtime().sessionSettingsStore.update(session.id, { language: defaults.language, outputStyle: defaults.outputStyle, mode: defaults.mode });
      return { id: session.id, title: session.title, updatedAt: session.updatedAt, ...(session.projectId ? { projectId: session.projectId } : {}) };
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
      const scrub = await scrubber(sessionId);
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
        deps.uploads?.dropSession(sessionId);
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
      const hostOnly = await hostOnlyReason(sessionId);
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
      const reason = await hostOnlyReason(sessionId);
      if (reason) throw new RemoteOperationError(reason, "unsupported");
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
    ...fileOperations,

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
