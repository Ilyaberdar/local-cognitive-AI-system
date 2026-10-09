import { z } from "zod";
import { RemoteOperationError, type RemoteOperation } from "../remote/host/RemoteHost";
import type { EventJournal, JournalEvent } from "./EventJournal";

const MAX_POLL_MS = 20_000;
const schema = z.object({
  streams: z.array(z.object({ streamId: z.string().min(1).max(250), epoch: z.string().max(100), after: z.number().int().nonnegative() }).strict()).min(1).max(8),
  waitMs: z.number().int().min(0).max(MAX_POLL_MS).optional(), maxEvents: z.number().int().min(1).max(500).optional()
}).strict();

/** A kind of stream a device follows with `events.poll` besides chat journals (`session:<id>`). */
export interface StreamSource {
  /** Stream ids of this kind start with it; the rest is the id the source understands. */
  prefix: string;
  /** Events after the cursor, or why the device must reload (resync). Throws when the device may
   * not follow the stream. */
  read(id: string, cursor: { epoch: string; after: number }, maxEvents: number): Promise<{ events: JournalEvent[] } | { resync: string }>;
  /** Calls `wake` on the stream's next event; returns the unsubscribe. */
  subscribe(id: string, wake: () => void): () => void;
}

/** `events.poll` (spec §7.2): a long poll over the streams a device follows, chat journals and
 * the sources' streams alike. Answers at once when any stream has news, otherwise after the next
 * event, `waitMs` or the device's disconnect. A stale cursor gets `resync`. */
export const createEventStreamOperations = (deps: { journal: EventJournal; requireSession(sessionId: string): Promise<unknown>; sources?: StreamSource[] }): Record<string, RemoteOperation> => ({
  "events.poll": async (payload, context) => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new RemoteOperationError("The request is not valid.", "invalid_request");
    const { streams, waitMs = MAX_POLL_MS, maxEvents = 500 } = parsed.data;
    const kinds = streams.map(stream => {
      if (stream.streamId.startsWith("session:")) return { session: stream.streamId.slice("session:".length) };
      const source = (deps.sources ?? []).find(item => stream.streamId.startsWith(item.prefix));
      if (!source) throw new RemoteOperationError("The request is not valid.", "invalid_request");
      return { source, id: stream.streamId.slice(source.prefix.length) };
    });
    for (const kind of kinds) if ("session" in kind) await deps.requireSession(kind.session!);
    // Subscribed before the first read, so an event between the read and the wait is not missed.
    const woken = new AbortController();
    const wake = () => woken.abort();
    const stops = kinds.flatMap(kind => "source" in kind ? [kind.source!.subscribe(kind.id!, wake)] : []);
    context.signal.addEventListener("abort", wake, { once: true });
    try {
      const read = () => Promise.all(streams.map(async (stream, index) => {
        const kind = kinds[index]!;
        return { streamId: stream.streamId, ...("source" in kind ? await kind.source!.read(kind.id!, stream, maxEvents) : deps.journal.read(stream.streamId, stream, { maxEvents })) };
      }));
      let results = await read();
      const news = () => results.some(result => "resync" in result || result.events.length > 0);
      if (!news() && waitMs > 0) {
        if (!woken.signal.aborted) await deps.journal.wait(kinds.flatMap((kind, index) => "session" in kind ? [streams[index]!.streamId] : []), waitMs, woken.signal);
        if (!context.signal.aborted) results = await read();
      }
      return { streams: results };
    } finally {
      for (const stop of stops) stop();
      context.signal.removeEventListener("abort", wake);
    }
  }
});
