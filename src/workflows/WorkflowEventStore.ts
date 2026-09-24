import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isMissingFile, withFileLock } from "../utils/fileStore";

export interface WorkflowEvent {
  sequence: number;
  runId: string;
  at: string;
  type: "run.status" | "node.started" | "node.progress" | "node.output" | "node.completed" | "transition";
  level: "info" | "warning" | "error";
  message: string;
  detail?: string;
  nodeId?: string;
  nodeRunId?: string;
  agentRunId?: string;
  operationId?: string;
  transitionId?: string;
  stream?: "stdout" | "stderr";
  phase?: string;
}
export type WorkflowEventInput = Omit<WorkflowEvent, "sequence" | "at"> & { at?: string };

// Shared across settings-driven runtime rebuilds. Disk remains the replay source.
const bus = new EventEmitter();
bus.setMaxListeners(0);
const MAX_EVENTS = 2000;
const MAX_BYTES = 2 * 1024 * 1024;

export class WorkflowEventStore {
  constructor(private readonly baseDir: string) {}
  private key(runId: string): string {
    return path.resolve(this.baseDir, "events", `${createHash("sha256").update(runId).digest("hex")}.jsonl`);
  }

  async append(input: WorkflowEventInput): Promise<WorkflowEvent> {
    const file = this.key(input.runId);
    return withFileLock(file, async () => {
      const { events, bytes, partial } = await this.read(file);
      const event: WorkflowEvent = {
        ...input, message: input.message.slice(0, 1000), detail: input.detail?.slice(0, 8192),
        sequence: (events.at(-1)?.sequence ?? 0) + 1, at: input.at ?? new Date().toISOString()
      };
      const line = JSON.stringify(event) + "\n";
      await fs.mkdir(path.dirname(file), { recursive: true });
      if (partial || events.length >= MAX_EVENTS || bytes + Buffer.byteLength(line) > MAX_BYTES) {
        const retained = [...events, event].slice(-MAX_EVENTS);
        let size = 0;
        const lines: string[] = [];
        for (let i = retained.length - 1; i >= 0; i--) {
          const value = JSON.stringify(retained[i]) + "\n";
          if (size + Buffer.byteLength(value) > MAX_BYTES) break;
          size += Buffer.byteLength(value); lines.unshift(value);
        }
        const temporary = `${file}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temporary, lines.join("")); await fs.rename(temporary, file); }
        finally { await fs.unlink(temporary).catch(() => {}); }
      } else await fs.appendFile(file, line);
      // A disconnected observer must never fail execution after a durable append.
      for (const listener of bus.listeners(file)) { try { listener(event); } catch {} }
      return event;
    });
  }

  async list(runId: string, after = 0) {
    const file = this.key(runId);
    return withFileLock(file, async () => {
      const { events } = await this.read(file);
      const firstSequence = events[0]?.sequence ?? 0;
      return { events: events.filter(event => event.sequence > after), firstSequence,
        lastSequence: events.at(-1)?.sequence ?? 0, truncated: firstSequence > after + 1 };
    });
  }

  subscribe(runId: string, listener: (event: WorkflowEvent) => void): () => void {
    const file = this.key(runId);
    bus.on(file, listener);
    return () => { bus.off(file, listener); };
  }

  private async read(file: string): Promise<{ events: WorkflowEvent[]; bytes: number; partial: boolean }> {
    let raw: string;
    try { raw = await fs.readFile(file, "utf8"); }
    catch (error) { if (isMissingFile(error)) return { events: [], bytes: 0, partial: false }; throw error; }
    // A process crash can leave an incomplete final append. Only complete lines are committed.
    const partial = Boolean(raw && !raw.endsWith("\n"));
    const lines = raw.split("\n"); lines.pop();
    return { events: lines.filter(Boolean).map(line => JSON.parse(line) as WorkflowEvent), bytes: Buffer.byteLength(raw), partial };
  }
}
