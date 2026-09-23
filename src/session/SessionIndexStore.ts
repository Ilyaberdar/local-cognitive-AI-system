import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { Channel, SessionSummary } from "../types";
import { isMissingFile, withFileLock, writeJsonAtomically } from "../utils/fileStore";

interface SessionIndexRecord {
  sessions: SessionSummary[];
}

export class SessionIndexStore {
  private readonly filePath: string;

  constructor(private readonly appDataDir: string) {
    this.filePath = path.join(appDataDir, "sessions.json");
  }

  async list(): Promise<SessionSummary[]> {
    return withFileLock(this.filePath, async () => {
      const record = await this.read();
      return [...record.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
  }

  get(id: string): Promise<SessionSummary | null> {
    return withFileLock(this.filePath, async () => (await this.read()).sessions.find(session => session.id === id) ?? null);
  }

  async create(title?: string, channel: Channel = "http", projectId?: string): Promise<SessionSummary> {
    return withFileLock(this.filePath, async () => {
    const record = await this.read();
    const session: SessionSummary = {
      id: randomUUID(),
      title: title?.trim() || "New chat",
      updatedAt: new Date().toISOString(),
      channel,
      ...(projectId ? { projectId } : {})
    };

    record.sessions.unshift(session);
    await this.write(record);
    return session;
    });
  }

  async touch(
    id: string,
    payload?: {
      title?: string;
      channel?: Channel;
    }
  ): Promise<SessionSummary> {
    return withFileLock(this.filePath, async () => {
    const record = await this.read();
    const existing = record.sessions.find((session) => session.id === id);

    if (existing) {
      if (payload?.title) {
        existing.title = payload.title;
      }

      if (payload?.channel) {
        existing.channel = payload.channel;
      }

      existing.updatedAt = new Date().toISOString();
      await this.write(record);
      return existing;
    }

    const created: SessionSummary = {
      id,
      title: payload?.title?.trim() || "New chat",
      updatedAt: new Date().toISOString(),
      channel: payload?.channel ?? "http"
    };
    record.sessions.unshift(created);
    await this.write(record);
    return created;
    });
  }

  async rename(id: string, title: string): Promise<SessionSummary | null> {
    return withFileLock(this.filePath, async () => {
    const record = await this.read();
    const existing = record.sessions.find((session) => session.id === id);

    if (!existing) {
      return null;
    }

    existing.title = title.trim() || existing.title;
    existing.updatedAt = new Date().toISOString();
    await this.write(record);
    return existing;
    });
  }

  async delete(id: string): Promise<boolean> {
    return withFileLock(this.filePath, async () => {
    const record = await this.read();
    const initialLength = record.sessions.length;
    record.sessions = record.sessions.filter((session) => session.id !== id);

    if (record.sessions.length === initialLength) {
      return false;
    }

    await this.write(record);
    return true;
    });
  }

  private async read(): Promise<SessionIndexRecord> {
    await fs.mkdir(this.appDataDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionIndexRecord>;
      if (!parsed || !Array.isArray(parsed.sessions) || parsed.sessions.some(session => !session ||
        typeof session.id !== "string" || typeof session.title !== "string" || typeof session.updatedAt !== "string" ||
        (session.projectId !== undefined && typeof session.projectId !== "string"))) {
        throw new Error("Invalid session index. Existing data has not been changed.");
      }
      return {
        sessions: parsed.sessions
      };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return { sessions: [] };
    }
  }

  private async write(record: SessionIndexRecord): Promise<void> {
    await writeJsonAtomically(this.filePath, record);
  }
}
