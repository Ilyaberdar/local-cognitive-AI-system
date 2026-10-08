import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { RemoteError, type RemoteClient, type RemoteStatus } from "./RemoteClient";

export interface StreamCursor { streamId: string; epoch: string; after: number }
export interface StreamEvent { seq: number; type: string; runId?: string; occurredAt: string; payload: Record<string, unknown> }
/** What subscribers receive: new events in order, or `resync` — reload the snapshot, then subscribe again. */
export type StreamUpdate = { streamId: string; events: StreamEvent[] } | { streamId: string; resync: string };

const IN_DOUBT = ["disconnected", "timeout", "not_connected"];
const POLL_WAIT_MS = 20_000;

/** The runtime of the selected server, for the chat screen (spec §7.1, scoped to R4): requests,
 * commands that are safe to resend, and event streams that survive reconnects. */
export class RemoteRuntime extends EventEmitter {
  private readonly streams = new Map<string, { cursor: StreamCursor; hostId?: string; generation: number }>();
  private generation = 0;

  constructor(private readonly client: RemoteClient, private readonly options: { resendWindowMs?: number } = {}) {
    super();
    // Another server, or a deliberate disconnect, ends every subscription: their cursors belong to the old one.
    let hostId = client.status().hostId;
    client.on("change", (status: RemoteStatus) => {
      if (status.hostId === hostId && status.state !== "idle") return;
      hostId = status.state === "idle" ? undefined : status.hostId;
      for (const streamId of [...this.streams.keys()]) this.end(streamId, "host_changed");
    });
  }

  request<T = unknown>(op: string, payload?: unknown): Promise<T> { return this.client.request<T>(op, payload); }

  /** Sends a command once: if the answer was lost, the same command id is sent again after
   * reconnecting, and the server returns the first result instead of starting a second run. */
  async send<T = unknown>(op: string, payload: Record<string, unknown>): Promise<T> {
    if (this.client.status().state !== "online") throw new RemoteError("The server is not connected. Nothing was sent.", "not_connected");
    const commandId = randomUUID(), deadline = Date.now() + (this.options.resendWindowMs ?? 120_000);
    for (;;) {
      try { return await this.client.request<T>(op, { ...payload, commandId }); }
      catch (error) {
        const code = (error as { code?: string }).code ?? "";
        if (!IN_DOUBT.includes(code)) throw error;
        if (!await this.client.waitOnline(Math.max(0, deadline - Date.now()))) {
          throw new RemoteError("The connection dropped while sending. The server may have received the message; open the chat again to check.", "unknown_outcome");
        }
      }
    }
  }

  /** Follows a stream from the cursor of a snapshot; one long poll per stream. */
  subscribe(cursor: StreamCursor): void {
    const generation = ++this.generation;
    this.streams.set(cursor.streamId, { cursor: { ...cursor }, hostId: this.client.status().hostId, generation });
    void this.pump(cursor.streamId, generation);
  }

  unsubscribe(streamId: string): void { this.streams.delete(streamId); }
  dispose(): void { this.streams.clear(); }

  private end(streamId: string, reason: string): void {
    if (!this.streams.delete(streamId)) return;
    this.emit("update", { streamId, resync: reason } satisfies StreamUpdate);
  }

  private current(streamId: string, generation: number) {
    const stream = this.streams.get(streamId);
    return stream && stream.generation === generation ? stream : undefined;
  }

  private async pump(streamId: string, generation: number): Promise<void> {
    let failures = 0;
    for (let stream = this.current(streamId, generation); stream; stream = this.current(streamId, generation)) {
      if (this.client.status().state !== "online") {
        if (!await this.client.waitOnline(30_000)) continue;
        if (this.client.status().hostId !== stream.hostId) { this.end(streamId, "host_changed"); return; }
      }
      try {
        const { streams } = await this.client.request<{ streams: Array<{ streamId: string; events?: StreamEvent[]; resync?: string }> }>(
          "events.poll", { streams: [stream.cursor], waitMs: POLL_WAIT_MS }, POLL_WAIT_MS + 15_000);
        failures = 0;
        if (!this.current(streamId, generation)) return;
        const result = streams.find(entry => entry.streamId === streamId);
        if (result?.resync) { this.end(streamId, result.resync); return; }
        if (result?.events?.length) {
          stream.cursor.after = result.events.at(-1)!.seq;
          this.emit("update", { streamId, events: result.events } satisfies StreamUpdate);
        }
      } catch (error) {
        const code = (error as { code?: string }).code ?? "";
        if (code === "session_unknown") { this.end(streamId, "session_unknown"); return; }
        // A dropped connection resumes from the same cursor once the client is back online;
        // anything else backs off. Never retry without a pause.
        await new Promise(resolve => setTimeout(resolve, IN_DOUBT.includes(code) ? 250 : Math.min(30_000, 1000 * 2 ** failures++)));
      }
    }
  }
}
