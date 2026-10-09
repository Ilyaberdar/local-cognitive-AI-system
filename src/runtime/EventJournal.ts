import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import type { DatabaseSync } from "./db/sqlite";
import type { HostDatabase } from "./db/HostDatabase";

/** A durable event on one stream (spec §7.2). Sequences are dense per stream and allocated in
 * the transaction that changes the state they describe. */
export interface JournalEvent { seq: number; type: string; runId?: string; occurredAt: string; payload: Record<string, unknown> }
export interface JournalCursor { epoch: string; after: number }
export type ReadResult = { events: JournalEvent[]; head: number; epoch: string } | { resync: "epoch_changed" | "cursor_expired" | "cursor_ahead"; head: number; epoch: string };

/** Progress events of finished runs are dropped after this; the completed message carries the result. */
const TRANSIENT = ["message.delta", "run.progress"];
const TRANSIENT_TTL_MS = 10 * 60_000;
const MAX_EVENTS_PER_STREAM = 10_000;

export class EventJournal {
  private readonly emitter = new EventEmitter();

  constructor(private readonly host: HostDatabase) { this.emitter.setMaxListeners(0); }

  get epoch(): string { return this.host.meta("journal_epoch")!; }

  /** Appends inside the caller's transaction; call `publish` with the result after commit. */
  append(db: DatabaseSync, streamId: string, event: { type: string; runId?: string; payload: Record<string, unknown>; at?: Date }): { streamId: string; event: JournalEvent } {
    const occurredAt = (event.at ?? new Date()).toISOString();
    const row = db.prepare(`INSERT INTO event_streams(stream_id, journal_epoch, last_sequence) VALUES (?, ?, 1)
      ON CONFLICT(stream_id) DO UPDATE SET last_sequence = last_sequence + 1 RETURNING last_sequence`).get(streamId, this.epoch);
    const seq = Number(row!.last_sequence);
    db.prepare("INSERT INTO events(stream_id, sequence, event_id, type, run_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(streamId, seq, randomUUID(), event.type, event.runId ?? null, occurredAt, JSON.stringify(event.payload));
    return { streamId, event: { seq, type: event.type, ...(event.runId ? { runId: event.runId } : {}), occurredAt, payload: event.payload } };
  }

  /** Wakes waiters after the appending transaction committed. */
  publish(appended: Array<{ streamId: string; event: JournalEvent }>): void {
    for (const streamId of new Set(appended.map(entry => entry.streamId))) this.emitter.emit(streamId);
  }

  /** Wakes the stream's followers without an event (the stream was removed). */
  wake(streamId: string): void { this.emitter.emit(streamId); }

  head(streamId: string): { epoch: string; head: number } {
    const row = this.host.db.prepare("SELECT last_sequence FROM event_streams WHERE stream_id = ?").get(streamId);
    return { epoch: this.epoch, head: Number(row?.last_sequence ?? 0) };
  }

  read(streamId: string, cursor: JournalCursor, limits: { maxEvents?: number; maxBytes?: number } = {}): ReadResult {
    const stream = this.host.db.prepare("SELECT journal_epoch, last_sequence, first_retained_sequence FROM event_streams WHERE stream_id = ?").get(streamId);
    const epoch = this.epoch, head = Number(stream?.last_sequence ?? 0);
    if (cursor.epoch !== epoch || (stream && stream.journal_epoch !== epoch)) return { resync: "epoch_changed", head, epoch };
    if (cursor.after > head) return { resync: "cursor_ahead", head, epoch };
    if (stream && cursor.after < Number(stream.first_retained_sequence) - 1) return { resync: "cursor_expired", head, epoch };
    const rows = this.host.db.prepare("SELECT sequence, type, run_id, occurred_at, payload_json FROM events WHERE stream_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
      .all(streamId, cursor.after, limits.maxEvents ?? 500);
    const events: JournalEvent[] = [];
    let bytes = 0;
    for (const row of rows) {
      const payload = String(row.payload_json);
      // Always return at least one event so a large one cannot stall the cursor.
      if (events.length && bytes + payload.length > (limits.maxBytes ?? 256 * 1024)) break;
      bytes += payload.length;
      events.push({ seq: Number(row.sequence), type: String(row.type), ...(row.run_id ? { runId: String(row.run_id) } : {}), occurredAt: String(row.occurred_at),
        payload: JSON.parse(payload) as Record<string, unknown> });
    }
    return { events, head, epoch };
  }

  /** Resolves when any of the streams gets an event, after `timeoutMs`, or on abort. */
  wait(streamIds: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      if (signal?.aborted) { resolve(); return; }
      const done = () => { clearTimeout(timer); for (const id of streamIds) this.emitter.off(id, done); signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, timeoutMs);
      for (const id of streamIds) this.emitter.on(id, done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** Drops progress of finished runs and caps each stream; cursors before the cut resync. */
  compact(now = new Date()): void {
    this.host.transaction(db => {
      db.prepare(`DELETE FROM events WHERE type IN (${TRANSIENT.map(() => "?").join(",")}) AND occurred_at < ?
        AND (run_id IS NULL OR run_id NOT IN (SELECT run_id FROM runs WHERE status IN ('queued','running','waiting_approval')))`)
        .run(...TRANSIENT, new Date(now.getTime() - TRANSIENT_TTL_MS).toISOString());
      for (const stream of db.prepare("SELECT stream_id, last_sequence FROM event_streams WHERE last_sequence - first_retained_sequence >= ?").all(MAX_EVENTS_PER_STREAM)) {
        const first = Number(stream.last_sequence) - MAX_EVENTS_PER_STREAM + 1;
        db.prepare("DELETE FROM events WHERE stream_id = ? AND sequence < ?").run(stream.stream_id, first);
        db.prepare("UPDATE event_streams SET first_retained_sequence = ? WHERE stream_id = ?").run(first, stream.stream_id);
      }
    });
  }
}
