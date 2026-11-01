import { CreateTaskInput, TaskPriority } from "../tasks/types";
import { SubagentAccessMode } from "../types";

export type ScheduleFrequency = "daily" | "weekly" | "interval";
export type ScheduleWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface Schedule {
  id: string;
  title: string;
  description: string;
  workflowId: string;
  priority: TaskPriority;
  sessionId?: string;
  projectId?: string;
  accessMode?: SubagentAccessMode;
  metadata?: Record<string, unknown>;
  frequency: ScheduleFrequency;
  /** Sunday is 0 and Saturday is 6. Required when frequency is weekly. */
  weekday?: ScheduleWeekday;
  /** Every this many minutes (5 to 1440), when frequency is interval: `time` is then each day's first
   * run, the start of the hours it runs in. */
  intervalMinutes?: number;
  /** The last time of day an interval schedule may run (HH:mm, inclusive); absent, it runs all day
   * from `time`. Earlier than `time`, the hours cross midnight and belong to the day they start. */
  windowEnd?: string;
  /** The days an interval schedule runs, Sunday 0 to Saturday 6; absent, every day. */
  weekdays?: ScheduleWeekday[];
  time: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string;
  /** Times in a row an interval schedule was left out because its previous run was still going. */
  skippedRuns?: number;
  lastSkippedAt?: string;
  activeOccurrenceAt?: string;
  activeTaskInput?: CreateTaskInput;
  lastRunAt?: string;
  lastTaskId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduleInput {
  title: string;
  description: string;
  workflowId: string;
  priority?: TaskPriority;
  sessionId?: string;
  projectId?: string;
  accessMode?: SubagentAccessMode;
  metadata?: Record<string, unknown>;
  frequency?: ScheduleFrequency;
  weekday?: ScheduleWeekday;
  intervalMinutes?: number;
  windowEnd?: string | null;
  weekdays?: ScheduleWeekday[] | null;
  time: string;
  timezone: string;
  enabled?: boolean;
}

export interface UpdateScheduleInput {
  title?: string;
  description?: string;
  workflowId?: string;
  priority?: TaskPriority;
  sessionId?: string;
  projectId?: string | null;
  accessMode?: SubagentAccessMode;
  metadata?: Record<string, unknown>;
  frequency?: ScheduleFrequency;
  weekday?: ScheduleWeekday;
  intervalMinutes?: number;
  /** null: all day. */
  windowEnd?: string | null;
  /** null: every day. */
  weekdays?: ScheduleWeekday[] | null;
  time?: string;
  timezone?: string;
  enabled?: boolean;
}

/** What decides when a schedule runs. */
export type ScheduleRule = Pick<Schedule, "frequency" | "weekday" | "intervalMinutes" | "windowEnd" | "weekdays" | "time" | "timezone">;

export interface ScheduleRecord {
  schedules: Schedule[];
}

export interface ScheduleDispatchResult {
  scheduleId: string;
  taskId?: string;
  runId?: string;
  error?: string;
  skipped?: "disabled" | "overlapping_run" | "updated";
}
