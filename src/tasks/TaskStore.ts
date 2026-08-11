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
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly baseDir: string) {
    this.filePath = path.join(baseDir, "tasks.json");
  }

  async list(): Promise<Task[]> {
    return this.serialize(async () => {
      const record = await this.read();
      return [...record.tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
  }

  async listQueued(): Promise<Task[]> {
    return this.serialize(async () => {
      const record = await this.read();
      return record.tasks
        .filter((task) => task.status === "todo" || task.status === "queued")
        .sort((left, right) => {
          const priorityDiff = priorityRank[right.priority] - priorityRank[left.priority];

          return priorityDiff || left.createdAt.localeCompare(right.createdAt);
        });
    });
  }

  async get(taskId: string): Promise<Task | null> {
    return this.serialize(async () => {
      const record = await this.read();
      return record.tasks.find((task) => task.id === taskId) ?? null;
    });
  }

  async findByScheduleOccurrence(scheduleId: string, occurrenceAt: string): Promise<Task | null> {
    return this.serialize(async () => {
      const record = await this.read();
      return record.tasks.find((task) => {
        const metadata = task.metadata;
        return (
          typeof metadata?.scheduleId === "string" &&
          metadata.scheduleId === scheduleId &&
          typeof metadata.scheduleOccurrenceAt === "string" &&
          metadata.scheduleOccurrenceAt === occurrenceAt
        );
      }) ?? null;
    });
  }

  async create(input: CreateTaskInput): Promise<Task> {
    return this.serialize(async () => {
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
    });
  }

  async update(taskId: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Promise<Task | null> {
    return this.serialize(async () => {
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
    });
  }

  async setStatus(taskId: string, status: TaskStatus, extra?: Partial<Task>): Promise<Task | null> {
    return this.update(taskId, {
      ...extra,
      status
    });
  }

  async delete(taskId: string): Promise<boolean> {
    return this.serialize(async () => {
      const record = await this.read();
      const initialLength = record.tasks.length;
      record.tasks = record.tasks.filter((task) => task.id !== taskId);

      if (record.tasks.length === initialLength) {
        return false;
      }

      await this.write(record);
      return true;
    });
  }

  private async read(): Promise<TaskRecord> {
    await fs.mkdir(this.baseDir, { recursive: true });

    let raw: string;

    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }

      const initial = { tasks: [] };
      await this.write(initial);
      return initial;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<TaskRecord>;

      if (!Array.isArray(parsed.tasks)) {
        throw new Error("Expected a tasks array.");
      }

      return { tasks: parsed.tasks };
    } catch (error) {
      throw new Error(
        `Could not parse task store at ${this.filePath}: ${error instanceof Error ? error.message : "invalid JSON"}`
      );
    }
  }

  private async write(record: TaskRecord): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(record, null, 2), "utf8");
    await fs.rename(temporaryPath, this.filePath);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

const isMissingFile = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
