import fs from "node:fs";
import path from "node:path";
import { allowedFields, DIAGNOSTIC_EVENTS, type DiagnosticEventName, type DiagnosticFields } from "./events";

/** One line of the technical log: an event of the catalog, its allowed fields, and how many times
 * it happened (repeats within a minute are counted, not written one by one). */
export interface DiagnosticEntry { at: string; event: DiagnosticEventName; fields: Record<string, unknown>; n: number }

export interface DiagnosticSink {
  record<E extends DiagnosticEventName>(event: E, fields?: DiagnosticFields<E>): void;
}

const isEvent = (event: string): event is DiagnosticEventName => Object.hasOwn(DIAGNOSTIC_EVENTS, event);

/** The technical log: what went wrong, as codes and counts only, built from the catalog at the
 * source (not a text log cleaned up afterwards). Two files of `maxBytes` at most: the current one
 * and the one before. It never throws: a full disk must not break what it records. */
export class DiagnosticLog implements DiagnosticSink {
  readonly file: string;
  private readonly previous: string;
  private readonly repeats = new Map<string, { entry: DiagnosticEntry; since: number; count: number }>();
  private readonly listeners = new Set<(entry: DiagnosticEntry) => void>();

  constructor(directory: string, private readonly options: { maxBytes?: number; repeatWindowMs?: number; now?: () => number } = {}) {
    this.file = path.join(directory, "events.jsonl");
    this.previous = path.join(directory, "events.1.jsonl");
    try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { /* Recording becomes a no-op. */ }
  }

  /** Called for each new entry (Sentry breadcrumbs). */
  onRecord(listener: (entry: DiagnosticEntry) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  record<E extends DiagnosticEventName>(event: E, fields?: DiagnosticFields<E>): void {
    try {
      if (!isEvent(event)) return;
      const kept = allowedFields(event, fields as Record<string, unknown>) ?? {};
      const now = this.now();
      this.flushRepeats(now, this.repeats.size > 500);
      const key = JSON.stringify([event, kept]);
      const repeat = this.repeats.get(key);
      if (repeat) { repeat.count++; return; }
      const entry: DiagnosticEntry = { at: new Date(now).toISOString(), event, fields: kept, n: 1 };
      this.repeats.set(key, { entry, since: now, count: 0 });
      this.write(entry);
      for (const listener of this.listeners) { try { listener(entry); } catch { /* A listener never breaks recording. */ } }
    } catch { /* Never throws. */ }
  }

  /** The recent log, checked against the catalog again as it is read. */
  tail(options: { days?: number; maxBytes?: number } = {}): DiagnosticEntry[] {
    this.flushRepeats(this.now(), true);
    const since = this.now() - (options.days ?? 14) * 86_400_000;
    const entries: DiagnosticEntry[] = [];
    for (const file of [this.previous, this.file]) {
      let text = "";
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const raw = JSON.parse(line) as Partial<DiagnosticEntry>;
          const at = Date.parse(String(raw.at));
          if (typeof raw.event !== "string" || !isEvent(raw.event) || !Number.isFinite(at) || at < since) continue;
          const n = Number.isSafeInteger(raw.n) && raw.n! > 0 ? raw.n! : 1;
          entries.push({ at: new Date(at).toISOString(), event: raw.event, fields: allowedFields(raw.event, raw.fields as Record<string, unknown>) ?? {}, n });
        } catch { /* A broken line is skipped. */ }
      }
    }
    // The newest entries that fit.
    const limit = options.maxBytes ?? 256 * 1024;
    let size = 0, start = entries.length;
    while (start > 0 && size + JSON.stringify(entries[start - 1]).length + 1 <= limit) size += JSON.stringify(entries[--start]).length + 1;
    return entries.slice(start);
  }

  /** Writes the counts of repeats still waiting (at shutdown). */
  flush(): void { this.flushRepeats(this.now(), true); }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private flushRepeats(now: number, all = false): void {
    const window = this.options.repeatWindowMs ?? 60_000;
    for (const [key, repeat] of this.repeats) {
      if (!all && now - repeat.since < window) continue;
      this.repeats.delete(key);
      if (repeat.count) this.write({ ...repeat.entry, at: new Date(Math.min(now, repeat.since + window)).toISOString(), n: repeat.count });
    }
  }

  private write(entry: DiagnosticEntry): void {
    try {
      const line = `${JSON.stringify(entry)}\n`;
      const max = this.options.maxBytes ?? 256 * 1024;
      let size = 0;
      try { size = fs.statSync(this.file).size; } catch { /* No file yet. */ }
      if (size + line.length > max) fs.renameSync(this.file, this.previous);
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch { /* A full or read-only disk: the entry is lost, the caller is not. */ }
  }
}

let sink: DiagnosticSink = { record: () => undefined };
/** The process's technical log; recording does nothing until the runtime installs one. */
export const diagnostics = (): DiagnosticSink => sink;
export const setDiagnosticSink = (next: DiagnosticSink | undefined): void => { sink = next ?? { record: () => undefined }; };
