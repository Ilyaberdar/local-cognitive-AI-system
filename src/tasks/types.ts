export type TaskStatus =
  | "todo"
  | "in_progress"
  | "backlog"
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export type TaskPriority = "low" | "normal" | "high";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  workflowId: string;
  workflowVersion?: number;
  sessionId?: string;
  lastRunId?: string;
  scheduledFor?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  title: string;
  description: string;
  workflowId: string;
  priority?: TaskPriority;
  scheduledFor?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskRecord {
  tasks: Task[];
}
