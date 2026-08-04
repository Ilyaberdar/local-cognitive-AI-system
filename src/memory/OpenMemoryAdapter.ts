import {
  MemoryEntry,
  MemoryQueryOptions,
  MemoryRecentOptions,
  MemorySaveInput
} from "../types";
import { Logger } from "../utils/Logger";
import { MemoryAdapter } from "./MemoryAdapter";

interface OpenMemoryAdapterOptions {
  dbPath: string;
}

export class OpenMemoryAdapter implements MemoryAdapter {
  readonly name = "openmemory";
  private client: unknown | null = null;

  constructor(
    private readonly options: OpenMemoryAdapterOptions,
    private readonly logger: Logger
  ) {}

  async save(entry: MemorySaveInput): Promise<MemoryEntry> {
    const client = await this.getClient();

    if (!client) {
      throw new Error(
        "OpenMemory adapter requested, but openmemory-js is not installed. Run `npm install openmemory-js` if you want to enable it."
      );
    }

    const record: MemoryEntry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      input: entry.input,
      mode: entry.mode,
      output: entry.output,
      scope: entry.scope ?? entry.mode,
      tags: entry.tags ?? [entry.mode],
      embedding: [],
      createdAt: new Date().toISOString(),
      actor: entry.actor,
      metadata: entry.metadata
    };

    const openMemory = client as {
      add: (content: string, options?: Record<string, unknown>) => Promise<void>;
    };

    await openMemory.add(JSON.stringify(record), {
      userId: entry.actor.userId ?? entry.actor.sessionId,
      path: this.options.dbPath
    });

    return record;
  }

  async query(_query: string, _options?: MemoryQueryOptions): Promise<MemoryEntry[]> {
    // TODO: Map OpenMemory query results back into MemoryEntry records when OpenMemory becomes the active backend.
    return [];
  }

  async recent(_options?: MemoryRecentOptions): Promise<MemoryEntry[]> {
    // TODO: Use OpenMemory timeline or list APIs for session-scoped recall.
    return [];
  }

  async deleteSession(_sessionId: string): Promise<void> {
    this.logger.warn("Session deletion is not implemented for the OpenMemory adapter.");
  }

  private async getClient(): Promise<unknown | null> {
    if (this.client) {
      return this.client;
    }

    try {
      const specifier = "openmemory-js";
      const module = (await import(specifier)) as Record<string, unknown>;
      const OpenMemory =
        (module.OpenMemory as new (...args: unknown[]) => unknown) ??
        (module.default as new (...args: unknown[]) => unknown);

      if (!OpenMemory) {
        return null;
      }

      this.client = new OpenMemory({
        mode: "local",
        path: this.options.dbPath
      });

      return this.client;
    } catch (error) {
      this.logger.warn("OpenMemory client is unavailable", {
        error: error instanceof Error ? error.message : "unknown_error"
      });
      return null;
    }
  }
}
