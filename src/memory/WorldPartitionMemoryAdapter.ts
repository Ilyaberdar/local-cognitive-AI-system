import fs from "fs/promises";
import { Dirent } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  ActorContext,
  MemoryEntry,
  MemoryQueryOptions,
  MemoryRecentOptions,
  MemorySaveInput,
  MemoryWorldPartitionSettings
} from "../types";
import { Logger } from "../utils/Logger";
import { MemoryAdapter } from "./MemoryAdapter";
import { MortonCodec } from "./MortonCodec";
import { SemanticProjector } from "./SemanticProjector";
import { VectorStore } from "./VectorStore";
import { WorldPartitionStore } from "./WorldPartitionStore";

interface WorldPartitionMemoryAdapterOptions extends MemoryWorldPartitionSettings {
  baseDir: string;
  topK: number;
}

const GRID_SIZE = 64;

export class WorldPartitionMemoryAdapter implements MemoryAdapter {
  readonly name = "world-partition";
  private readonly store: WorldPartitionStore;
  private readonly projector = new SemanticProjector();
  private migrationPromise: Promise<void> | null = null;

  constructor(
    private readonly options: WorldPartitionMemoryAdapterOptions,
    private readonly vectorStore: VectorStore,
    private readonly logger: Logger
  ) {
    this.store = new WorldPartitionStore({
      baseDir: options.baseDir,
      chunkCapacity: options.chunkCapacity
    });
  }

  async initialize(): Promise<void> {
    await this.ensureMigrated();
  }

  async save(entry: MemorySaveInput): Promise<MemoryEntry> {
    await this.ensureMigrated();
    const record = await this.createRecord(entry);
    await this.appendRecord(record);
    return record;
  }

  async query(query: string, options?: MemoryQueryOptions): Promise<MemoryEntry[]> {
    await this.ensureMigrated();
    const actor = options?.actor;
    if (!actor?.sessionId) {
      return [];
    }

    const queryEmbedding = await this.vectorStore.embed(query);
    const limit = options?.topK ?? this.options.topK;
    const candidateSets = await Promise.all(
      this.resolveQueryActorKeys(actor).map((actorKey) => this.queryActorEntries(actorKey, queryEmbedding, limit))
    );
    const uniqueCandidates = Array.from(
      new Map(candidateSets.flat().map((entry) => [entry.id, entry])).values()
    );

    return this.vectorStore.similaritySearchByEmbedding(queryEmbedding, uniqueCandidates, limit);
  }

  async recent(options?: MemoryRecentOptions): Promise<MemoryEntry[]> {
    await this.ensureMigrated();
    const actor = options?.actor;
    if (!actor?.sessionId) {
      return [];
    }

    const entries = await this.store.readTimeline(actor.sessionId);
    return entries
      .filter((entry) => this.matchesTimelineActor(entry, actor))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options?.limit ?? 10);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureMigrated();
    await this.store.deleteActor(this.store.actorKey(`session:${sessionId}`));
    await this.store.deleteSession(sessionId);
  }

  private async queryActorEntries(actorKey: string, queryEmbedding: number[], limit: number): Promise<MemoryEntry[]> {
    const entryCount = await this.store.getEntryCount(actorKey);
    if (entryCount === 0) {
      return [];
    }

    if (!this.shouldUsePartition(entryCount)) {
      return this.store.readEntries(actorKey);
    }

    const candidates = await this.readNearbyEntries(actorKey, queryEmbedding, limit);
    return candidates.length < limit && this.options.fallbackToGlobalSearch
      ? this.store.readEntries(actorKey)
      : candidates;
  }

  private async readNearbyEntries(actorKey: string, queryEmbedding: number[], limit: number): Promise<MemoryEntry[]> {
    const coordinate = this.projector.project(queryEmbedding);
    const centerX = this.toGridCoordinate(coordinate.x);
    const centerY = this.toGridCoordinate(coordinate.y);
    const maxRadius = Math.max(this.options.initialRadius, this.options.maxRadius);
    const availableCells = new Set(await this.store.getCellKeys(actorKey));
    const loadedCells = new Set<string>();
    let candidates: MemoryEntry[] = [];

    for (let radius = this.options.initialRadius; radius <= maxRadius; radius += 1) {
      const cellKeys = this.neighbouringCellKeys(centerX, centerY, radius).filter(
        (key) => availableCells.has(key) && !loadedCells.has(key)
      );
      cellKeys.forEach((key) => loadedCells.add(key));
      candidates = candidates.concat(await this.store.readEntries(actorKey, cellKeys));

      if (candidates.length >= limit || radius === maxRadius) {
        return candidates;
      }
    }

    return candidates;
  }

  private shouldUsePartition(entryCount: number): boolean {
    if (this.options.strategy === "global") {
      return false;
    }

    if (this.options.strategy === "partitioned") {
      return true;
    }

    return entryCount >= this.options.activationThreshold;
  }

  private neighbouringCellKeys(centerX: number, centerY: number, radius: number): string[] {
    const keys: string[] = [];

    for (let y = Math.max(0, centerY - radius); y <= Math.min(GRID_SIZE - 1, centerY + radius); y += 1) {
      for (let x = Math.max(0, centerX - radius); x <= Math.min(GRID_SIZE - 1, centerX + radius); x += 1) {
        keys.push(this.cellKey(x, y));
      }
    }

    return keys;
  }

  private async createRecord(entry: MemorySaveInput): Promise<MemoryEntry> {
    return {
      id: randomUUID(),
      input: entry.input,
      mode: entry.mode,
      output: entry.output,
      scope: entry.scope ?? entry.mode,
      tags: entry.tags ?? [entry.mode],
      embedding: await this.vectorStore.embed(`${entry.input}\n${JSON.stringify(entry.output)}`),
      createdAt: new Date().toISOString(),
      actor: entry.actor,
      metadata: entry.metadata
    };
  }

  private async appendRecord(record: MemoryEntry, skipIfPresent = false): Promise<boolean> {
    const coordinate = this.projector.project(record.embedding);
    return this.store.append(
      this.resolveActorKey(record.actor),
      record.actor.sessionId,
      this.cellKey(this.toGridCoordinate(coordinate.x), this.toGridCoordinate(coordinate.y)),
      record,
      skipIfPresent
    );
  }

  private resolveActorKey(actor: Partial<ActorContext>): string {
    const identity =
      this.options.crossSessionRecall && actor.userId
        ? `user:${actor.channel ?? "system"}:${actor.userId}`
        : `session:${actor.sessionId}`;
    return this.store.actorKey(identity);
  }

  private resolveQueryActorKeys(actor: Partial<ActorContext>): string[] {
    const primary = this.resolveActorKey(actor);
    if (!this.options.crossSessionRecall || !actor.userId || actor.channel !== "http") {
      return [primary];
    }

    const legacySession = this.store.actorKey(`session:${actor.sessionId}`);
    return legacySession === primary ? [primary] : [primary, legacySession];
  }

  private matchesTimelineActor(entry: MemoryEntry, actor: Partial<ActorContext>): boolean {
    if (entry.actor.sessionId !== actor.sessionId) {
      return false;
    }

    if (actor.channel && entry.actor.channel !== actor.channel) {
      return false;
    }

    if (!actor.userId) {
      return true;
    }

    if (entry.actor.userId) {
      return entry.actor.userId === actor.userId;
    }

    // Legacy HTTP memory predates stable profile IDs. HTTP is a single local profile,
    // while shared MCP and Telegram sessions must never expose anonymous legacy entries.
    return actor.channel === "http" && entry.actor.channel === "http";
  }

  private cellKey(x: number, y: number): string {
    return `p${this.projector.version}-${MortonCodec.encode(x, y)}`;
  }

  private toGridCoordinate(value: number): number {
    const normalized = Math.max(-1, Math.min(1, value));
    return Math.max(0, Math.min(GRID_SIZE - 1, Math.floor(((normalized + 1) / 2) * GRID_SIZE)));
  }

  private async ensureMigrated(): Promise<void> {
    if (!this.options.migrateLegacyOnStart || (await this.store.hasMigrationMarker())) {
      return;
    }

    if (!this.migrationPromise) {
      this.migrationPromise = this.migrateLegacyEntries().finally(() => {
        this.migrationPromise = null;
      });
    }

    await this.migrationPromise;
  }

  private async migrateLegacyEntries(): Promise<void> {
    let scopes: Dirent[] = [];

    try {
      scopes = await fs.readdir(this.store.legacyBaseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.store.markMigrationComplete();
        return;
      }
      throw error;
    }

    let migrated = 0;
    const failures: string[] = [];
    for (const scope of scopes) {
      if (!scope.isDirectory() || scope.name.startsWith(".")) {
        continue;
      }

      const scopeDir = path.join(this.store.legacyBaseDir, scope.name);
      const files = await fs.readdir(scopeDir, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".json")) {
          continue;
        }

        try {
          const raw = await fs.readFile(path.join(scopeDir, file.name), "utf8");
          const legacy = this.normalizeLegacyEntry(JSON.parse(raw) as Partial<MemoryEntry>, scope.name);
          legacy.embedding = await this.vectorStore.embed(`${legacy.input}\n${JSON.stringify(legacy.output)}`);
          if (await this.appendRecord(legacy, true)) {
            migrated += 1;
          }
        } catch (error) {
          failures.push(file.name);
          this.logger.warn("Skipping unreadable legacy memory entry", {
            file: file.name,
            error: error instanceof Error ? error.message : "unknown_error"
          });
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(`Legacy memory migration is incomplete; ${failures.length} records could not be imported.`);
    }

    await this.store.markMigrationComplete();
    this.logger.info("Legacy memory migration completed", { migrated });
  }

  private normalizeLegacyEntry(entry: Partial<MemoryEntry>, scope: string): MemoryEntry {
    return {
      id: entry.id ?? randomUUID(),
      input: entry.input ?? "",
      mode: entry.mode ?? "general",
      output: entry.output,
      scope: entry.scope ?? scope,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      embedding: [],
      createdAt: entry.createdAt ?? new Date(0).toISOString(),
      actor: entry.actor ?? { sessionId: "legacy-session", channel: "system" },
      metadata: entry.metadata
    };
  }
}
