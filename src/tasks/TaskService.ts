import { TaskStore } from "./TaskStore";
import { CreateTaskInput, Task, TaskValidationError, UpdateTaskInput } from "./types";
import { WorkflowRunStore } from "../workflows/WorkflowRunStore";
import { WorkflowRunner } from "../workflows/WorkflowRunner";
import { withFileLock } from "../utils/fileStore";
import { WorkspaceResolver } from "../workspace/WorkspaceResolver";

export class TaskService {
  private static readonly active = new Map<string, Promise<{ task: Task; runId: string }>>();
  constructor(
    private readonly taskStore: TaskStore,
    private readonly runStore: WorkflowRunStore,
    private readonly workflowRunner: WorkflowRunner,
    private readonly workspaceResolver?: Pick<WorkspaceResolver, "forTask">
  ) {}

  async create(input: CreateTaskInput): Promise<Task> {
    validateExecutionInput(input);
    if (input.projectId) await this.workspaceResolver?.forTask({ id: "validation", projectId: input.projectId });
    return this.taskStore.create({ ...input, accessMode: input.accessMode ?? "default" });
  }

  async list(): Promise<Task[]> {
    return this.taskStore.list();
  }

  async get(taskId: string): Promise<Task | null> {
    return this.taskStore.get(taskId);
  }

  async findByScheduleOccurrence(scheduleId: string, occurrenceAt: string): Promise<Task | null> {
    return this.taskStore.findByScheduleOccurrence(scheduleId, occurrenceAt);
  }

  async update(taskId: string, patch: UpdateTaskInput): Promise<Task | null> {
    return withFileLock(`workflow-task:${taskId}`, async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) return null;
      validateExecutionInput(patch);
      const run = task.lastRunId ? await this.runStore.getRun(task.lastRunId) : null;
      const executionChanged = ["projectId", "accessMode", "workflowId", "workflowVersion", "attachments", "sessionId", "sourceSessionId"]
        .some((key) => Object.prototype.hasOwnProperty.call(patch, key));
      if (executionChanged && run && ["queued", "running", "waiting", "interrupted"].includes(run.status)) {
        throw new TaskValidationError("Cancel or finish this task before changing its workspace or execution settings.", 409);
      }
      if (patch.projectId) await this.workspaceResolver?.forTask({ id: taskId, projectId: patch.projectId });
      const normalized = { ...patch, ...(Object.prototype.hasOwnProperty.call(patch, "projectId") ? { projectId: patch.projectId ?? undefined } : {}) };
      return this.taskStore.update(taskId, normalized as Partial<Omit<Task, "id" | "createdAt">>);
    });
  }

  async getWorkspace(taskId: string) {
    const task = await this.requireTask(taskId);
    if (task.lastRunId) {
      const run = await this.runStore.getRun(task.lastRunId);
      if (run?.workspace && ["queued", "running", "waiting", "interrupted"].includes(run.status)) return run.workspace;
    }
    if (!this.workspaceResolver) throw new Error("Task workspaces are unavailable.");
    return this.workspaceResolver.forTask(task);
  }

  async delete(taskId: string): Promise<boolean> {
    return withFileLock(`workflow-task:${taskId}`, async () => {
      const task = await this.taskStore.get(taskId);
      const run = task?.lastRunId ? await this.runStore.getRun(task.lastRunId) : null;
      if (TaskService.active.has(taskId) || (run && ["queued", "running", "waiting", "interrupted"].includes(run.status))) {
        throw new Error("Cancel or finish this task before deleting it.");
      }
      return this.taskStore.delete(taskId);
    });
  }

  async queue(taskId: string): Promise<Task | null> {
    return withFileLock(`workflow-task:${taskId}`, async () => {
      const task = await this.taskStore.get(taskId);
      const run = task?.lastRunId ? await this.runStore.getRun(task.lastRunId) : null;
      if (run && ["queued", "running", "waiting", "interrupted"].includes(run.status)) {
        throw new TaskValidationError("Cancel or finish the active run before queueing this task.", 409);
      }
      return this.taskStore.setStatus(taskId, "todo");
    });
  }

  runTask(taskId: string): Promise<{ task: Task; runId: string }> {
    const existing = TaskService.active.get(taskId);
    if (existing) return existing;
    const operation = this.executeTask(taskId).finally(() => TaskService.active.delete(taskId));
    TaskService.active.set(taskId, operation);
    return operation;
  }

  private async executeTask(taskId: string): Promise<{ task: Task; runId: string }> {
    const run = await this.workflowRunner.startTask(taskId);
    const finalRun = await this.workflowRunner.runUntilStopped(run.id);
    const task = await this.requireTask(taskId);

    return {
      task,
      runId: finalRun.id
    };
  }

  async runNextQueued(): Promise<{ task: Task; runId: string } | null> {
    const claimed = await withFileLock("workflow-queue", async () => {
      const task = (await this.taskStore.listQueued()).find((item) => !TaskService.active.has(item.id));
      return task ? { work: this.runTask(task.id) } : null;
    });
    return claimed ? claimed.work : null;
  }

  async startTask(taskId: string): Promise<{ task: Task; runId: string }> {
    const run = await this.workflowRunner.startTask(taskId);
    this.workflowRunner.runInBackground(run.id);
    return { task: await this.requireTask(taskId), runId: run.id };
  }

  async startNextQueued(): Promise<{ task: Task; runId: string } | null> {
    return withFileLock("workflow-queue", async () => {
      const task = (await this.taskStore.listQueued()).find((item) => !TaskService.active.has(item.id));
      return task ? this.startTask(task.id) : null;
    });
  }

  async getRunDetail(runId: string) {
    const [run, nodeRuns] = await Promise.all([
      this.runStore.getRun(runId),
      this.runStore.listNodeRuns(runId)
    ]);

    return run ? { run, nodeRuns } : null;
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.taskStore.get(taskId);

    if (!task) {
      throw new Error(`Task "${taskId}" was not found.`);
    }

    return task;
  }
}

const validateExecutionInput = (input: { projectId?: string | null; accessMode?: unknown }): void => {
  if (input.projectId !== undefined && input.projectId !== null && (typeof input.projectId !== "string" || !input.projectId.trim())) {
    throw new TaskValidationError("Field 'projectId' must be a non-empty string or null.");
  }
  if (input.accessMode !== undefined && !["ask", "default", "full"].includes(String(input.accessMode))) {
    throw new TaskValidationError("Field 'accessMode' must be ask, default, or full.");
  }
};
