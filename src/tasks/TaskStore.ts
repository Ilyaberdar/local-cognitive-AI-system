import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { CreateTaskInput, Task, TaskPriority, TaskRecord, TaskStatus } from "./types";

const priorityRank: Record<TaskPriority, number> = {
  high: 3,
  normal: 2,
  low: 1
};

export class TaskStore {
  private readonly filePath: string;

  constructor(private readonly baseDir: string) {
    this.filePath = path.join(baseDir, "tasks.json");
  }

  async list(): Promise<Task[]> {
    const record = await this.read();
    return [...record.tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listQueued(): Promise<Task[]> {
    const record = await this.read();
    return record.tasks
      .filter((task) => task.status === "todo" || task.status === "queued")
      .sort((left, right) => {
        const priorityDiff = priorityRank[right.priority] - priorityRank[left.priority];

        return priorityDiff || left.createdAt.localeCompare(right.createdAt);
      });
  }

  async get(taskId: string): Promise<Task | null> {
    const record = await this.read();
    return record.tasks.find((task) => task.id === taskId) ?? null;
  }

  async create(input: CreateTaskInput): Promise<Task> {
    const record = await this.read();
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      title: input.title.trim(),
      description: input.description.trim(),
      status: "todo",
      priority: input.priority ?? "normal",
      workflowId: input.workflowId,
      sessionId: input.sessionId,
      scheduledFor: input.scheduledFor,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now
    };

    record.tasks.unshift(task);
    await this.write(record);
    return task;
  }

  async update(taskId: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Promise<Task | null> {
    const record = await this.read();
    const task = record.tasks.find((item) => item.id === taskId);

    if (!task) {
      return null;
    }

    Object.assign(task, {
      ...patch,
      updatedAt: new Date().toISOString()
    });
    await this.write(record);
    return task;
  }

  async setStatus(taskId: string, status: TaskStatus, extra?: Partial<Task>): Promise<Task | null> {
    return this.update(taskId, {
      ...extra,
      status
    });
  }

  async delete(taskId: string): Promise<boolean> {
    const record = await this.read();
    const initialLength = record.tasks.length;
    record.tasks = record.tasks.filter((task) => task.id !== taskId);

    if (record.tasks.length === initialLength) {
      return false;
    }

    await this.write(record);
    return true;
  }

  private async read(): Promise<TaskRecord> {
    await fs.mkdir(this.baseDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<TaskRecord>;
      return {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : []
      };
    } catch {
      const initial = { tasks: [] };
      await this.write(initial);
      return initial;
    }
  }

  private async write(record: TaskRecord): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(record, null, 2), "utf8");
  }
}
