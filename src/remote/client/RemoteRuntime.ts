import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { OPERATIONS } from "../../runtime/operationCatalog";
import { RemoteError, type RemoteClient, type RemoteStatus } from "./RemoteClient";

export interface StreamCursor { streamId: string; epoch: string; after: number }
export interface StreamEvent { seq: number; type: string; runId?: string; occurredAt: string; payload: Record<string, unknown> }
/** What subscribers receive: new events in order, the whole state of a watched stream, or
 * `resync` — the stream ended: reload the snapshot, then subscribe (or watch) again. */
export type StreamUpdate = { streamId: string; events: StreamEvent[] } | { streamId: string; sequence: number; snapshot: unknown } | { streamId: string; resync: string };
/** `hostId`: the server the screen believes it talks to; a request for another one is refused. */
export interface TargetOptions { hostId?: string }

const IN_DOUBT = ["disconnected", "timeout", "not_connected"];
// The stream cannot continue on this server: the session is gone, or the server is too old.
const FINAL = ["session_unknown", "unknown_operation"];
const POLL_WAIT_MS = 20_000;

/** The runtime of the selected server for the app's screens (spec §7.1): requests, commands that
 * are safe to resend, event streams and state watches that survive reconnects. */
export class RemoteRuntime extends EventEmitter {
  private readonly streams = new Map<string, { cursor: StreamCursor; hostId?: string; generation: number }>();
  private generation = 0;

  constructor(private readonly client: RemoteClient, private readonly options: { resendWindowMs?: number } = {}) {
    super();
    // Another server, or a deliberate disconnect, ends every stream: their cursors belong to the old one.
    let hostId = client.status().hostId;
    client.on("change", (status: RemoteStatus) => {
      if (status.hostId === hostId && status.state !== "idle") return;
      hostId = status.state === "idle" ? undefined : status.hostId;
      for (const streamId of [...this.streams.keys()]) this.end(streamId, "host_changed");
    });
  }

  request<T = unknown>(op: string, payload?: unknown, target: TargetOptions = {}): Promise<T> {
    try { this.expectHost(target.hostId, "The selected server changed. Nothing was sent."); }
    catch (error) { return Promise.reject(error); }
    return this.client.request<T>(op, payload, OPERATIONS[op]?.timeoutMs);
  }

  /** Sends a command once: if the answer was lost, the same command id is sent again after
   * reconnecting to the same server, and it returns the first result instead of acting twice. */
  async send<T = unknown>(op: string, payload: Record<string, unknown>, target: TargetOptions = {}): Promise<T> {
    if (this.client.status().state !== "online") throw new RemoteError("The server is not connected. Nothing was sent.", "not_connected");
    this.expectHost(target.hostId, "The selected server changed. Nothing was sent.");
    const hostId = this.client.status().hostId, commandId = randomUUID(), deadline = Date.now() + (this.options.resendWindowMs ?? 120_000);
    for (;;) {
      try { return await this.client.request<T>(op, { ...payload, commandId }, OPERATIONS[op]?.timeoutMs); }
      catch (error) {
        const code = (error as { code?: string }).code ?? "";
        if (!IN_DOUBT.includes(code)) throw error;
        if (!await this.client.waitOnline(Math.max(0, deadline - Date.now())) || this.client.status().hostId !== hostId) {
          throw new RemoteError("The connection dropped while sending. The server may have received the message; open the chat again to check.", "unknown_outcome");
        }
      }
    }
  }

  /** Follows a stream from the cursor of a snapshot; one long poll per stream. */
  subscribe(cursor: StreamCursor, target: TargetOptions = {}): void {
    this.expectHost(target.hostId, "The selected server changed.");
    const generation = this.open(cursor);
    void this.follow(cursor.streamId, generation, async stream => {
      const { streams } = await this.client.request<{ streams: Array<{ streamId: string; events?: StreamEvent[]; resync?: string }> }>(
        "events.poll", { streams: [stream.cursor], waitMs: POLL_WAIT_MS }, POLL_WAIT_MS + 15_000);
      if (!this.current(cursor.streamId, generation)) return;
      const result = streams.find(entry => entry.streamId === cursor.streamId);
      if (result?.resync) { this.end(cursor.streamId, result.resync); return; }
      if (result?.events?.length) {
        stream.cursor.after = result.events.at(-1)!.seq;
        this.emit("update", { streamId: cursor.streamId, events: result.events } satisfies StreamUpdate);
      }
    });
  }

  /** Follows a state on the server (the Models tab): `op` answers `{ epoch, sequence, snapshot }`
   * with the whole state when this device is behind, so the first answer is the current state and
   * a reconnect loses nothing. Without a snapshot (the wait ended) the cursor stays as it was. */
  watch(streamId: string, op: string, target: TargetOptions = {}): void {
    this.expectHost(target.hostId, "The selected server changed.");
    const generation = this.open({ streamId, epoch: "", after: 0 });
    void this.follow(streamId, generation, async stream => {
      const { epoch, sequence, snapshot } = await this.client.request<{ epoch: string; sequence: number; snapshot?: unknown }>(
        op, { epoch: stream.cursor.epoch, after: stream.cursor.after, waitMs: POLL_WAIT_MS }, POLL_WAIT_MS + 15_000);
      if (!this.current(streamId, generation) || snapshot === undefined) return;
      stream.cursor = { streamId, epoch, after: sequence };
      this.emit("update", { streamId, sequence, snapshot } satisfies StreamUpdate);
    });
  }

  unsubscribe(streamId: string): void { this.streams.delete(streamId); }
  unwatch(streamId: string): void { this.streams.delete(streamId); }
  dispose(): void { this.streams.clear(); }

  private expectHost(hostId: string | undefined, message: string): void {
    if (hostId !== undefined && this.client.status().hostId !== hostId) throw new RemoteError(message, "host_changed");
  }

  private open(cursor: StreamCursor): number {
    const generation = ++this.generation;
    this.streams.set(cursor.streamId, { cursor: { ...cursor }, hostId: this.client.status().hostId, generation });
    return generation;
  }

  private end(streamId: string, reason: string): void {
    if (!this.streams.delete(streamId)) return;
    this.emit("update", { streamId, resync: reason } satisfies StreamUpdate);
  }

  private current(streamId: string, generation: number) {
    const stream = this.streams.get(streamId);
    return stream && stream.generation === generation ? stream : undefined;
  }

  private async follow(streamId: string, generation: number, poll: (stream: { cursor: StreamCursor }) => Promise<void>): Promise<void> {
    let failures = 0;
    for (let stream = this.current(streamId, generation); stream; stream = this.current(streamId, generation)) {
      if (this.client.status().state !== "online") {
        if (!await this.client.waitOnline(30_000)) continue;
        if (this.client.status().hostId !== stream.hostId) { this.end(streamId, "host_changed"); return; }
      }
      try {
        await poll(stream);
        failures = 0;
      } catch (error) {
        const code = (error as { code?: string }).code ?? "";
        if (FINAL.includes(code)) { if (this.current(streamId, generation)) this.end(streamId, code); return; }
        // A dropped connection resumes from the same cursor once the client is back online;
        // anything else backs off. Never retry without a pause.
        await new Promise(resolve => setTimeout(resolve, IN_DOUBT.includes(code) ? 250 : Math.min(30_000, 1000 * 2 ** failures++)));
      }
    }
  }
}
