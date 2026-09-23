import { ChatAttachment, SubagentAccessMode } from "../types";

export type TaskStatus =
  | "todo"
  | "in_progress"
  | "backlog"
  | "queued"
  | "running"
  | "waiting"
  | "interrupted"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export type TaskPriority = "low" | "normal" | "high";

export interface Task {
  attachments?: ChatAttachment[];
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  workflowId: string;
  workflowVersion?: number;
  sessionId?: string;
  /** Legacy provenance only. Execution always receives its own session. */
  sourceSessionId?: string;
  projectId?: string;
  accessMode?: SubagentAccessMode;
  lastRunId?: string;
  scheduledFor?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  attachments?: ChatAttachment[];
  title: string;
  description: string;
  workflowId: string;
  priority?: TaskPriority;
  scheduledFor?: string;
  sessionId?: string;
  sourceSessionId?: string;
  projectId?: string;
  accessMode?: SubagentAccessMode;
  metadata?: Record<string, unknown>;
}

export type UpdateTaskInput = Partial<Omit<Task, "id" | "createdAt" | "projectId">> & {
  /** Omitted leaves the binding intact; null returns to the task's managed workspace. */
  projectId?: string | null;
};

export class TaskValidationError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

export interface TaskRecord {
  tasks: Task[];
}
