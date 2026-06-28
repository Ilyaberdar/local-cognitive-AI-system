import { TaskStore } from "./TaskStore";
import { CreateTaskInput, Task } from "./types";
import { WorkflowRunStore } from "../workflows/WorkflowRunStore";
import { WorkflowRunner } from "../workflows/WorkflowRunner";

export class TaskService {
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

  async update(taskId: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Promise<Task | null> {
    return this.taskStore.update(taskId, patch);
  }

  async delete(taskId: string): Promise<boolean> {
    return this.taskStore.delete(taskId);
  }

  async queue(taskId: string): Promise<Task | null> {
    return this.taskStore.setStatus(taskId, "todo");
  }

  async runTask(taskId: string): Promise<{ task: Task; runId: string }> {
    await this.queue(taskId);
    const run = await this.workflowRunner.startTask(taskId);
    const finalRun = await this.workflowRunner.runUntilStopped(run.id);
    const task = await this.requireTask(taskId);

    return {
      task,
      runId: finalRun.id
    };
  }

  async runNextQueued(): Promise<{ task: Task; runId: string } | null> {
    const [task] = await this.taskStore.listQueued();

    if (!task) {
      return null;
    }

    return this.runTask(task.id);
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
