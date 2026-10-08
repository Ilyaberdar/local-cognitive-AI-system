import { randomUUID } from "crypto";
import { RemoteOperationError } from "../remote/host/RemoteHost";
import { canonical, sha256 } from "./canonical";
import type { HostDatabase } from "./db/HostDatabase";

/** What a command knows about itself: the run id reserved for it and when it was accepted. */
export interface CommandRecord { runId?: string; acceptedAt: string; target?: string }

export interface LedgerCommand<T> {
  /** Who asks (account and device): command ids of different devices never collide. */
  scope: string;
  /** The client's command id. */
  key: string;
  operation: string;
  /** The request without its command id; a repeat must carry the same payload. */
  payload: unknown;
  target?: string;
  /** Reserve a run id before executing, so a restart can tell whether the run was created. */
  reserveRunId?: boolean;
  /** False while the host drains: a new command is refused before anything is recorded. */
  accepting?: () => boolean;
  /** For a command an earlier process accepted but never finished: its result if its effect is
   * known to exist, undefined if it is known not to (it is then reported as not started). */
  reconcile?: (record: CommandRecord) => Promise<T | undefined>;
}

interface Row { command_id: string; operation: string; payload_sha256: string; status: string; result_json: string | null; run_id: string | null; target: string | null; accepted_at: string }

const MESSAGES: Record<string, string> = {
  idempotency_conflict: "This command id was already used for a different request.",
  not_started: "The server restarted before this started. Nothing ran; try again.",
  unknown_outcome: "The server restarted while doing this. Refresh to see whether it happened."
};

/** Idempotency for host commands whose effects live outside host.db (tasks, schedules, workflows
 * and their runs are JSON stores): each (scope, command id) runs once, and a repeat gets the first
 * outcome, also after a restart. A command a restart interrupted is never executed again. */
export class CommandLedger {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly host: HostDatabase, private readonly options: { now?: () => Date } = {}) {}

  async run<T>(command: LedgerCommand<T>, execute: (record: CommandRecord) => Promise<T>): Promise<T> {
    const payloadJson = canonical(command.payload ?? null), hash = sha256(payloadJson);
    const known = this.find(command.scope, command.key);
    if (known) return this.replay(known, command, hash);
    if (command.accepting && !command.accepting()) throw new RemoteOperationError("The server is shutting down. Try again when it is back.", "host_draining");
    const begun = this.host.transaction(db => {
      // Checked again inside the transaction: another call may have recorded it meanwhile.
      const row = db.prepare("SELECT * FROM commands WHERE scope = ? AND idempotency_key = ?").get(command.scope, command.key) as Row | undefined;
      if (row) return { row };
      const commandId = randomUUID(), at = this.now(), runId = command.reserveRunId ? randomUUID() : null;
      db.prepare(`INSERT INTO commands(command_id, scope, idempotency_key, operation, target, payload_sha256, payload_json, status, run_id, accepted_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`).run(commandId, command.scope, command.key, command.operation, command.target ?? null, hash, payloadJson, runId, at, at);
      return { commandId, record: { ...(runId ? { runId } : {}), acceptedAt: at, ...(command.target ? { target: command.target } : {}) } as CommandRecord };
    });
    if ("row" in begun) return this.replay(begun.row!, command, hash);
    const execution = (async () => {
      try {
        const result = await execute(begun.record);
        this.settle(begun.commandId, "completed", { result });
        return result;
      } catch (error) {
        this.settle(begun.commandId, "failed", { error: describe(error) });
        throw error;
      } finally { this.pending.delete(begun.commandId); }
    })();
    this.pending.set(begun.commandId, execution);
    return execution;
  }

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }

  private find(scope: string, key: string): Row | undefined {
    return this.host.db.prepare("SELECT * FROM commands WHERE scope = ? AND idempotency_key = ?").get(scope, key) as Row | undefined;
  }

  private async replay<T>(row: Row, command: LedgerCommand<T>, hash: string): Promise<T> {
    if (row.operation !== command.operation || row.payload_sha256 !== hash) throw new RemoteOperationError(MESSAGES.idempotency_conflict!, "idempotency_conflict");
    const stored = row.result_json ? JSON.parse(row.result_json) as { result?: T; error?: { code: string; message: string } } : {};
    if (row.status === "completed") return stored.result as T;
    if (stored.error) throw new RemoteOperationError(stored.error.message, stored.error.code);
    // Still running in this process: the repeat waits for the same execution.
    const inFlight = this.pending.get(row.command_id);
    if (inFlight) return inFlight as Promise<T>;
    // Accepted by an earlier process that stopped before it finished: never executed again.
    const record: CommandRecord = { ...(row.run_id ? { runId: row.run_id } : {}), acceptedAt: row.accepted_at, ...(row.target ? { target: row.target } : {}) };
    const recovered = command.reconcile ? await command.reconcile(record) : undefined;
    if (recovered !== undefined) {
      this.settle(row.command_id, "completed", { result: recovered });
      return recovered;
    }
    const code = command.reconcile ? "not_started" : "unknown_outcome";
    this.settle(row.command_id, "interrupted", { error: { code, message: MESSAGES[code]! } });
    throw new RemoteOperationError(MESSAGES[code]!, code);
  }

  private settle(commandId: string, status: "completed" | "failed" | "interrupted", outcome: { result?: unknown; error?: { code: string; message: string } }): void {
    this.host.db.prepare("UPDATE commands SET status = ?, result_json = ?, error_code = ?, updated_at = ? WHERE command_id = ?")
      .run(status, JSON.stringify(outcome), outcome.error?.code ?? null, this.now(), commandId);
  }
}

/** Expected refusals keep their code and text; anything else is reported generically. */
const describe = (error: unknown): { code: string; message: string } => error instanceof RemoteOperationError
  ? { code: error.code, message: error.message }
  : { code: "operation_failed", message: "The operation failed on the server." };
