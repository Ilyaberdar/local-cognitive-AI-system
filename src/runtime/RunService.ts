import { randomUUID } from "crypto";
import type { ApprovalOperation, ChatMessage, ProcessProgressEvent } from "../types";
import type { Logger } from "../utils/Logger";
import { canonical, sha256 } from "./canonical";
import type { HostDatabase } from "./db/HostDatabase";
import type { EventJournal, JournalEvent } from "./EventJournal";
import { publicError } from "./publicError";

export type RunStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | "interrupted" | "needs_review";
const ACTIVE: RunStatus[] = ["queued", "running", "waiting_approval"];
export const MAX_INPUT_CHARS = 64 * 1024;
const FLUSH_MS = 300;

export class RunServiceError extends Error { constructor(message: string, readonly code: string) { super(message); } }

/** The answer to `chat.runs.start` (spec §7.2): written before it is returned, replayed for the same key. */
export interface CommandAck { commandId: string; status: "accepted" | "rejected"; runId?: string; userMessageId?: string; assistantMessageId?: string;
  code?: string; activeRunId?: string; replayed?: boolean }
export interface RunView { runId: string; sessionId: string; status: RunStatus; error?: string; assistantMessageId?: string; createdAt: string; updatedAt: string }
export interface ActiveRunView extends RunView { partialText: string; progress?: Omit<ProcessProgressEvent, "answer">; pendingApproval?: PendingApprovalView }
export interface PendingApprovalView extends ApprovalOperation { approvalId: string; digest: string; requestedAt: string }

export interface ExecuteHooks { signal: AbortSignal; onProgress: (event: ProcessProgressEvent) => void; requestApproval: (operation: ApprovalOperation) => Promise<boolean> }
export interface RunServiceDependencies {
  host: HostDatabase;
  journal: EventJournal;
  /** Runs one chat turn with the shared engine; resolves with the engine's error text, if any. */
  execute(run: { runId: string; sessionId: string; input: string }, hooks: ExecuteHooks): Promise<{ error?: string }>;
  /** The completed turn as history shows it (from memory), for `message.completed`. */
  completedTurn?(sessionId: string, runId: string): Promise<ChatMessage[] | undefined>;
  sessionExists(sessionId: string): Promise<boolean>;
  /** A legacy /chat request already running on the session. */
  legacyBusy?(sessionId: string): boolean;
  logger?: Logger;
  now?: () => Date;
}

interface ActiveRun {
  runId: string; sessionId: string; assistantMessageId: string; controller: AbortController;
  text: string; pendingText?: { offset: number; text: string; replace?: boolean }; progress?: Omit<ProcessProgressEvent, "answer">; progressDirty: boolean;
  timer?: NodeJS.Timeout; approval?: { view: PendingApprovalView; decide: (approved: boolean) => void };
}

export const streamOf = (sessionId: string) => `session:${sessionId}`;

/** Durable chat turns (spec §7): accepted once per idempotency key, executed independently of
 * any client connection, journaled as they progress, and never re-executed after a crash. */
export class RunService {
  private readonly active = new Map<string, ActiveRun>();
  private accepting = true;
  private disposed = false;

  constructor(private readonly deps: RunServiceDependencies) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }
  activeCount(): number { return this.active.size; }
  stopAccepting(): void { this.accepting = false; }

  /** Accepts a chat turn. `scope` is who asks (account and device, or the local profile); the
   * client's `commandId` is the idempotency key within that scope. */
  async start(scope: string, request: { commandId: string; sessionId: string; input: string }): Promise<CommandAck> {
    const input = request.input.trim();
    if (!input) throw new RunServiceError("The message is empty.", "invalid_input");
    if (input.length > MAX_INPUT_CHARS) throw new RunServiceError("The message is too long.", "invalid_input");
    const replay = this.replay(scope, request.commandId, { sessionId: request.sessionId, input });
    if (replay) return replay;
    if (!this.accepting) throw new RunServiceError("The server is shutting down. Try again when it is back.", "host_draining");
    if (!await this.deps.sessionExists(request.sessionId)) throw new RunServiceError("The chat does not exist on the server.", "session_unknown");
    const legacyBusy = this.deps.legacyBusy?.(request.sessionId) ?? false;
    const payloadJson = canonical({ sessionId: request.sessionId, input });
    const at = this.now().toISOString();
    const { ack, appended } = this.deps.host.transaction(db => {
      // Checked again inside the transaction: the async checks above may have interleaved.
      const existing = this.replay(scope, request.commandId, { sessionId: request.sessionId, input });
      if (existing) return { ack: existing, appended: [] };
      const commandId = randomUUID(), runId = randomUUID(), userMessageId = randomUUID(), assistantMessageId = randomUUID();
      db.prepare(`INSERT INTO commands(command_id, scope, idempotency_key, operation, target, payload_sha256, payload_json, status, accepted_at, updated_at)
        VALUES (?, ?, ?, 'chat.runs.start', ?, ?, ?, 'accepted', ?, ?)`).run(commandId, scope, request.commandId, request.sessionId, sha256(payloadJson), payloadJson, at, at);
      const rejected = (code: string, activeRunId?: string): CommandAck => {
        const value: CommandAck = { commandId: request.commandId, status: "rejected", code, ...(activeRunId ? { activeRunId } : {}) };
        db.prepare("UPDATE commands SET status = 'rejected', error_code = ?, result_json = ? WHERE command_id = ?").run(code, JSON.stringify(value), commandId);
        return value;
      };
      if (legacyBusy) return { ack: rejected("session_busy"), appended: [] };
      try {
        db.prepare("INSERT INTO runs(run_id, kind, session_id, command_id, status, created_at, updated_at) VALUES (?, 'chat', ?, ?, 'queued', ?, ?)")
          .run(runId, request.sessionId, commandId, at, at);
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 2067) throw error;
        const activeRun = db.prepare("SELECT run_id FROM runs WHERE session_id = ? AND kind = 'chat' AND status IN ('queued','running','waiting_approval')").get(request.sessionId);
        return { ack: rejected("session_busy", activeRun ? String(activeRun.run_id) : undefined), appended: [] };
      }
      const ack: CommandAck = { commandId: request.commandId, status: "accepted", runId, userMessageId, assistantMessageId };
      db.prepare("UPDATE commands SET run_id = ?, result_json = ? WHERE command_id = ?").run(runId, JSON.stringify(ack), commandId);
      db.prepare("INSERT INTO messages(message_id, session_id, run_id, role, status, content_json, created_at, updated_at) VALUES (?, ?, ?, 'user', 'accepted', ?, ?, ?)")
        .run(userMessageId, request.sessionId, runId, JSON.stringify({ text: input }), at, at);
      const event = this.deps.journal.append(db, streamOf(request.sessionId), { type: "message.accepted", runId,
        payload: { runId, assistantMessageId, message: { id: userMessageId, role: "user", content: input, createdAt: at } } });
      return { ack, appended: [event] };
    });
    this.deps.journal.publish(appended);
    if (ack.status === "accepted" && !ack.replayed) {
      this.active.set(ack.runId!, { runId: ack.runId!, sessionId: request.sessionId, assistantMessageId: ack.assistantMessageId!, controller: new AbortController(),
        text: "", progressDirty: false });
      setImmediate(() => this.execute(ack.runId!, input).catch(error =>
        this.deps.logger?.error("Chat run could not be recorded", { runId: ack.runId, error: error instanceof Error ? error.message : String(error) })));
    }
    return ack;
  }

  /** Cancel is its own command; a disconnect never cancels. Finished runs return their status. */
  cancel(runId: string): RunView {
    const run = this.get(runId);
    if (!run) throw new RunServiceError("The run does not exist on the server.", "run_unknown");
    this.active.get(runId)?.controller.abort("cancel");
    return run;
  }

  resolveApproval(runId: string, approvalId: string, approved: boolean): { accepted: boolean } {
    const run = this.active.get(runId);
    if (!run?.approval || run.approval.view.approvalId !== approvalId) throw new RunServiceError("This approval is no longer pending.", "approval_stale");
    run.approval.decide(approved);
    return { accepted: true };
  }

  get(runId: string): RunView | undefined {
    const row = this.deps.host.db.prepare(`SELECT r.run_id, r.session_id, r.status, r.error_code, r.created_at, r.updated_at,
      (SELECT message_id FROM messages m WHERE m.run_id = r.run_id AND m.role = 'assistant') AS assistant_id FROM runs r WHERE r.run_id = ?`).get(runId);
    if (!row) return undefined;
    return { runId: String(row.run_id), sessionId: String(row.session_id), status: row.status as RunStatus, ...(row.error_code ? { error: String(row.error_code) } : {}),
      ...(row.assistant_id ? { assistantMessageId: String(row.assistant_id) } : {}), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }

  /** The session's running turn with its live state: for a client that opens the chat mid-answer. */
  activeRun(sessionId: string): ActiveRunView | undefined {
    const row = this.deps.host.db.prepare("SELECT run_id FROM runs WHERE session_id = ? AND kind = 'chat' AND status IN ('queued','running','waiting_approval')").get(sessionId);
    const view = row ? this.get(String(row.run_id)) : undefined;
    if (!view) return undefined;
    const live = this.active.get(view.runId);
    return { ...view, partialText: live?.text ?? "", ...(live?.progress ? { progress: live.progress } : {}), ...(live?.approval ? { pendingApproval: live.approval.view } : {}) };
  }

  /** Turns that history from memory does not contain: unfinished, failed, cancelled or interrupted. */
  unfinishedTurns(sessionId: string, limit = 20): ChatMessage[] {
    const rows = this.deps.host.db.prepare(`SELECT r.run_id, r.status, r.error_code, m.message_id, m.role, m.status AS message_status, m.content_json, m.created_at
      FROM runs r JOIN messages m ON m.run_id = r.run_id
      WHERE r.session_id = ? AND r.kind = 'chat' AND r.status <> 'completed'
        AND r.run_id IN (SELECT run_id FROM runs WHERE session_id = ? AND kind = 'chat' AND status <> 'completed' ORDER BY created_at DESC LIMIT ?)
      ORDER BY m.created_at, m.role DESC`).all(sessionId, sessionId, limit);
    return rows.map(row => ({ id: String(row.message_id), role: row.role as "user" | "assistant", content: String((JSON.parse(String(row.content_json)) as { text?: string }).text ?? ""),
      createdAt: String(row.created_at), runId: String(row.run_id), runStatus: row.status as RunStatus, ...(row.error_code && row.role === "assistant" ? { runError: String(row.error_code) } : {}) }));
  }

  /** After a restart: runs that were active are interrupted with their partial answers; nothing is re-run.
   * A run last seen in a tool step may have changed something, so it needs review. */
  recover(): number {
    const at = this.now().toISOString();
    const appended = this.deps.host.transaction(db => {
      const events: Array<{ streamId: string; event: JournalEvent }> = [];
      for (const run of db.prepare("SELECT run_id, session_id FROM runs WHERE kind = 'chat' AND status IN ('queued','running','waiting_approval')").all()) {
        const last = db.prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'run.progress' ORDER BY sequence DESC LIMIT 1").get(run.run_id);
        const phase = last ? (JSON.parse(String(last.payload_json)) as { progress?: { phase?: string } }).progress?.phase : undefined;
        const status: RunStatus = phase === "tools" || phase === "approval" ? "needs_review" : "interrupted";
        db.prepare("UPDATE runs SET status = ?, error_code = 'host_restarted', updated_at = ?, finished_at = ? WHERE run_id = ?").run(status, at, at, run.run_id);
        db.prepare("UPDATE messages SET status = 'interrupted', updated_at = ? WHERE run_id = ? AND status IN ('accepted','streaming')").run(at, run.run_id);
        db.prepare("UPDATE messages SET status = 'completed', updated_at = ? WHERE run_id = ? AND role = 'user' AND status = 'interrupted'").run(at, run.run_id);
        db.prepare("UPDATE commands SET status = 'interrupted', updated_at = ? WHERE run_id = ? AND status IN ('accepted','running')").run(at, run.run_id);
        events.push(this.deps.journal.append(db, streamOf(String(run.session_id)), { type: `run.${status}`, runId: String(run.run_id),
          payload: { runId: String(run.run_id), error: "The server restarted while answering." } }));
      }
      return events;
    });
    this.deps.journal.publish(appended);
    return appended.length;
  }

  /** Server shutdown after the drain deadline: running turns end as interrupted, not cancelled. */
  interruptAll(): number {
    for (const run of this.active.values()) run.controller.abort("host_shutdown");
    return this.active.size;
  }

  /** Before the database closes: stops intake and interrupts what still runs. Turns that could
   * not record their end are interrupted by `recover()` on the next start. */
  async dispose(timeoutMs = 2_000): Promise<void> {
    this.stopAccepting();
    this.interruptAll();
    for (const deadline = Date.now() + timeoutMs; this.active.size && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20));
    this.disposed = true;
  }

  private replay(scope: string, key: string, payload: { sessionId: string; input: string }): CommandAck | undefined {
    const row = this.deps.host.db.prepare("SELECT payload_sha256, result_json FROM commands WHERE scope = ? AND idempotency_key = ?").get(scope, key);
    if (!row) return undefined;
    if (row.payload_sha256 !== sha256(canonical(payload))) throw new RunServiceError("This command id was already used for a different message.", "idempotency_conflict");
    return { ...(JSON.parse(String(row.result_json)) as CommandAck), replayed: true };
  }

  private async execute(runId: string, input: string): Promise<void> {
    const run = this.active.get(runId);
    if (!run || this.disposed) return;
    const { sessionId } = run;
    try {
      const started = this.deps.host.transaction(db => {
        const at = this.now().toISOString();
        db.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE run_id = ? AND status = 'queued'").run(at, runId);
        db.prepare("UPDATE commands SET status = 'running', updated_at = ? WHERE run_id = ?").run(at, runId);
        db.prepare("INSERT INTO messages(message_id, session_id, run_id, role, status, content_json, created_at, updated_at) VALUES (?, ?, ?, 'assistant', 'streaming', ?, ?, ?)")
          .run(run.assistantMessageId, sessionId, runId, JSON.stringify({ text: "" }), at, at);
        return [this.deps.journal.append(db, streamOf(sessionId), { type: "run.started", runId, payload: { runId, assistantMessageId: run.assistantMessageId } })];
      });
      this.deps.journal.publish(started);
      run.controller.signal.throwIfAborted();
      const result = await this.deps.execute({ runId, sessionId, input }, {
        signal: run.controller.signal,
        onProgress: event => this.onProgress(run, event),
        requestApproval: operation => this.requestApproval(run, operation)
      });
      this.flush(run);
      if (result.error) { this.finish(run, "failed", result.error); return; }
      const turn = await this.deps.completedTurn?.(sessionId, runId).catch(() => undefined);
      this.finish(run, "completed", undefined, turn);
    } catch (error) {
      this.flush(run);
      const reason = run.controller.signal.aborted ? run.controller.signal.reason : undefined;
      if (reason === "cancel") this.finish(run, "cancelled");
      else if (reason === "host_shutdown") this.finish(run, "interrupted", "The server stopped while answering.");
      else this.finish(run, "failed", error instanceof Error ? error.message : "The answer failed on the server.");
    }
  }

  /** Coalesces the cumulative answer into deltas and the latest progress, flushed every 300 ms. */
  private onProgress(run: ActiveRun, event: ProcessProgressEvent): void {
    const { answer, ...progress } = event;
    if (typeof answer === "string" && answer !== run.text) {
      if (answer.startsWith(run.text)) {
        const offset = run.text.length;
        run.pendingText = run.pendingText && !run.pendingText.replace ? { offset: run.pendingText.offset, text: run.pendingText.text + answer.slice(offset) }
          : run.pendingText?.replace ? { offset: 0, text: answer, replace: true } : { offset, text: answer.slice(offset) };
      } else run.pendingText = { offset: 0, text: answer, replace: true };
      run.text = answer;
    }
    const phaseChanged = progress.phase !== run.progress?.phase;
    run.progress = { ...progress, agents: progress.agents ?? run.progress?.agents, activity: progress.activity ?? run.progress?.activity };
    run.progressDirty = true;
    if (phaseChanged) this.flush(run);
    else run.timer ??= setTimeout(() => this.flush(run), FLUSH_MS);
  }

  private flush(run: ActiveRun): void {
    clearTimeout(run.timer); run.timer = undefined;
    if (this.disposed || (!run.pendingText && !run.progressDirty)) return;
    const pendingText = run.pendingText, progress = run.progressDirty ? run.progress : undefined;
    run.pendingText = undefined; run.progressDirty = false;
    const appended = this.deps.host.transaction(db => {
      const events = [];
      if (pendingText) {
        events.push(this.deps.journal.append(db, streamOf(run.sessionId), { type: "message.delta", runId: run.runId,
          payload: { runId: run.runId, messageId: run.assistantMessageId, ...pendingText } }));
        db.prepare("UPDATE messages SET content_json = ?, updated_at = ? WHERE message_id = ?").run(JSON.stringify({ text: run.text }), this.now().toISOString(), run.assistantMessageId);
      }
      if (progress) events.push(this.deps.journal.append(db, streamOf(run.sessionId), { type: "run.progress", runId: run.runId, payload: { runId: run.runId, progress } }));
      return events;
    });
    this.deps.journal.publish(appended);
  }

  private requestApproval(run: ActiveRun, operation: ApprovalOperation): Promise<boolean> {
    run.controller.signal.throwIfAborted();
    if (run.approval) return Promise.reject(new RunServiceError("Another approval is pending.", "approval_pending"));
    const view: PendingApprovalView = { ...operation, approvalId: randomUUID(), digest: sha256(canonical(operation)), requestedAt: this.now().toISOString() };
    this.flush(run);
    this.transition(run, "waiting_approval", { type: "approval.requested", payload: { runId: run.runId, ...view } });
    return new Promise<boolean>((resolve, reject) => {
      const abort = () => { run.approval = undefined; reject(run.controller.signal.reason); };
      run.approval = { view, decide: approved => {
        run.controller.signal.removeEventListener("abort", abort);
        run.approval = undefined;
        this.transition(run, "running", { type: "approval.resolved", payload: { runId: run.runId, approvalId: view.approvalId, approved } });
        resolve(approved);
      } };
      run.controller.signal.addEventListener("abort", abort, { once: true });
    });
  }

  private transition(run: ActiveRun, status: RunStatus, event: { type: string; payload: Record<string, unknown> }): void {
    if (this.disposed) return;
    const appended = this.deps.host.transaction(db => {
      db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?").run(status, this.now().toISOString(), run.runId);
      return [this.deps.journal.append(db, streamOf(run.sessionId), { ...event, runId: run.runId })];
    });
    this.deps.journal.publish(appended);
  }

  private finish(run: ActiveRun, status: "completed" | "failed" | "cancelled" | "interrupted", error?: string, turn?: ChatMessage[]): void {
    this.active.delete(run.runId);
    clearTimeout(run.timer);
    if (this.disposed) return;
    // Devices read this error; the host log keeps the full text.
    if (error !== undefined) {
      if (status === "failed") this.deps.logger?.warn("Chat run failed", { runId: run.runId, error });
      error = publicError(error);
    }
    // Providers that do not stream report no partial text; the stored turn has the final answer.
    const finalText = turn?.find(message => message.role === "assistant")?.content;
    if (finalText !== undefined) run.text = finalText;
    const at = this.now().toISOString();
    const messageStatus = status === "completed" ? "completed" : status === "failed" ? "failed" : "interrupted";
    const appended = this.deps.host.transaction(db => {
      db.prepare("UPDATE runs SET status = ?, error_code = ?, updated_at = ?, finished_at = ? WHERE run_id = ?").run(status, error ?? null, at, at, run.runId);
      db.prepare("UPDATE messages SET status = ?, content_json = ?, updated_at = ? WHERE message_id = ?").run(messageStatus, JSON.stringify({ text: run.text }), at, run.assistantMessageId);
      db.prepare("UPDATE messages SET status = 'completed', updated_at = ? WHERE run_id = ? AND role = 'user'").run(at, run.runId);
      db.prepare("UPDATE commands SET status = ?, updated_at = ? WHERE run_id = ?").run(status === "completed" ? "completed" : status === "failed" ? "failed" : "interrupted", at, run.runId);
      const events = [];
      if (status === "completed") events.push(this.deps.journal.append(db, streamOf(run.sessionId), { type: "message.completed", runId: run.runId,
        payload: { runId: run.runId, assistantMessageId: run.assistantMessageId, text: run.text, ...(turn ? { messages: turn } : {}) } }));
      events.push(this.deps.journal.append(db, streamOf(run.sessionId), { type: `run.${status}`, runId: run.runId, payload: { runId: run.runId, ...(error ? { error } : {}) } }));
      return events;
    });
    this.deps.journal.publish(appended);
  }
}
