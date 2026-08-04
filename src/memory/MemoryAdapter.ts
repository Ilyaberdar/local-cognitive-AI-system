import {
  MemoryEntry,
  MemoryQueryOptions,
  MemoryRecentOptions,
  MemorySaveInput
} from "../types";

export interface MemoryAdapter {
  readonly name: string;
  save(entry: MemorySaveInput): Promise<MemoryEntry>;
  query(query: string, options?: MemoryQueryOptions): Promise<MemoryEntry[]>;
  recent(options?: MemoryRecentOptions): Promise<MemoryEntry[]>;
  deleteSession(sessionId: string): Promise<void>;
}
