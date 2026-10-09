import { createHmac } from "node:crypto";
import type { HostDatabase } from "../runtime/db/HostDatabase";
import type { Logger } from "../utils/Logger";
import type { UsageAttemptRecord, UsageRecorder } from "./UsageCall";

/** Who a model call ran for, read when it is recorded: the account that owns this server, or the
 * one signed in to this computer, and the Cloud id of a registered server. */
export interface UsageAttribution { accountId?: string; hostId?: string }

const META = { runtimeId: "usage.runtime_id", salt: "usage.id_salt", startedAt: "usage.ledger_started_at" } as const;

/** An event as the Cloud receives it (apps/cloud/src/usage/usageEvent.ts): counts and references. */
export interface UsageWireEvent {
  eventId: string; accountId: string; callId: string; attempt: number; runRef: string | null; sessionRef: string | null;
  origin: string | null; purpose: string | null; provider: string; model: string; startedAt: string; occurredAt: string;
  outcome: string; httpStatus: number | null; usageSource: string; inputTokens: number | null; outputTokens: number | null;
  totalTokens: number | null; cachedInputTokens: number | null; cacheWriteTokens: number | null; reasoningTokens: number | null;
}
const wire = (row: Record<string, unknown>): UsageWireEvent => {
  const text = (value: unknown) => value === null || value === undefined ? null : String(value);
  const number = (value: unknown) => value === null || value === undefined ? null : Number(value);
  return { eventId: String(row.event_id), accountId: String(row.account_id), callId: String(row.call_id), attempt: Number(row.attempt),
    runRef: text(row.run_ref), sessionRef: text(row.session_ref), origin: text(row.origin), purpose: text(row.purpose),
    provider: String(row.provider), model: String(row.model), startedAt: String(row.started_at), occurredAt: String(row.occurred_at),
    outcome: String(row.outcome), httpStatus: number(row.http_status), usageSource: String(row.usage_source),
    inputTokens: number(row.input_tokens), outputTokens: number(row.output_tokens), totalTokens: number(row.total_tokens),
    cachedInputTokens: number(row.cached_input_tokens), cacheWriteTokens: number(row.cache_write_tokens), reasoningTokens: number(row.reasoning_tokens) };
};
const SOURCE = new Set(["reported", "estimated", "unknown"]);

/** The executing runtime's usage ledger in host.db. Each request to a model is one row, written
 * once and never changed except for its delivery to the Cloud. A row with an account waits to be
 * sent (`pending`); one without (signed out, a server nobody claimed) stays on this computer
 * (`local_only`), and is never given to an account signed in later. Run and session ids are kept
 * only as keyed hashes: a chat id from Telegram, say, is not something to send anywhere. */
export class UsageLedger implements UsageRecorder {
  readonly runtimeId: string;
  readonly startedAt: string;
  private readonly salt: string;

  constructor(private readonly host: HostDatabase, private readonly attribution: () => UsageAttribution, private readonly logger?: Logger) {
    const meta = (key: string) => {
      const value = host.meta(key);
      if (!value) throw new Error(`host.db has no ${key}; its usage migration did not run.`);
      return value;
    };
    this.runtimeId = meta(META.runtimeId);
    this.salt = meta(META.salt);
    this.startedAt = meta(META.startedAt);
  }

  private readonly listeners = new Set<() => void>();
  /** Called after new events are written (the outbox sends them soon). */
  onRecord(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** The same id gives the same reference, so a run's calls stay together without naming it. */
  reference(id: string | undefined): string | null {
    return id ? createHmac("sha256", this.salt).update(id).digest("base64url").slice(0, 32) : null;
  }

  record(attempts: UsageAttemptRecord[]): void {
    if (!attempts.length) return;
    let who: UsageAttribution = {};
    try { who = this.attribution(); }
    catch (error) { this.logger?.warn("Usage is recorded without an account", { error: error instanceof Error ? error.message : String(error) }); }
    const accountId = who.accountId || null;
    const insert = this.host.db.prepare(`INSERT INTO usage_events(event_id, execution_host_id, account_id, call_id, attempt, run_ref, session_ref,
      origin, purpose, provider, model, started_at, occurred_at, outcome, http_status, usage_source, input_tokens, output_tokens, total_tokens,
      cached_input_tokens, cache_write_tokens, reasoning_tokens, sync_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tokens = (value: number | undefined) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    this.host.transaction(() => {
      for (const attempt of attempts) {
        const usage = attempt.usage;
        insert.run(attempt.eventId, who.hostId || this.runtimeId, accountId, attempt.callId, attempt.attempt,
          this.reference(attempt.scope.runId), this.reference(attempt.scope.sessionId),
          attempt.scope.origin ?? null, attempt.scope.purpose?.slice(0, 64) ?? null, attempt.provider.slice(0, 64), attempt.model.slice(0, 128),
          attempt.startedAt, attempt.occurredAt, attempt.outcome, attempt.httpStatus ?? null,
          SOURCE.has(attempt.usageSource) ? attempt.usageSource : "unknown",
          tokens(usage?.inputTokens), tokens(usage?.outputTokens), tokens(usage?.totalTokens),
          tokens(usage?.cachedInputTokens), tokens(usage?.cacheWriteTokens), tokens(usage?.reasoningTokens),
          accountId ? "pending" : "local_only");
      }
    });
    if (accountId) for (const listener of this.listeners) listener();
  }

  /** A batch interrupted by a restart was maybe received, maybe not: it is sent again (a resend
   * of a received event is acknowledged as a duplicate). */
  recoverSent(): number {
    return Number(this.host.db.prepare("UPDATE usage_events SET sync_state = 'pending' WHERE sync_state = 'sent'").run().changes);
  }

  /** The oldest waiting events of one account, recorded under one runtime id, marked as sent. */
  claim(accountId: string, executionHostId: string, limit: number): UsageWireEvent[] {
    return this.host.transaction(db => {
      const rows = db.prepare(`SELECT * FROM usage_events WHERE sync_state = 'pending' AND account_id = ? AND execution_host_id = ?
        ORDER BY occurred_at, event_id LIMIT ?`).all(accountId, executionHostId, limit) as Array<Record<string, unknown>>;
      const mark = db.prepare("UPDATE usage_events SET sync_state = 'sent', sync_attempts = sync_attempts + 1 WHERE event_id = ?");
      for (const row of rows) mark.run(String(row.event_id));
      return rows.map(wire);
    });
  }

  /** The Cloud's answer: acknowledged events keep its receipt time; refused ones stay on this
   * computer with the reason; any it did not mention wait for the next attempt. */
  settle(eventIds: string[], acked: Array<{ eventId: string; receivedAt: string }>, rejected: Array<{ eventId: string; code: string }>): void {
    const done = new Set<string>();
    this.host.transaction(db => {
      const ack = db.prepare("UPDATE usage_events SET sync_state = 'acked', cloud_received_at = ?, sync_error = NULL WHERE event_id = ? AND sync_state = 'sent'");
      const refuse = db.prepare("UPDATE usage_events SET sync_state = 'local_only', sync_error = ? WHERE event_id = ? AND sync_state = 'sent'");
      const wait = db.prepare("UPDATE usage_events SET sync_state = 'pending' WHERE event_id = ? AND sync_state = 'sent'");
      const sent = new Set(eventIds);
      for (const item of acked) if (sent.has(item.eventId) && Number.isFinite(Date.parse(item.receivedAt))) { ack.run(new Date(item.receivedAt).toISOString(), item.eventId); done.add(item.eventId); }
      for (const item of rejected) if (sent.has(item.eventId) && !done.has(item.eventId)) { refuse.run(String(item.code).slice(0, 64), item.eventId); done.add(item.eventId); }
      for (const eventId of eventIds) if (!done.has(eventId)) wait.run(eventId);
    });
  }

  /** A failed send: the events wait for the next attempt. */
  release(eventIds: string[], error: string): void {
    this.host.transaction(db => {
      const wait = db.prepare("UPDATE usage_events SET sync_state = 'pending', sync_error = ? WHERE event_id = ? AND sync_state = 'sent'");
      for (const eventId of eventIds) wait.run(error.slice(0, 200), eventId);
    });
  }

  /** How many of an account's events have not reached the Cloud yet. */
  pendingCount(accountId: string): number {
    return Number(this.host.db.prepare("SELECT count(*) AS n FROM usage_events WHERE account_id = ? AND sync_state IN ('pending', 'sent')").get(accountId)?.n ?? 0);
  }
}
