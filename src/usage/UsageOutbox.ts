import { randomUUID } from "node:crypto";
import type { Logger } from "../utils/Logger";
import type { UsageLedger, UsageWireEvent } from "./UsageLedger";

export const USAGE_BATCH_PATH = "/v1/usage/events:batch";
const BATCH = 50;
const PERMANENT = new Set(["owner_mismatch", "conflict", "invalid", "host_id_reserved"]);

/** Delivers one account's events to the Cloud: a computer with the account's token, a server
 * signed with its own key. `target` names whose events it can deliver right now. */
export interface UsageSender {
  target(): { accountId: string; executionHostId: string } | undefined;
  send(events: UsageWireEvent[], signal: AbortSignal): Promise<Response>;
}

export interface UsageFlushResult { sent: number; acked: number; rejected: number; error?: string }

/** Sends the ledger's waiting events, a batch at a time and one batch in flight. Soon after new
 * events, every minute, and on demand (before the Usage page reads the Cloud's totals). A failure
 * waits longer each time, up to an hour; a refusal of an event itself (another account's, a
 * malformed one) keeps that event on this computer. */
export class UsageOutbox {
  private sender?: UsageSender;
  private running?: Promise<UsageFlushResult>;
  private failures = 0;
  private retryAt = 0;
  private soon?: NodeJS.Timeout;
  private readonly timer: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  private stopped = false;

  constructor(private readonly ledger: UsageLedger, private readonly logger?: Logger, private readonly options: { intervalMs?: number; delayMs?: number; now?: () => number } = {}) {
    const recovered = ledger.recoverSent();
    if (recovered) logger?.info("Usage events of an interrupted send will be sent again", { count: recovered });
    this.unsubscribe = ledger.onRecord(() => this.schedule());
    this.timer = setInterval(() => { void this.flush(); }, options.intervalMs ?? 60_000);
    this.timer.unref();
  }

  setSender(sender: UsageSender | undefined): void {
    this.sender = sender;
    this.failures = 0; this.retryAt = 0;
    this.schedule();
  }

  /** Sends what waits, within the time given; a send already running is joined, not repeated. */
  flush(budgetMs = 30_000, force = false): Promise<UsageFlushResult> {
    if (this.running) return this.running;
    if (this.stopped || !this.sender || (!force && this.now() < this.retryAt)) return Promise.resolve({ sent: 0, acked: 0, rejected: 0 });
    this.running = this.drain(this.sender, budgetMs).finally(() => { this.running = undefined; });
    return this.running;
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer); clearTimeout(this.soon);
    this.unsubscribe();
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private schedule(): void {
    if (this.stopped || this.soon) return;
    this.soon = setTimeout(() => { this.soon = undefined; void this.flush(); }, this.options.delayMs ?? 5_000);
    this.soon.unref();
  }

  private async drain(sender: UsageSender, budgetMs: number): Promise<UsageFlushResult> {
    const result: UsageFlushResult = { sent: 0, acked: 0, rejected: 0 };
    const deadline = this.now() + budgetMs;
    while (!this.stopped && this.now() < deadline) {
      const target = sender.target();
      if (!target) break;
      const events = this.ledger.claim(target.accountId, target.executionHostId, BATCH);
      if (!events.length) break;
      const ids = events.map(event => event.eventId);
      result.sent += events.length;
      let failure: string | undefined;
      try {
        const response = await sender.send(events, AbortSignal.timeout(Math.max(1_000, Math.min(20_000, deadline - this.now()))));
        if (response.ok) {
          const body = await response.json().catch(() => ({})) as { acked?: Array<{ eventId: string; receivedAt: string }>; rejected?: Array<{ eventId: string; code: string }> };
          const acked = Array.isArray(body.acked) ? body.acked : [];
          // Only a refusal of the event itself is final; anything else is tried again.
          const rejected = (Array.isArray(body.rejected) ? body.rejected : []).filter(item => PERMANENT.has(item.code));
          this.ledger.settle(ids, acked, rejected);
          result.acked += acked.length; result.rejected += rejected.length;
          if (rejected.length) this.logger?.warn("The Cloud refused some usage events; they stay on this computer", { codes: [...new Set(rejected.map(item => item.code))] });
          if (!acked.length && !rejected.length) failure = "The Cloud acknowledged none of the events.";
        } else {
          await response.body?.cancel().catch(() => undefined);
          // A malformed batch is refused the same way every time: those events stay here.
          if (response.status === 400 || response.status === 413) { this.ledger.settle(ids, [], ids.map(eventId => ({ eventId, code: `http_${response.status}` }))); result.rejected += ids.length; continue; }
          failure = `HTTP ${response.status}`;
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (failure) {
        this.ledger.release(ids, failure);
        this.failures++;
        this.retryAt = this.now() + Math.min(3_600_000, 15_000 * 2 ** Math.min(8, this.failures - 1));
        result.error = failure;
        return result;
      }
      this.failures = 0; this.retryAt = 0;
    }
    return result;
  }
}

/** A computer's sender: the signed-in account's token, events under this computer's runtime id. */
export const accountUsageSender = (options: { cloudUrl: string; runtimeId: string; account(): string | undefined; token(): Promise<string>; fetchImpl?: typeof fetch }): UsageSender => ({
  target: () => { const accountId = options.account(); return accountId ? { accountId, executionHostId: options.runtimeId } : undefined; },
  send: async (events, signal) => (options.fetchImpl ?? fetch)(`${options.cloudUrl}${USAGE_BATCH_PATH}`, {
    method: "POST", signal, headers: { "content-type": "application/json", authorization: `Bearer ${await options.token()}` },
    body: JSON.stringify({ runtimeId: options.runtimeId, events })
  })
});

/** A server's sender: its owner's events, signed with the server's key over the exact payload. */
export const hostUsageSender = (options: { cloudUrl: string; hostId(): string | undefined; owner(): string | undefined;
  sign(payload: Buffer): Buffer | undefined; fetchImpl?: typeof fetch }): UsageSender => ({
  target: () => {
    const hostId = options.hostId(), accountId = options.owner();
    return hostId && accountId ? { accountId, executionHostId: hostId } : undefined;
  },
  send: async (events, signal) => {
    const payload = Buffer.from(JSON.stringify({ hostId: options.hostId(), batchId: randomUUID(), issuedAt: new Date().toISOString(), events }));
    const signature = options.sign(payload);
    if (!signature) throw new Error("The server's signing key is not loaded yet.");
    return (options.fetchImpl ?? fetch)(`${options.cloudUrl}${USAGE_BATCH_PATH}`, {
      method: "POST", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: payload.toString("base64url"), signature: signature.toString("base64url") })
    });
  }
});
