import { createHmac } from "node:crypto";
import type { HostDatabase } from "../runtime/db/HostDatabase";
import type { Logger } from "../utils/Logger";
import type { UsageAttemptRecord, UsageRecorder } from "./UsageCall";

/** Who a model call ran for, read when it is recorded: the account that owns this server, or the
 * one signed in to this computer, and the Cloud id of a registered server. */
export interface UsageAttribution { accountId?: string; hostId?: string }

const META = { runtimeId: "usage.runtime_id", salt: "usage.id_salt", startedAt: "usage.ledger_started_at" } as const;
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
  }
}
