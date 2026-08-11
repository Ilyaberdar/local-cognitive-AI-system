import { TaskPriority } from "../tasks/types";

export interface Schedule {
  id: string;
  title: string;
  description: string;
  workflowId: string;
  priority: TaskPriority;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  frequency: "daily";
  time: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string;
  activeOccurrenceAt?: string;
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
  metadata?: Record<string, unknown>;
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
  metadata?: Record<string, unknown>;
  time?: string;
  timezone?: string;
  enabled?: boolean;
}

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
