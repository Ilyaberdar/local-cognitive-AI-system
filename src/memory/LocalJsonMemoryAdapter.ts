import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import {
  MemoryEntry,
  MemoryQueryOptions,
  MemoryRecentOptions,
  MemorySaveInput
} from "../types";
import { Logger } from "../utils/Logger";
import { VectorStore } from "./VectorStore";
import { MemoryAdapter } from "./MemoryAdapter";

interface LocalJsonMemoryAdapterOptions {
  baseDir: string;
  topK: number;
}

export class LocalJsonMemoryAdapter implements MemoryAdapter {
  readonly name = "local-json";

  constructor(
    private readonly options: LocalJsonMemoryAdapterOptions,
    private readonly vectorStore: VectorStore,
    private readonly logger: Logger
  ) {}

  async save(entry: MemorySaveInput): Promise<MemoryEntry> {
    const scope = this.normalizeScope(entry.scope ?? entry.mode);
    const embedding = await this.vectorStore.embed(`${entry.input}\n${JSON.stringify(entry.output)}`);
    const createdAt = new Date().toISOString();

    const record: MemoryEntry = {
      id: randomUUID(),
      input: entry.input,
      mode: entry.mode,
      output: entry.output,
      scope,
      tags: entry.tags ?? [entry.mode],
      embedding,
      createdAt,
      actor: entry.actor,
      metadata: entry.metadata
    };

    const scopeDir = path.join(this.options.baseDir, scope);
    await fs.mkdir(scopeDir, { recursive: true });
    await fs.writeFile(
      path.join(scopeDir, `${record.id}.json`),
      JSON.stringify(record, null, 2),
      "utf8"
    );

    this.logger.debug("Memory entry saved", {
      adapter: this.name,
      id: record.id,
      scope,
      sessionId: record.actor.sessionId
    });

    return record;
  }

  async query(query: string, options?: MemoryQueryOptions): Promise<MemoryEntry[]> {
    const allEntries = await this.loadAllEntries(options);

    if (allEntries.length === 0) {
      return [];
    }

    return this.vectorStore.similaritySearch(query, allEntries, options?.topK ?? this.options.topK);
  }

  async recent(options?: MemoryRecentOptions): Promise<MemoryEntry[]> {
    const allEntries = await this.loadAllEntries({ actor: options?.actor });

    return allEntries
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options?.limit ?? 10);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const allEntries = await this.loadAllEntries();
    await Promise.all(
      allEntries
        .filter((entry) => entry.actor.sessionId === sessionId)
        .map((entry) => fs.unlink(path.join(this.options.baseDir, entry.scope, `${entry.id}.json`)).catch(() => undefined))
    );
  }

  private async loadAllEntries(options?: { actor?: MemoryQueryOptions["actor"] }): Promise<MemoryEntry[]> {
    await fs.mkdir(this.options.baseDir, { recursive: true });
    const scopeDirs = await fs.readdir(this.options.baseDir, { withFileTypes: true });
    const files: string[] = [];

    for (const scopeDir of scopeDirs) {
      if (!scopeDir.isDirectory()) {
        continue;
      }

      const fullScopeDir = path.join(this.options.baseDir, scopeDir.name);
      const entryFiles = await fs.readdir(fullScopeDir, { withFileTypes: true });

      for (const entryFile of entryFiles) {
        if (entryFile.isFile() && entryFile.name.endsWith(".json")) {
          files.push(path.join(fullScopeDir, entryFile.name));
        }
      }
    }

    const entries = await Promise.all(
      files.map(async (filePath) => {
        const raw = await fs.readFile(filePath, "utf8");
        return this.normalizeEntry(JSON.parse(raw) as Partial<MemoryEntry>);
      })
    );

    return entries.filter((entry) => this.matchesActor(entry, options?.actor));
  }

  private matchesActor(entry: MemoryEntry, actor?: MemoryQueryOptions["actor"]): boolean {
    if (!actor) {
      return true;
    }

    if (actor.sessionId && actor.sessionId !== entry.actor.sessionId) {
      return false;
    }

    if (actor.userId && actor.userId !== entry.actor.userId) {
      return false;
    }

    if (actor.channel && actor.channel !== entry.actor.channel) {
      return false;
    }

    return true;
  }

  private normalizeEntry(entry: Partial<MemoryEntry>): MemoryEntry {
    return {
      id: entry.id ?? randomUUID(),
      input: entry.input ?? "",
      mode: entry.mode ?? "general",
      output: entry.output,
      scope: entry.scope ?? "legacy",
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      embedding: Array.isArray(entry.embedding) ? entry.embedding : [],
      createdAt: entry.createdAt ?? new Date(0).toISOString(),
      actor: entry.actor ?? {
        sessionId: "legacy-session",
        channel: "system"
      },
      metadata: entry.metadata
    };
  }

  private normalizeScope(scope: string): string {
    return scope.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  }
}
