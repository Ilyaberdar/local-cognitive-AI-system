import { CreateTaskInput, Task, TaskPriority } from "../tasks/types";
import { TaskService } from "../tasks/TaskService";
import { ScheduleStore } from "./ScheduleStore";
import {
  nextDailyOccurrence,
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
  ScheduleWeekday,
  UpdateScheduleInput
} from "./types";

type ScheduledTaskService = Pick<
  TaskService,
  "create" | "findByScheduleOccurrence" | "runTask"
>;

const taskPriorities = new Set<TaskPriority>(["low", "normal", "high"]);
const scheduleFrequencies = new Set<ScheduleFrequency>(["daily", "weekly"]);
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
    private readonly taskService: ScheduledTaskService
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

    return this.scheduleStore.create({
      title,
      description: normalizeText(input.description),
      workflowId,
      priority: normalizePriority(input.priority),
      sessionId: optionalText(input.sessionId),
      metadata: input.metadata,
      frequency,
      weekday,
      time,
      timezone,
      enabled: input.enabled ?? true,
      nextRunAt: nextScheduledOccurrence(now, frequency, weekday, time, timezone).toISOString()
    });
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

    const time = input.time === undefined ? current.time : normalizeTime(input.time);
    const timezone = input.timezone === undefined ? current.timezone : normalizeTimezone(input.timezone);
    const frequency = input.frequency === undefined ? current.frequency : normalizeFrequency(input.frequency);
    const weekday = frequency === "weekly"
      ? normalizeWeekday(input.weekday === undefined ? current.weekday : input.weekday)
      : undefined;
    const enabled = input.enabled === undefined ? current.enabled : input.enabled;
    const resetNextRun =
      time !== current.time ||
      timezone !== current.timezone ||
      frequency !== current.frequency ||
      weekday !== current.weekday ||
      (enabled && !current.enabled);

    return this.scheduleStore.update(scheduleId, {
      ...(input.title === undefined ? {} : { title: requireText(input.title, "title") }),
      ...(input.description === undefined ? {} : { description: normalizeText(input.description) }),
      ...(input.workflowId === undefined ? {} : { workflowId: requireText(input.workflowId, "workflowId") }),
      ...(input.priority === undefined ? {} : { priority: normalizePriority(input.priority) }),
      ...(input.sessionId === undefined ? {} : { sessionId: optionalText(input.sessionId) }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      frequency,
      weekday,
      ...(input.time === undefined ? {} : { time }),
      ...(input.timezone === undefined ? {} : { timezone }),
      ...(input.enabled === undefined ? {} : { enabled }),
      ...(resetNextRun
        ? { nextRunAt: nextScheduledOccurrence(now, frequency, weekday, time, timezone).toISOString(), lastError: undefined }
        : {})
    });
  }

  async delete(scheduleId: string): Promise<boolean> {
    return this.scheduleStore.delete(scheduleId);
  }

  /**
   * Dispatches each due schedule once. If the app was offline, it performs one
   * catch-up run and then moves the schedule to the next future occurrence.
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

      const claimed = await this.scheduleStore.claimDispatch(
        schedule.id,
        schedule.nextRunAt,
        nextScheduledOccurrence(
          now,
          schedule.frequency,
          schedule.weekday,
          schedule.time,
          schedule.timezone
        ).toISOString()
      );

      if (claimed) {
        dispatches.push(claimed);
      } else {
        results.push({ scheduleId: schedule.id, skipped: "updated" });
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
      const task = await this.taskService.create(this.toTaskInput(schedule, occurrenceAt));
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
  }

  private toTaskInput(schedule: Schedule, occurrenceAt: string): CreateTaskInput {
    return {
      title: schedule.title,
      description: schedule.description,
      workflowId: schedule.workflowId,
      priority: schedule.priority,
      sessionId: schedule.sessionId,
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
    throw new ScheduleValidationError("Field 'frequency' must be daily or weekly.");
  }

  return value;
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

const nextScheduledOccurrence = (
  after: Date,
  frequency: ScheduleFrequency,
  weekday: ScheduleWeekday | undefined,
  time: string,
  timezone: string
): Date => frequency === "weekly"
  ? nextWeeklyOccurrence(after, normalizeWeekday(weekday), time, timezone)
  : nextDailyOccurrence(after, time, timezone);

const taskOutcomeError = (status: Task["status"], runId: string | undefined): string | undefined => {
  if (status === "done") {
    return undefined;
  }

  const run = runId ? `Workflow run ${runId}` : "Scheduled task";
  return `${run} ended with task status "${status}".`;
};
