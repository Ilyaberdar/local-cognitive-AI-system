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

/** The calendar date `days` days before a date. */
export const dateBefore = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

const partFormatters = new Map<string, Intl.DateTimeFormat>();
/** The zone's offset from UTC, in minutes, at an instant. */
export const offsetAt = (instant: number, timeZone: string): number => {
  let format = partFormatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (partFormatters.size < 50) partFormatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return Math.round((local - Math.floor(instant / 1000) * 1000) / 60_000);
};

/** The instant a calendar date begins in a zone. */
export const zoneMidnight = (date: string, timeZone: string): number => {
  const utc = Date.parse(`${date}T00:00:00Z`);
  const guess = utc - offsetAt(utc, timeZone) * 60_000;
  return utc - offsetAt(guess, timeZone) * 60_000;
};

/** The zone over [from, to] (calendar dates) as UTC offsets from the instants they start, with the
 * exact minute of each change (daylight saving time). The Cloud groups by these, so it needs to
 * know no zone names: its database may lack names this platform uses (Europe/Kiev, say). */
export const zoneSegments = (timeZone: string, from: string, to: string): { segments: Array<{ start: number; offsetMinutes: number }>; end: number } => {
  const STEP = 6 * 3_600_000;
  const start = zoneMidnight(from, timeZone), end = zoneMidnight(dateBefore(to, -1), timeZone);
  const segments = [{ start, offsetMinutes: offsetAt(start, timeZone) }];
  for (let at = start; at < end; at += STEP) {
    const current = segments.at(-1)!.offsetMinutes, next = Math.min(at + STEP, end);
    if (offsetAt(next, timeZone) === current) continue;
    let low = at, high = next;
    while (high - low > 60_000) { const middle = low + Math.floor((high - low) / 120_000) * 60_000; if (offsetAt(middle, timeZone) === current) low = middle; else high = middle; }
    segments.push({ start: high, offsetMinutes: offsetAt(high, timeZone) });
  }
  return { segments, end };
};
