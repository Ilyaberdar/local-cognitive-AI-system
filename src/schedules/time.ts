import type { ScheduleWeekday } from "./types";

export class ScheduleTimeError extends Error {}

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export const normalizeDailyTime = (value: string): string => {
  const normalized = value.trim();

  if (!timePattern.test(normalized)) {
    throw new ScheduleTimeError("Field 'time' must use 24-hour HH:mm format.");
  }

  return normalized;
};

export const normalizeWeekday = (value: unknown): ScheduleWeekday => {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > 6) {
    throw new ScheduleTimeError("Field 'weekday' must be an integer from 0 (Sunday) to 6 (Saturday).");
  }

  return value as ScheduleWeekday;
};

export const normalizeTimeZone = (value: string): string => {
  const normalized = value.trim();

  if (!normalized) {
    throw new ScheduleTimeError("Field 'timezone' must be a valid IANA timezone.");
  }

  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: normalized }).resolvedOptions().timeZone;
  } catch {
    throw new ScheduleTimeError("Field 'timezone' must be a valid IANA timezone.");
  }
};

/**
 * Returns the next future occurrence of a daily local time. A skipped local
 * time during a daylight-saving transition is skipped until the next day.
 */
export const nextDailyOccurrence = (after: Date, time: string, timezone: string): Date => {
  return nextOccurrence(after, time, timezone, () => true);
};

/** Returns the next future occurrence of a weekly local day and time. */
export const nextWeeklyOccurrence = (
  after: Date,
  weekday: ScheduleWeekday | number,
  time: string,
  timezone: string
): Date => {
  const normalizedWeekday = normalizeWeekday(weekday);

  return nextOccurrence(
    after,
    time,
    timezone,
    (date) => date.getUTCDay() === normalizedWeekday
  );
};

const nextOccurrence = (
  after: Date,
  time: string,
  timezone: string,
  matchesDate: (date: Date) => boolean
): Date => {
  const normalizedTime = normalizeDailyTime(time);
  const normalizedTimeZone = normalizeTimeZone(timezone);
  const [hour, minute] = normalizedTime.split(":").map(Number);
  const localNow = getLocalParts(after, normalizedTimeZone);

  for (let dayOffset = 0; dayOffset <= 370; dayOffset += 1) {
    const date = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day + dayOffset));

    if (!matchesDate(date)) {
      continue;
    }

    const candidate = zonedDateTimeToUtc({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour,
      minute,
      second: 0
    }, normalizedTimeZone);

    if (candidate && candidate.getTime() > after.getTime()) {
      return candidate;
    }
  }

  throw new ScheduleTimeError("Could not calculate the next scheduled run.");
};

const getFormatter = (timezone: string): Intl.DateTimeFormat => {
  const cached = formatterCache.get(timezone);

  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  formatterCache.set(timezone, formatter);
  return formatter;
};

const getLocalParts = (date: Date, timezone: string): LocalDateTimeParts => {
  const parts = getFormatter(timezone).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  ) as Record<string, number>;

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second
  };
};

const zonedDateTimeToUtc = (target: LocalDateTimeParts, timezone: string): Date | null => {
  const targetAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second
  );
  let candidateMs = targetAsUtc;

  // Re-evaluate the offset because the first estimate can cross a DST change.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = getLocalParts(new Date(candidateMs), timezone);
    const offsetMs = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second
    ) - candidateMs;
    const nextCandidateMs = targetAsUtc - offsetMs;

    if (nextCandidateMs === candidateMs) {
      break;
    }

    candidateMs = nextCandidateMs;
  }

  const resolved = getLocalParts(new Date(candidateMs), timezone);
  const matches =
    resolved.year === target.year &&
    resolved.month === target.month &&
    resolved.day === target.day &&
    resolved.hour === target.hour &&
    resolved.minute === target.minute &&
    resolved.second === target.second;

  return matches ? new Date(candidateMs) : null;
};
