import type pg from "pg";
import type { UsageEvent } from "./usageEvent.js";

export type UsageRejection = "owner_mismatch" | "conflict" | "invalid" | "host_id_reserved";
export interface UsageIngestResult { acked: Array<{ eventId: string; receivedAt: string }>; rejected: Array<{ eventId: string; code: UsageRejection }> }
export interface UsageTotals { requests: number; inputTokens: number; outputTokens: number; totalTokens: number;
  cachedInputTokens: number; reasoningTokens: number; requestsWithoutUsage: number }
export interface UsageBucket extends UsageTotals { start: string }

const COLUMNS = `execution_host_id, event_id, account_id, source, call_id, attempt, run_ref, session_ref, origin, purpose, provider, model,
  started_at, occurred_at, outcome, http_status, usage_source, input_tokens, output_tokens, total_tokens, cached_input_tokens, cache_write_tokens, reasoning_tokens`;
// Sums count only reported numbers; an answered or cancelled request with no total is counted apart.
const TOTALS = `count(*)::bigint AS requests, coalesce(sum(input_tokens), 0)::bigint AS input_tokens, coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
  coalesce(sum(total_tokens), 0)::bigint AS total_tokens, coalesce(sum(cached_input_tokens), 0)::bigint AS cached_input_tokens,
  coalesce(sum(reasoning_tokens), 0)::bigint AS reasoning_tokens,
  count(*) FILTER (WHERE total_tokens IS NULL AND outcome IN ('completed', 'cancelled'))::bigint AS requests_without_usage`;
type TotalsRow = Record<"requests" | "input_tokens" | "output_tokens" | "total_tokens" | "cached_input_tokens" | "reasoning_tokens" | "requests_without_usage", string>;
const totals = (row: TotalsRow | undefined): UsageTotals => ({
  requests: Number(row?.requests ?? 0), inputTokens: Number(row?.input_tokens ?? 0), outputTokens: Number(row?.output_tokens ?? 0),
  totalTokens: Number(row?.total_tokens ?? 0), cachedInputTokens: Number(row?.cached_input_tokens ?? 0), reasoningTokens: Number(row?.reasoning_tokens ?? 0),
  requestsWithoutUsage: Number(row?.requests_without_usage ?? 0)
});

export type UsageRepository = ReturnType<typeof createUsageRepository>;

export const createUsageRepository = (pool: Pick<pg.Pool, "query">) => {
  return {
    /** The database's clock: receipt times come from it, so a cut-off must too. */
    async now(): Promise<Date> {
      const { rows } = await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      return rows[0]!.now;
    },

    async isRegisteredHost(id: string): Promise<boolean> {
      const { rowCount } = await pool.query("SELECT 1 FROM hosts WHERE id = $1", [id]);
      return Boolean(rowCount);
    },

    /** Stores each event once. A resend of a stored event is acknowledged with its first receipt
     * time; the same ids from another account are refused, never merged. */
    async ingest(executionHostId: string, source: "host" | "local", events: UsageEvent[]): Promise<UsageIngestResult> {
      const result: UsageIngestResult = { acked: [], rejected: [] };
      for (const event of events) {
        const values = [executionHostId, event.eventId, event.accountId, source, event.callId, event.attempt, event.runRef ?? null, event.sessionRef ?? null,
          event.origin ?? null, event.purpose ?? null, event.provider, event.model, event.startedAt, event.occurredAt, event.outcome, event.httpStatus ?? null,
          event.usageSource, event.inputTokens ?? null, event.outputTokens ?? null, event.totalTokens ?? null, event.cachedInputTokens ?? null,
          event.cacheWriteTokens ?? null, event.reasoningTokens ?? null];
        const inserted = await pool.query<{ received_at: Date }>(`INSERT INTO usage_events (${COLUMNS})
          VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")}) ON CONFLICT (execution_host_id, event_id) DO NOTHING RETURNING received_at`, values);
        let receivedAt = inserted.rows[0]?.received_at;
        if (!receivedAt) {
          const { rows } = await pool.query<{ account_id: string; received_at: Date }>(
            "SELECT account_id, received_at FROM usage_events WHERE execution_host_id = $1 AND event_id = $2", [executionHostId, event.eventId]);
          if (rows[0]?.account_id !== event.accountId) { result.rejected.push({ eventId: event.eventId, code: "conflict" }); continue; }
          receivedAt = rows[0].received_at;
        }
        result.acked.push({ eventId: event.eventId, receivedAt: receivedAt.toISOString() });
      }
      return result;
    },

    /** Everything received by `asOf`, and the part that ran in [from, to); by runtime as well. */
    async summary(accountId: string, from: Date, to: Date, asOf: Date) {
      const lifetime = await pool.query<TotalsRow & { first_event_at: Date | null }>(
        `SELECT ${TOTALS}, min(occurred_at) AS first_event_at FROM usage_events WHERE account_id = $1 AND received_at <= $2`, [accountId, asOf]);
      const period = await pool.query<TotalsRow>(
        `SELECT ${TOTALS} FROM usage_events WHERE account_id = $1 AND received_at <= $2 AND occurred_at >= $3 AND occurred_at < $4`, [accountId, asOf, from, to]);
      // The token columns are usage_events' own: `hosts` has none of those names.
      const sources = await pool.query<TotalsRow & { execution_host_id: string; source: "host" | "local"; name: string | null; last_event_at: Date }>(
        `SELECT e.execution_host_id, e.source, h.name, max(e.occurred_at) AS last_event_at, ${TOTALS}
         FROM usage_events e LEFT JOIN hosts h ON h.id = e.execution_host_id AND e.source = 'host'
         WHERE e.account_id = $1 AND e.received_at <= $2 GROUP BY e.execution_host_id, e.source, h.name ORDER BY last_event_at DESC LIMIT 50`, [accountId, asOf]);
      return {
        lifetime: { ...totals(lifetime.rows[0]), firstEventAt: lifetime.rows[0]?.first_event_at?.toISOString() ?? null },
        period: totals(period.rows[0]),
        sources: sources.rows.map(row => ({ executionHostId: row.execution_host_id, source: row.source, name: row.name, lastEventAt: row.last_event_at.toISOString(), ...totals(row) }))
      };
    },

    /** Calendar days, or weeks from Monday, in the viewer's zone: each event's UTC time moved by
     * the offset of the segment it falls in. `before` is everything before the first segment, so a
     * cumulative line starts at the right height. */
    async activity(accountId: string, segments: Array<{ start: Date; offsetMinutes: number }>, end: Date, granularity: "day" | "week", asOf: Date) {
      const starts = segments.map(segment => segment.start), ends = [...segments.slice(1).map(segment => segment.start), end];
      const local = "((occurred_at AT TIME ZONE 'UTC') + make_interval(mins => z.offset_minutes))";
      const bucket = granularity === "day" ? `${local}::date` : `date_trunc('week', ${local})::date`;
      const { rows } = await pool.query<TotalsRow & { start: string }>(
        `WITH z AS (SELECT * FROM unnest($3::timestamptz[], $4::timestamptz[], $5::int[]) AS z(start_at, end_at, offset_minutes))
         SELECT to_char(${bucket}, 'YYYY-MM-DD') AS start, ${TOTALS} FROM usage_events JOIN z ON occurred_at >= z.start_at AND occurred_at < z.end_at
         WHERE account_id = $1 AND received_at <= $2 GROUP BY 1 ORDER BY 1`,
        [accountId, asOf, starts, ends, segments.map(segment => segment.offsetMinutes)]);
      const before = await pool.query<TotalsRow>(`SELECT ${TOTALS} FROM usage_events WHERE account_id = $1 AND received_at <= $2 AND occurred_at < $3`,
        [accountId, asOf, starts[0]]);
      return { buckets: rows.map(row => ({ start: row.start, ...totals(row) })), before: totals(before.rows[0]) };
    }
  };
};
