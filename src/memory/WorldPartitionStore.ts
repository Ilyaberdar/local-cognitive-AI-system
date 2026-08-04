import { createHash, randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { MemoryEntry } from "../types";

interface CellManifest {
  chunks: string[];
  entryCount: number;
  lastChunkCount: number;
}

interface PartitionManifest {
  version: 1;
  entryCount: number;
  cells: Record<string, CellManifest>;
}

export interface WorldPartitionStoreOptions {
  baseDir: string;
  chunkCapacity: number;
}

export class WorldPartitionStore {
  private static readonly worldDirectoryName = ".world-partition-v1";
  private static readonly writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: WorldPartitionStoreOptions) {}

  get legacyBaseDir(): string {
    return this.options.baseDir;
  }

  get worldDir(): string {
    return path.join(this.options.baseDir, WorldPartitionStore.worldDirectoryName);
  }

  actorKey(value: string): string {
    return this.hash(value);
  }

  async append(
    actorKey: string,
    sessionId: string,
    cellKey: string,
    entry: MemoryEntry,
    skipIfPresent = false
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const manifest = await this.readManifest(actorKey);
      const recordedCell = manifest.cells[cellKey] ?? {
        chunks: [],
        entryCount: 0,
        lastChunkCount: 0
      };
      const { cell, recovered } = await this.recoverCell(actorKey, cellKey, recordedCell);
      const recoveredEntryCountDelta = cell.entryCount - recordedCell.entryCount;

      if (skipIfPresent && (await this.cellContainsEntry(actorKey, cellKey, cell, entry.id))) {
        if (recovered) {
          manifest.entryCount += recoveredEntryCountDelta;
          manifest.cells[cellKey] = cell;
          await this.writeManifest(actorKey, manifest);
        }
        return false;
      }
      const needsNewChunk = cell.chunks.length === 0 || cell.lastChunkCount >= this.options.chunkCapacity;

      if (needsNewChunk) {
        cell.chunks.push(`chunk-${String(cell.chunks.length + 1).padStart(6, "0")}.jsonl`);
        cell.lastChunkCount = 0;
      }

      const chunkName = cell.chunks[cell.chunks.length - 1];
      const actorDir = this.actorDir(actorKey);
      await fs.mkdir(path.join(actorDir, "cells", cellKey), { recursive: true });
      await fs.mkdir(path.join(this.worldDir, "sessions"), { recursive: true });
      await fs.appendFile(
        path.join(actorDir, "cells", cellKey, chunkName),
        `${JSON.stringify(entry)}\n`,
        "utf8"
      );
      await fs.appendFile(
        this.timelinePath(sessionId),
        `${JSON.stringify(entry)}\n`,
        "utf8"
      );

      cell.entryCount += 1;
      cell.lastChunkCount += 1;
      manifest.entryCount += recoveredEntryCountDelta + 1;
      manifest.cells[cellKey] = cell;
      await this.writeManifest(actorKey, manifest);
      return true;
    });
  }

  async getEntryCount(actorKey: string): Promise<number> {
    return (await this.readReconciledManifest(actorKey)).entryCount;
  }

  async getCellKeys(actorKey: string): Promise<string[]> {
    return Object.keys((await this.readReconciledManifest(actorKey)).cells);
  }

  async readEntries(actorKey: string, cellKeys?: string[]): Promise<MemoryEntry[]> {
    const manifest = await this.readReconciledManifest(actorKey);
    const selectedCells = cellKeys ?? Object.keys(manifest.cells);
    const chunkPaths: string[] = [];

    for (const cellKey of selectedCells) {
      const cell = manifest.cells[cellKey];
      if (!cell) {
        continue;
      }

      for (const chunkName of cell.chunks) {
        chunkPaths.push(path.join(this.actorDir(actorKey), "cells", cellKey, chunkName));
      }
    }

    const chunks = await Promise.all(chunkPaths.map((chunkPath) => this.readJsonLines(chunkPath)));
    return chunks.flat();
  }

  async readTimeline(sessionId: string): Promise<MemoryEntry[]> {
    return this.readJsonLines(this.timelinePath(sessionId));
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        await fs.unlink(this.timelinePath(sessionId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    });
  }

  async deleteActor(actorKey: string): Promise<void> {
    return this.enqueue(async () => {
      await fs.rm(this.actorDir(actorKey), { recursive: true, force: true });
    });
  }

  async hasMigrationMarker(): Promise<boolean> {
    try {
      await fs.access(path.join(this.worldDir, "legacy-migration-v1.complete"));
      return true;
    } catch {
      return false;
    }
  }

  async markMigrationComplete(): Promise<void> {
    await fs.mkdir(this.worldDir, { recursive: true });
    await fs.writeFile(path.join(this.worldDir, "legacy-migration-v1.complete"), new Date().toISOString(), "utf8");
  }

  private async readManifest(actorKey: string): Promise<PartitionManifest> {
    try {
      const raw = await fs.readFile(path.join(this.actorDir(actorKey), "manifest.json"), "utf8");
      const parsed = JSON.parse(raw) as Partial<PartitionManifest>;

      return {
        version: 1,
        entryCount: typeof parsed.entryCount === "number" ? parsed.entryCount : 0,
        cells: parsed.cells && typeof parsed.cells === "object" ? parsed.cells : {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      return { version: 1, entryCount: 0, cells: {} };
    }
  }

  private async writeManifest(actorKey: string, manifest: PartitionManifest): Promise<void> {
    const actorDir = this.actorDir(actorKey);
    await fs.mkdir(actorDir, { recursive: true });
    const filePath = path.join(actorDir, "manifest.json");
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(manifest, null, 2), "utf8");
    await fs.rename(temporaryPath, filePath);
  }

  private async readReconciledManifest(actorKey: string): Promise<PartitionManifest> {
    return this.enqueue(async () => {
      const manifest = await this.readManifest(actorKey);
      const diskCellKeys = await this.listCellKeys(actorKey);
      const cellKeys = new Set([...Object.keys(manifest.cells), ...diskCellKeys]);
      let changed = false;

      for (const cellKey of cellKeys) {
        const recordedCell = manifest.cells[cellKey] ?? {
          chunks: [],
          entryCount: 0,
          lastChunkCount: 0
        };
        const { cell, recovered } = await this.recoverCell(actorKey, cellKey, recordedCell);
        if (!recovered) {
          continue;
        }

        manifest.entryCount += cell.entryCount - recordedCell.entryCount;
        manifest.cells[cellKey] = cell;
        changed = true;
      }

      if (changed) {
        await this.writeManifest(actorKey, manifest);
      }

      return manifest;
    });
  }

  private async readJsonLines(filePath: string): Promise<MemoryEntry[]> {
    try {
      const raw = await fs.readFile(filePath, "utf8");

      return raw
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as MemoryEntry];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  private actorDir(actorKey: string): string {
    return path.join(this.worldDir, "actors", actorKey);
  }

  private timelinePath(sessionId: string): string {
    return path.join(this.worldDir, "sessions", `${this.hash(sessionId)}.jsonl`);
  }

  private hash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 32);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queueKey = this.worldDir;
    const previous = WorldPartitionStore.writeQueues.get(queueKey) ?? Promise.resolve();
    const task = previous.then(operation, operation);
    WorldPartitionStore.writeQueues.set(
      queueKey,
      task.then(
        () => undefined,
        () => undefined
      )
    );
    return task;
  }

  private async cellContainsEntry(
    actorKey: string,
    cellKey: string,
    cell: CellManifest,
    entryId: string
  ): Promise<boolean> {
    for (const chunkName of cell.chunks) {
      const entries = await this.readJsonLines(path.join(this.actorDir(actorKey), "cells", cellKey, chunkName));
      if (entries.some((entry) => entry.id === entryId)) {
        return true;
      }
    }

    return false;
  }

  private async recoverCell(
    actorKey: string,
    cellKey: string,
    recordedCell: CellManifest
  ): Promise<{ cell: CellManifest; recovered: boolean }> {
    let files: string[] = [];

    try {
      files = (await fs.readdir(path.join(this.actorDir(actorKey), "cells", cellKey), { withFileTypes: true }))
        .filter((file) => file.isFile() && /^chunk-\d+\.jsonl$/.test(file.name))
        .map((file) => file.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (files.length === 0 || this.sameChunks(files, recordedCell.chunks)) {
      return { cell: recordedCell, recovered: false };
    }

    const counts = await Promise.all(
      files.map(async (chunkName) =>
        (await this.readJsonLines(path.join(this.actorDir(actorKey), "cells", cellKey, chunkName))).length
      )
    );

    return {
      cell: {
        chunks: files,
        entryCount: counts.reduce((sum, count) => sum + count, 0),
        lastChunkCount: counts[counts.length - 1] ?? 0
      },
      recovered: true
    };
  }

  private sameChunks(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((chunk, index) => chunk === right[index]);
  }

  private async listCellKeys(actorKey: string): Promise<string[]> {
    try {
      return (await fs.readdir(path.join(this.actorDir(actorKey), "cells"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }
}
