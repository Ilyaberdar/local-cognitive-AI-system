import { randomUUID } from "node:crypto";
import type { LLMResponse, TokenUsage, UsageAttemptHook } from "../types";
import type { UsageScope } from "./UsageScope";
import { diagnostics } from "../diagnostics/DiagnosticLog";

/** How one HTTP request to a model ended: answered, refused with an error status (nothing was
 * generated), lost before an answer (network, timeout), or cancelled by the user. */
export type UsageOutcome = "completed" | "rejected" | "failed" | "cancelled";

/** One request to a model, as the executing runtime records it: counts and ids only, no text. */
export interface UsageAttemptRecord {
  eventId: string;
  callId: string;
  attempt: number;
  provider: string;
  model: string;
  scope: UsageScope;
  startedAt: string;
  occurredAt: string;
  outcome: UsageOutcome;
  httpStatus?: number;
  /** "reported" when the provider counted the tokens; "unknown" leaves them out, never as 0. */
  usageSource: "reported" | "unknown";
  usage?: TokenUsage;
}

export interface UsageRecorder {
  record(attempts: UsageAttemptRecord[]): void;
}

interface Attempt { startedAt: string; endedAt?: string; status?: number; outcome?: UsageOutcome }

/** A path or a folder in a local model's name is not sent anywhere; the rest is bounded. */
export const usageModelName = (model: string): string =>
  (/^(?:[\\/~]|[A-Za-z]:[\\/])/.test(model) ? model.split(/[\\/]/).pop() ?? "" : model).slice(0, 128) || "unknown";

/** The requests one `generateText` made. A provider marks each HTTP request it sends (retries,
 * a request repeated without an unsupported option); the call's tokens belong to the request that
 * answered. A provider that marks nothing but answers (a test double) counts as one request. */
export class UsageCall implements UsageAttemptHook {
  readonly id = randomUUID();
  private readonly attempts: Attempt[] = [];
  private done = false;

  constructor(private readonly recorder: UsageRecorder, private readonly provider: string, private model: string, private readonly scope: UsageScope) {}

  attempt() {
    const attempt: Attempt = { startedAt: new Date().toISOString() };
    this.attempts.push(attempt);
    return {
      responded: (status: number) => { attempt.status = status; attempt.endedAt = new Date().toISOString();
        if (status < 200 || status >= 300) attempt.outcome = "rejected"; },
      failed: (cancelled: boolean) => { attempt.endedAt = new Date().toISOString(); attempt.outcome = cancelled ? "cancelled" : "failed"; }
    };
  }

  /** Records every request of this call, once: the answered one with the response's tokens. A call
   * that threw (cancelled, or failed outside the provider's own handling) keeps its tokens unknown. */
  end(response: LLMResponse | undefined, cancelled: boolean): void {
    if (this.done) return;
    this.done = true;
    if (response?.model) this.model = response.model;
    if (!this.attempts.length) {
      // Nothing was sent (a model not loaded, an invalid image): no request to record.
      if (!response || response.error && !response.usage) return;
      this.attempts.push({ startedAt: new Date().toISOString() });
    }
    // The tokens belong to the last request that was answered; the provider read them from it.
    const answered = [...this.attempts].reverse().find(attempt => !attempt.outcome);
    const now = new Date().toISOString();
    const records = this.attempts.map((attempt, index): UsageAttemptRecord => {
      const outcome = attempt.outcome ?? (attempt === answered && response ? "completed" : cancelled ? "cancelled" : "failed");
      const usage = attempt === answered && response?.usage ? response.usage : undefined;
      return {
        eventId: randomUUID(), callId: this.id, attempt: index + 1,
        provider: this.provider, model: usageModelName(this.model), scope: this.scope,
        startedAt: attempt.startedAt, occurredAt: attempt.endedAt ?? now, outcome,
        ...(attempt.status !== undefined ? { httpStatus: attempt.status } : {}),
        usageSource: usage ? "reported" : "unknown", ...(usage ? { usage } : {})
      };
    });
    // A refused or lost request is a provider failure in the technical log (a cancellation is not).
    for (const record of records) if (record.outcome === "rejected" || record.outcome === "failed")
      diagnostics().record("provider.call_failed", { provider: record.provider, outcome: record.outcome, ...(record.httpStatus !== undefined ? { httpStatus: record.httpStatus } : {}) });
    this.recorder.record(records);
  }
}
