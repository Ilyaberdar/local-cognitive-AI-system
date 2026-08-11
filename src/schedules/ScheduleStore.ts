import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { Schedule, ScheduleRecord } from "./types";

export interface CompleteScheduleDispatchPatch {
  occurrenceAt: string;
  lastRunAt: string;
  lastTaskId?: string;
  lastError?: string;
}

export class ScheduleStore {
  private readonly filePath: string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly baseDir: string) {
    this.filePath = path.join(baseDir, "schedules.json");
  }

  async list(): Promise<Schedule[]> {
    return this.serialize(async () => {
      const record = await this.read();
      return [...record.schedules].sort((left, right) =>
        left.nextRunAt.localeCompare(right.nextRunAt) || left.createdAt.localeCompare(right.createdAt)
      );
    });
  }

  async get(scheduleId: string): Promise<Schedule | null> {
    return this.serialize(async () => {
      const record = await this.read();
      return record.schedules.find((schedule) => schedule.id === scheduleId) ?? null;
    });
  }

  async create(input: Omit<Schedule, "id" | "createdAt" | "updatedAt">): Promise<Schedule> {
    return this.serialize(async () => {
      const record = await this.read();
      const now = new Date().toISOString();
      const schedule: Schedule = {
        id: randomUUID(),
        ...input,
        createdAt: now,
        updatedAt: now
      };

      record.schedules.push(schedule);
      await this.write(record);
      return schedule;
    });
  }

  async update(
    scheduleId: string,
    patch: Partial<Omit<Schedule, "id" | "createdAt">>
  ): Promise<Schedule | null> {
    return this.serialize(async () => {
      const record = await this.read();
      const schedule = record.schedules.find((item) => item.id === scheduleId);

      if (!schedule) {
        return null;
      }

      Object.assign(schedule, {
        ...patch,
        updatedAt: new Date().toISOString()
      });
      await this.write(record);
      return schedule;
    });
  }

  async delete(scheduleId: string): Promise<boolean> {
    return this.serialize(async () => {
      const record = await this.read();
      const initialLength = record.schedules.length;
      record.schedules = record.schedules.filter((schedule) => schedule.id !== scheduleId);

      if (record.schedules.length === initialLength) {
        return false;
      }

      await this.write(record);
      return true;
    });
  }

  /**
   * Persists ownership of an occurrence before creating its task. A restart
   * can recover this claim without creating a second task for the same slot.
   */
  async claimDispatch(
    scheduleId: string,
    occurrenceAt: string,
    nextRunAt: string
  ): Promise<Schedule | null> {
    return this.serialize(async () => {
      const record = await this.read();
      const schedule = record.schedules.find((item) => item.id === scheduleId);

      if (
        !schedule ||
        !schedule.enabled ||
        schedule.activeOccurrenceAt ||
        schedule.nextRunAt !== occurrenceAt
      ) {
        return null;
      }

      Object.assign(schedule, {
        activeOccurrenceAt: occurrenceAt,
        nextRunAt,
        updatedAt: new Date().toISOString()
      });
      await this.write(record);
      return schedule;
    });
  }

  /**
   * Completes only the occurrence held by this claim. A user's later schedule
   * edit can therefore update nextRunAt without being overwritten by a slow run.
   */
  async completeDispatch(
    scheduleId: string,
    patch: CompleteScheduleDispatchPatch
  ): Promise<Schedule | null> {
    return this.serialize(async () => {
      const record = await this.read();
      const schedule = record.schedules.find((item) => item.id === scheduleId);

      if (!schedule || schedule.activeOccurrenceAt !== patch.occurrenceAt) {
        return null;
      }

      Object.assign(schedule, {
        activeOccurrenceAt: undefined,
        lastRunAt: patch.lastRunAt,
        lastTaskId: patch.lastTaskId,
        lastError: patch.lastError,
        updatedAt: new Date().toISOString()
      });
      await this.write(record);
      return schedule;
    });
  }

  private async read(): Promise<ScheduleRecord> {
    await fs.mkdir(this.baseDir, { recursive: true });

    let raw: string;

    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }

      const initial = { schedules: [] };
      await this.write(initial);
      return initial;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<ScheduleRecord>;

      if (!Array.isArray(parsed.schedules)) {
        throw new Error("Expected a schedules array.");
      }

      return {
        schedules: parsed.schedules
      };
    } catch (error) {
      throw new Error(
        `Could not parse schedule store at ${this.filePath}: ${error instanceof Error ? error.message : "invalid JSON"}`
      );
    }
  }

  private async write(record: ScheduleRecord): Promise<void> {
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
