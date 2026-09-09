import { TaskStore } from "./TaskStore";
import { CreateTaskInput, Task } from "./types";
import { WorkflowRunStore } from "../workflows/WorkflowRunStore";
import { WorkflowRunner } from "../workflows/WorkflowRunner";
import { withFileLock } from "../utils/fileStore";

export class TaskService {
  private static readonly active = new Map<string, Promise<{ task: Task; runId: string }>>();
  constructor(
    private readonly taskStore: TaskStore,
    private readonly runStore: WorkflowRunStore,
    private readonly workflowRunner: WorkflowRunner
  ) {}

  async create(input: CreateTaskInput): Promise<Task> {
    return this.taskStore.create(input);
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

  async update(taskId: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Promise<Task | null> {
    return this.taskStore.update(taskId, patch);
  }

  async delete(taskId: string): Promise<boolean> {
    return withFileLock(`workflow-task:${taskId}`, async () => {
      const task = await this.taskStore.get(taskId);
      const run = task?.lastRunId ? await this.runStore.getRun(task.lastRunId) : null;
      if (TaskService.active.has(taskId) || (run && ["queued", "running", "waiting"].includes(run.status))) {
        throw new Error("Cancel or finish this task before deleting it.");
      }
      return this.taskStore.delete(taskId);
    });
  }

  async queue(taskId: string): Promise<Task | null> {
    return this.taskStore.setStatus(taskId, "todo");
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
