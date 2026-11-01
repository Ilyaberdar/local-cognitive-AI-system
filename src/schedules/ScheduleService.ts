import { CreateTaskInput, Task, TaskPriority } from "../tasks/types";
import { TaskService } from "../tasks/TaskService";
import { ScheduleStore } from "./ScheduleStore";
import { WorkspaceResolver } from "../workspace/WorkspaceResolver";
import { withFileLock } from "../utils/fileStore";
import {
  isWithinIntervalHours,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  nextDailyOccurrence,
  nextIntervalOccurrence,
  nextWeeklyOccurrence,
  normalizeDailyTime,
  normalizeTimeZone,
  normalizeWeekday as normalizeScheduleWeekday
} from "./time";
import {
  CreateScheduleInput,
  Schedule,
  ScheduleDispatchResult,
  ScheduleFrequency,
  ScheduleRule,
  ScheduleWeekday,
  UpdateScheduleInput
} from "./types";

type ScheduledTaskService = Pick<
  TaskService,
  "create" | "findByScheduleOccurrence" | "runTask"
> & Partial<Pick<TaskService, "hasActiveRun">>;

/** A run that starts later than this after its time was missed (sleep, a closed app, a long run). */
const LATE_MS = 90_000;

const taskPriorities = new Set<TaskPriority>(["low", "normal", "high"]);
const scheduleFrequencies = new Set<ScheduleFrequency>(["daily", "weekly", "interval"]);
const runnableRecoveredTaskStatuses = new Set<Task["status"]>([
  "todo",
  "queued",
  "backlog",
  "in_progress",
  "running"
]);

export class ScheduleValidationError extends Error {}

export class ScheduleService {
  constructor(
    private readonly scheduleStore: ScheduleStore,
    private readonly taskService: ScheduledTaskService,
    private readonly workspaceResolver?: Pick<WorkspaceResolver, "forTask">,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async list(): Promise<Schedule[]> {
    return this.scheduleStore.list();
  }

  async get(scheduleId: string): Promise<Schedule | null> {
    return this.scheduleStore.get(scheduleId);
  }

  async create(input: CreateScheduleInput, now = new Date()): Promise<Schedule> {
    const title = requireText(input.title, "title");
    const workflowId = requireText(input.workflowId, "workflowId");
    const time = normalizeTime(input.time);
    const timezone = normalizeTimezone(input.timezone);
    const frequency = normalizeFrequency(input.frequency);
    const weekday = frequency === "weekly" ? normalizeWeekday(input.weekday) : undefined;
    const interval = normalizeInterval(frequency, input, time);
    const projectId = normalizeProjectId(input.projectId);
    if (projectId) await this.workspaceResolver?.forTask({ id: "schedule-validation", projectId });

    return this.scheduleStore.create({
      title,
      description: normalizeText(input.description),
      workflowId,
      priority: normalizePriority(input.priority),
      sessionId: optionalText(input.sessionId),
      projectId,
      accessMode: normalizeAccessMode(input.accessMode),
      metadata: input.metadata,
      frequency,
      weekday,
      ...interval,
      time,
      timezone,
      enabled: input.enabled ?? true,
      nextRunAt: nextScheduledOccurrence(now, { frequency, weekday, ...interval, time, timezone }).toISOString()
    });
  }

  /** The next runs a schedule with these fields would make, without saving it. */
  preview(input: Pick<CreateScheduleInput, "frequency" | "weekday" | "intervalMinutes" | "windowEnd" | "weekdays" | "time" | "timezone">, now = new Date(), count = 5): string[] {
    const time = normalizeTime(input.time);
    const timezone = normalizeTimezone(input.timezone);
    const frequency = normalizeFrequency(input.frequency);
    const weekday = frequency === "weekly" ? normalizeWeekday(input.weekday) : undefined;
    const rule: ScheduleRule = { frequency, weekday, ...normalizeInterval(frequency, input, time), time, timezone };
    const runs: string[] = [];
    for (let after = now; runs.length < Math.min(Math.max(count, 1), 20);) {
      after = nextScheduledOccurrence(after, rule);
      runs.push(after.toISOString());
    }
    return runs;
  }

  async update(
    scheduleId: string,
    input: UpdateScheduleInput,
    now = new Date()
  ): Promise<Schedule | null> {
    const current = await this.scheduleStore.get(scheduleId);

    if (!current) {
      return null;
    }
    const projectId = input.projectId === undefined ? current.projectId : normalizeProjectId(input.projectId);
    if (input.projectId !== undefined && projectId) await this.workspaceResolver?.forTask({ id: "schedule-validation", projectId });

    const time = input.time === undefined ? current.time : normalizeTime(input.time);
    const timezone = input.timezone === undefined ? current.timezone : normalizeTimezone(input.timezone);
    const frequency = input.frequency === undefined ? current.frequency : normalizeFrequency(input.frequency);
    const weekday = frequency === "weekly"
      ? normalizeWeekday(input.weekday === undefined ? current.weekday : input.weekday)
      : undefined;
    const interval = normalizeInterval(frequency, {
      intervalMinutes: input.intervalMinutes ?? current.intervalMinutes,
      windowEnd: input.windowEnd === undefined ? current.windowEnd : input.windowEnd,
      weekdays: input.weekdays === undefined ? current.weekdays : input.weekdays
    }, time);
    const enabled = input.enabled === undefined ? current.enabled : input.enabled;
    const resetNextRun =
      time !== current.time ||
      timezone !== current.timezone ||
      frequency !== current.frequency ||
      weekday !== current.weekday ||
      interval.intervalMinutes !== current.intervalMinutes ||
      interval.windowEnd !== current.windowEnd ||
      String(interval.weekdays ?? "") !== String(current.weekdays ?? "") ||
      (enabled && !current.enabled);

    return this.scheduleStore.update(scheduleId, {
      ...(input.title === undefined ? {} : { title: requireText(input.title, "title") }),
      ...(input.description === undefined ? {} : { description: normalizeText(input.description) }),
      ...(input.workflowId === undefined ? {} : { workflowId: requireText(input.workflowId, "workflowId") }),
      ...(input.priority === undefined ? {} : { priority: normalizePriority(input.priority) }),
      ...(input.sessionId === undefined ? {} : { sessionId: optionalText(input.sessionId) }),
      ...(input.projectId === undefined ? {} : { projectId }),
      ...(input.accessMode === undefined ? {} : { accessMode: normalizeAccessMode(input.accessMode) }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      frequency,
      weekday,
      ...interval,
      ...(input.time === undefined ? {} : { time }),
      ...(input.timezone === undefined ? {} : { timezone }),
      ...(input.enabled === undefined ? {} : { enabled }),
      ...(resetNextRun
        ? {
          nextRunAt: nextScheduledOccurrence(now, { frequency, weekday, ...interval, time, timezone }).toISOString(),
          lastError: undefined, skippedRuns: undefined, lastSkippedAt: undefined
        }
        : {})
    });
  }

  async delete(scheduleId: string): Promise<boolean> {
    return this.scheduleStore.delete(scheduleId);
  }

  /**
   * Dispatches each due schedule once. If the app was offline, it performs one
   * catch-up run and then moves the schedule to the next future occurrence.
   * An interval schedule makes that catch-up run only within its hours, and is
   * left out while its previous run is still going.
   */
  async runDue(now = new Date()): Promise<ScheduleDispatchResult[]> {
    const schedules = await this.scheduleStore.list();
    const dispatches: Schedule[] = [];
    const results: ScheduleDispatchResult[] = [];

    for (const schedule of schedules) {
      if (schedule.activeOccurrenceAt) {
        dispatches.push(schedule);
        continue;
      }

      if (!schedule.enabled || !isDue(schedule, now)) {
        continue;
      }

      // One schedule that cannot be read (a file from a newer version, say) never stops the others.
      try {
        const nextRunAt = nextScheduledOccurrence(now, schedule).toISOString();

        if (schedule.frequency === "interval") {
          const late = now.getTime() - Date.parse(schedule.nextRunAt) > LATE_MS;
          if (late && !isWithinIntervalHours(now, intervalRule(schedule), schedule.timezone)) {
            await this.scheduleStore.skipOccurrence(schedule.id, schedule.nextRunAt, nextRunAt);
            continue;
          }
          if (schedule.lastTaskId && await this.taskService.hasActiveRun?.(schedule.lastTaskId)) {
            const skipped = await this.scheduleStore.skipOccurrence(schedule.id, schedule.nextRunAt, nextRunAt, { overlapping: true });
            results.push({ scheduleId: schedule.id, ...(skipped ? { taskId: schedule.lastTaskId, skipped: "overlapping_run" as const } : { skipped: "updated" as const }) });
            continue;
          }
        }

        const claimed = await this.scheduleStore.claimDispatch(schedule.id, schedule.nextRunAt, nextRunAt);

        if (claimed) {
          dispatches.push(claimed);
        } else {
          results.push({ scheduleId: schedule.id, skipped: "updated" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown_error";
        if (schedule.lastError !== message) {
          await this.scheduleStore.update(schedule.id, { lastError: message });
          results.push({ scheduleId: schedule.id, error: message });
        }
      }
    }

    // Claims are persisted before workflows run. Workflows stay serial because
    // the local runtime intentionally supports one active workflow at a time.
    for (const dispatch of dispatches) {
      const result = await this.dispatchClaim(dispatch, now);

      if (result) {
        results.push(result);
      }
    }

    return results;
  }

  private async dispatchClaim(
    claimedSchedule: Schedule,
    now: Date
  ): Promise<ScheduleDispatchResult | null> {
    return withFileLock(`schedule-occurrence:${claimedSchedule.id}:${claimedSchedule.activeOccurrenceAt}`, () =>
      this.dispatchClaimUnlocked(claimedSchedule, now));
  }

  private async dispatchClaimUnlocked(
    claimedSchedule: Schedule,
    now: Date
  ): Promise<ScheduleDispatchResult | null> {
    const schedule = await this.scheduleStore.get(claimedSchedule.id);
    const claimedOccurrenceAt = claimedSchedule.activeOccurrenceAt;

    if (!schedule || !claimedOccurrenceAt || schedule.activeOccurrenceAt !== claimedOccurrenceAt) {
      return { scheduleId: claimedSchedule.id, skipped: "updated" };
    }

    const occurrenceAt = schedule.activeOccurrenceAt;

    if (!occurrenceAt) {
      return { scheduleId: schedule.id, skipped: "updated" };
    }

    if (!schedule.enabled) {
      await this.completeDispatch(schedule, occurrenceAt, now, undefined, undefined, "Schedule was paused before dispatch.");
      return { scheduleId: schedule.id, skipped: "disabled" };
    }

    const existingTask = await this.taskService.findByScheduleOccurrence(schedule.id, occurrenceAt);

    if (existingTask) {
      return this.recoverExistingTask(schedule, occurrenceAt, existingTask, now);
    }

    try {
      const task = await this.taskService.create(schedule.activeTaskInput ?? this.toTaskInput(claimedSchedule, occurrenceAt));
      return this.runTask(schedule, occurrenceAt, task, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      await this.completeDispatch(schedule, occurrenceAt, now, undefined, undefined, message);

      return {
        scheduleId: schedule.id,
        error: message
      };
    }
  }

  private async recoverExistingTask(
    schedule: Schedule,
    occurrenceAt: string,
    task: Task,
    now: Date
  ): Promise<ScheduleDispatchResult> {
    if (runnableRecoveredTaskStatuses.has(task.status)) {
      return this.runTask(schedule, occurrenceAt, task, now);
    }

    const error = taskOutcomeError(task.status, task.lastRunId);
    await this.completeDispatch(schedule, occurrenceAt, now, task.id, task.lastRunId, error);

    return {
      scheduleId: schedule.id,
      taskId: task.id,
      runId: task.lastRunId,
      ...(error ? { error } : {})
    };
  }

  private async runTask(
    schedule: Schedule,
    occurrenceAt: string,
    task: Task,
    now: Date
  ): Promise<ScheduleDispatchResult> {
    try {
      const run = await this.taskService.runTask(task.id);
      const error = taskOutcomeError(run.task.status, run.runId);
      await this.completeDispatch(schedule, occurrenceAt, now, task.id, run.runId, error);

      return {
        scheduleId: schedule.id,
        taskId: task.id,
        runId: run.runId,
        ...(error ? { error } : {})
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      await this.completeDispatch(schedule, occurrenceAt, now, task.id, undefined, message);

      return {
        scheduleId: schedule.id,
        taskId: task.id,
        error: message
      };
    }
  }

  private async completeDispatch(
    schedule: Schedule,
    occurrenceAt: string,
    now: Date,
    taskId: string | undefined,
    runId: string | undefined,
    lastError: string | undefined
  ): Promise<void> {
    await this.scheduleStore.completeDispatch(schedule.id, {
      occurrenceAt,
      lastRunAt: now.toISOString(),
      lastTaskId: taskId,
      lastError
    });
    // An interval schedule's times that passed while its own run went on are left out, so a run
    // longer than the interval is not followed by another at once.
    const finishedAt = new Date(Math.max(this.clock().getTime(), now.getTime()));
    await this.scheduleStore.advancePast(schedule.id, finishedAt.toISOString(), (current) =>
      current.frequency === "interval" ? nextScheduledOccurrence(finishedAt, current).toISOString() : undefined);
  }

  private toTaskInput(schedule: Schedule, occurrenceAt: string): CreateTaskInput {
    return {
      title: schedule.title,
      description: schedule.description,
      workflowId: schedule.workflowId,
      priority: schedule.priority,
      sessionId: schedule.sessionId,
      sourceSessionId: schedule.sessionId,
      projectId: schedule.projectId,
      accessMode: schedule.accessMode ?? "default",
      scheduledFor: occurrenceAt,
      metadata: {
        ...schedule.metadata,
        scheduleId: schedule.id,
        scheduleOccurrenceAt: occurrenceAt
      }
    };
  }
}

const requireText = (value: string, field: string): string => {
  const normalized = normalizeText(value);

  if (!normalized) {
    throw new ScheduleValidationError(`Field '${field}' must be a non-empty string.`);
  }

  return normalized;
};

const normalizeProjectId = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new ScheduleValidationError("Field 'projectId' must be a non-empty string or null.");
  return value.trim();
};

const normalizeAccessMode = (value: unknown): "ask" | "default" | "full" => {
  if (value === undefined) return "default";
  if (value !== "ask" && value !== "default" && value !== "full") throw new ScheduleValidationError("Field 'accessMode' must be ask, default, or full.");
  return value;
};

const optionalText = (value: string | undefined): string | undefined => {
  const normalized = value === undefined ? undefined : normalizeText(value);
  return normalized || undefined;
};

const normalizeText = (value: string): string => value.trim();

const normalizePriority = (value: TaskPriority | undefined): TaskPriority => {
  if (value === undefined) {
    return "normal";
  }

  if (!taskPriorities.has(value)) {
    throw new ScheduleValidationError("Field 'priority' must be low, normal, or high.");
  }

  return value;
};

const normalizeFrequency = (value: ScheduleFrequency | undefined): ScheduleFrequency => {
  if (value === undefined) {
    return "daily";
  }

  if (!scheduleFrequencies.has(value)) {
    throw new ScheduleValidationError("Field 'frequency' must be daily, weekly or interval.");
  }

  return value;
};

/** An interval schedule's own fields, checked; nothing for daily and weekly ones, which drop them. */
const normalizeInterval = (
  frequency: ScheduleFrequency,
  input: { intervalMinutes?: unknown; windowEnd?: unknown; weekdays?: unknown },
  time: string
): Pick<Schedule, "intervalMinutes" | "windowEnd" | "weekdays"> => {
  if (frequency !== "interval") return { intervalMinutes: undefined, windowEnd: undefined, weekdays: undefined };
  const minutes = input.intervalMinutes;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
    throw new ScheduleValidationError(`Field 'intervalMinutes' must be a whole number from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}.`);
  }
  let windowEnd: string | undefined;
  if (input.windowEnd !== undefined && input.windowEnd !== null) {
    if (typeof input.windowEnd !== "string") throw new ScheduleValidationError("Field 'windowEnd' must use 24-hour HH:mm format.");
    windowEnd = normalizeTime(input.windowEnd);
    if (windowEnd === time) throw new ScheduleValidationError("Field 'windowEnd' must differ from 'time'.");
  }
  let weekdays: ScheduleWeekday[] | undefined;
  if (input.weekdays !== undefined && input.weekdays !== null) {
    if (!Array.isArray(input.weekdays) || input.weekdays.length === 0) {
      throw new ScheduleValidationError("Field 'weekdays' must list at least one day, 0 (Sunday) to 6 (Saturday).");
    }
    const days = [...new Set(input.weekdays.map(normalizeWeekday))].sort((a, b) => a - b);
    weekdays = days.length === 7 ? undefined : days;
  }
  return { intervalMinutes: minutes, windowEnd, weekdays };
};

const normalizeWeekday = (value: unknown): ScheduleWeekday => {
  try {
    return normalizeScheduleWeekday(value);
  } catch (error) {
    throw new ScheduleValidationError(
      error instanceof Error ? error.message : "Field 'weekday' is invalid."
    );
  }
};

const normalizeTime = (value: string): string => {
  try {
    return normalizeDailyTime(value);
  } catch (error) {
    throw new ScheduleValidationError(
      error instanceof Error ? error.message : "Field 'time' is invalid."
    );
  }
};

const normalizeTimezone = (value: string): string => {
  try {
    return normalizeTimeZone(value);
  } catch (error) {
    throw new ScheduleValidationError(
      error instanceof Error ? error.message : "Field 'timezone' is invalid."
    );
  }
};

const isDue = (schedule: Schedule, now: Date): boolean => {
  const scheduledAt = Date.parse(schedule.nextRunAt);
  return Number.isFinite(scheduledAt) && scheduledAt <= now.getTime();
};

const intervalRule = (rule: ScheduleRule) => ({
  time: rule.time,
  intervalMinutes: rule.intervalMinutes ?? 0,
  windowEnd: rule.windowEnd,
  weekdays: rule.weekdays
});

const nextScheduledOccurrence = (after: Date, rule: ScheduleRule): Date => {
  switch (rule.frequency) {
    case "weekly": return nextWeeklyOccurrence(after, normalizeWeekday(rule.weekday), rule.time, rule.timezone);
    case "interval": return nextIntervalOccurrence(after, intervalRule(rule), rule.timezone);
    case "daily": return nextDailyOccurrence(after, rule.time, rule.timezone);
    default: throw new ScheduleValidationError(`This schedule repeats "${String(rule.frequency)}", which this version does not know. Update the app to run it.`);
  }
};

const taskOutcomeError = (status: Task["status"], runId: string | undefined): string | undefined => {
  // A run that waits for the owner's approval has not gone wrong: its task says what it waits for.
  if (status === "done" || status === "waiting") {
    return undefined;
  }

  const run = runId ? `Workflow run ${runId}` : "Scheduled task";
  return `${run} ended with task status "${status}".`;
};
