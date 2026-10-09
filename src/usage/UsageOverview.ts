import type { UsageLedger } from "./UsageLedger";
import type { UsageOutbox } from "./UsageOutbox";
import { addTotals, daysFromQuarters, emptyTotals, knownTimeZone, localDate, mergeDays, dateBefore, zoneSegments, type UsageDay, type UsageTotals } from "./UsageProjection";

/** About a year of days: the Daily heatmap's 53 weeks. */
export const OVERVIEW_DAYS = 370;

export interface UsageSource { id: string; kind: "host" | "local"; name: string | null; here: boolean; totalTokens: number; lastEventAt?: string }
export interface UsageOverview {
  /** cloud: the account's totals; offline: the Cloud was unreachable, this computer's part only;
   * local: signed out, everything recorded on this computer. */
  state: "cloud" | "offline" | "local";
  timeZone: string;
  from: string;
  to: string;
  /** The Cloud's cut-off: a server adds what the Cloud had not received by then. */
  asOf: string | null;
  ledgerStartedAt: string;
  firstEventAt: string | null;
  lifetime: UsageTotals;
  /** Everything before `from`: where a cumulative line starts. */
  before: UsageTotals;
  days: UsageDay[];
  sources: UsageSource[];
  /** Events of this computer that have not reached the Cloud yet. */
  unsentHere: number;
  runtimeId: string;
  error?: string;
}

interface CloudTotals extends UsageTotals { firstEventAt?: string | null }
interface CloudSummary { asOf: string; lifetime: CloudTotals; sources: Array<UsageTotals & { executionHostId: string; source: "host" | "local"; name: string | null; lastEventAt: string }> }
interface CloudActivity { buckets: Array<UsageTotals & { start: string }>; before: UsageTotals }

const earliest = (...values: Array<string | null | undefined>): string | null =>
  values.filter((value): value is string => Boolean(value)).sort()[0] ?? null;

/** The Usage page's numbers, put together in the process that holds the account token: the
 * Cloud's totals as of one moment, plus this computer's events the Cloud had not received by
 * then, so nothing counts twice. Sending first makes that remainder small. */
export async function usageOverview(input: { ledger: UsageLedger; outbox?: UsageOutbox; cloudUrl?: string; accountId?: string;
  token?: () => Promise<string>; timeZone: unknown; now?: Date; fetchImpl?: typeof fetch }): Promise<UsageOverview> {
  const { ledger } = input;
  const timeZone = knownTimeZone(input.timeZone);
  const now = input.now ?? new Date();
  const to = localDate(now, timeZone), from = dateBefore(to, OVERVIEW_DAYS);
  const base = { timeZone, from, to, ledgerStartedAt: ledger.startedAt, runtimeId: ledger.runtimeId };
  const here = (accountId?: string) => {
    const local = ledger.quarters(accountId ? { accountId } : {});
    const { days, before } = daysFromQuarters(local.quarters, timeZone, from);
    const lifetime = local.quarters.reduce((total, quarter) => addTotals(total, quarter), emptyTotals());
    return { days, before, lifetime, firstEventAt: local.firstEventAt,
      sources: lifetime.requests ? [{ id: ledger.runtimeId, kind: "local" as const, name: null, here: true, totalTokens: lifetime.totalTokens }] : [] };
  };
  if (!input.accountId || !input.cloudUrl || !input.token) return { state: "local", asOf: null, ...base, ...here(), unsentHere: 0 };

  await input.outbox?.flush(3_000, true).catch(() => undefined);
  const unsentHere = ledger.pendingCount(input.accountId);
  try {
    const token = await input.token();
    const get = async <T>(path: string): Promise<T> => {
      const response = await (input.fetchImpl ?? fetch)(`${input.cloudUrl}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`The Cloud answered HTTP ${response.status}.`);
      return await response.json() as T;
    };
    const summary = await get<CloudSummary>(`/v1/usage/summary?from=${encodeURIComponent(new Date(now.getTime() - (OVERVIEW_DAYS + 1) * 86_400_000).toISOString())}&to=${encodeURIComponent(now.toISOString())}`);
    const zone = zoneSegments(timeZone, from, to);
    const activity = await get<CloudActivity>(`/v1/usage/activity?zone=${encodeURIComponent(zone.segments.map(segment => `${new Date(segment.start).toISOString()}~${segment.offsetMinutes}`).join(","))}`
      + `&end=${encodeURIComponent(new Date(zone.end).toISOString())}&granularity=day&asOf=${encodeURIComponent(summary.asOf)}`);
    // What this computer ran that the Cloud's numbers above do not include yet.
    const extra = ledger.quarters({ accountId: input.accountId, missingFromCloudAt: summary.asOf });
    const missing = daysFromQuarters(extra.quarters, timeZone, from);
    const missingTotal = extra.quarters.reduce((total, quarter) => addTotals(total, quarter), emptyTotals());
    const sources: UsageSource[] = summary.sources.map(source => ({ id: source.executionHostId, kind: source.source, name: source.name,
      here: source.executionHostId === ledger.runtimeId, totalTokens: source.totalTokens, lastEventAt: source.lastEventAt }));
    if (missingTotal.requests) {
      const mine = sources.find(source => source.here);
      if (mine) mine.totalTokens += missingTotal.totalTokens;
      else sources.unshift({ id: ledger.runtimeId, kind: "local", name: null, here: true, totalTokens: missingTotal.totalTokens });
    }
    return {
      state: "cloud", ...base, asOf: summary.asOf, firstEventAt: earliest(summary.lifetime.firstEventAt, extra.firstEventAt),
      lifetime: addTotals(addTotals(emptyTotals(), summary.lifetime), missingTotal),
      before: addTotals(addTotals(emptyTotals(), activity.before), missing.before),
      days: mergeDays(activity.buckets.map(({ start, ...totals }) => ({ date: start, ...totals })), missing.days),
      sources, unsentHere
    };
  } catch (error) {
    return { state: "offline", asOf: null, ...base, ...here(input.accountId), unsentHere, error: error instanceof Error ? error.message : String(error) };
  }
}
