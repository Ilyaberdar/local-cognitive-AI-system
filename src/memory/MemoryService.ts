import {
  MemoryEntry,
  MemoryQueryOptions,
  MemoryReference,
  MemoryRecentOptions,
  MemorySaveInput
} from "../types";
import { MemoryAdapter } from "./MemoryAdapter";

export class MemoryService {
  constructor(private readonly adapter: MemoryAdapter) {}

  async save(entry: MemorySaveInput): Promise<MemoryEntry> {
    return this.adapter.save(entry);
  }

  async retrieve(query: string, options?: MemoryQueryOptions): Promise<MemoryReference[]> {
    const entries = await this.adapter.query(query, options);
    return entries.map((entry) => this.toReference(entry));
  }

  async recent(options?: MemoryRecentOptions): Promise<MemoryEntry[]> {
    return this.adapter.recent(options);
  }

  private toReference(entry: MemoryEntry): MemoryReference {
    return {
      id: entry.id,
      input: entry.input,
      mode: entry.mode,
      scope: entry.scope,
      createdAt: entry.createdAt,
      actor: entry.actor
    };
  }
}
