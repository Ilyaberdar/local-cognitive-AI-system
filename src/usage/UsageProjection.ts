/** Token totals as the Usage page shows them: sums of reported counts only. A request answered or
 * cancelled without a report is counted apart, never as 0 tokens. */
export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  requestsWithoutUsage: number;
}
export interface UsageDay extends UsageTotals { date: string }
/** A ledger's events grouped by quarter hour (UTC): every time zone's day starts on one. */
export interface UsageQuarter extends UsageTotals { quarter: string }

const KEYS = ["requests", "inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens", "requestsWithoutUsage"] as const;

export const emptyTotals = (): UsageTotals => ({ requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, requestsWithoutUsage: 0 });

export const addTotals = <T extends UsageTotals>(target: T, source: Partial<UsageTotals>): T => {
  for (const key of KEYS) target[key] += Number(source[key] ?? 0) || 0;
  return target;
};

const formatters = new Map<string, Intl.DateTimeFormat>();
/** The calendar date (YYYY-MM-DD) of an instant in a time zone. */
export const localDate = (instant: string | Date, timeZone: string): string => {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    if (formatters.size < 50) formatters.set(timeZone, format);
  }
  return format.format(typeof instant === "string" ? new Date(instant) : instant);
};

/** A time zone this runtime knows, or UTC. */
export const knownTimeZone = (timeZone: unknown): string => {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 64) return "UTC";
  try { new Intl.DateTimeFormat("en-CA", { timeZone }); return timeZone; } catch { return "UTC"; }
};

/** Days of the zone from quarter-hour groups; days before `from` add to `before` instead. */
export const daysFromQuarters = (quarters: UsageQuarter[], timeZone: string, from?: string): { days: UsageDay[]; before: UsageTotals } => {
  const days = new Map<string, UsageDay>();
  const before = emptyTotals();
  for (const quarter of quarters) {
    const date = localDate(`${quarter.quarter}:00Z`, timeZone);
    if (from && date < from) { addTotals(before, quarter); continue; }
    const day = days.get(date) ?? { date, ...emptyTotals() };
    days.set(date, addTotals(day, quarter));
  }
  return { days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), before };
};

/** Days from several sources, each date once. */
export const mergeDays = (...lists: UsageDay[][]): UsageDay[] => {
  const days = new Map<string, UsageDay>();
  for (const list of lists) for (const item of list) {
    const day = days.get(item.date) ?? { date: item.date, ...emptyTotals() };
    days.set(item.date, addTotals(day, item));
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
};

export const sumDays = (days: UsageDay[]): UsageTotals => days.reduce((total, day) => addTotals(total, day), emptyTotals());

/** The calendar date `days` before (negative: after) a date. */
export const shiftDate = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
