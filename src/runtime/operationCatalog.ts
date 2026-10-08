/** Every operation a paired device may call on a host: how the client sends it and how long it
 * waits. The Electron bridge builds its allowlist from this table, so a screen cannot reach an
 * operation the host does not offer. Imports nothing: electron/remote.cjs loads it directly. */
export type OperationKind =
  /** A plain request; safe to repeat or read-only. */
  | "request"
  /** Sent once with a command id; the host returns the first result for a repeat. */
  | "command"
  /** A long poll the client runs itself (subscriptions), never called by a screen. */
  | "watch";

export interface OperationSpec { kind: OperationKind; timeoutMs: number }

export const OPERATIONS: Readonly<Record<string, OperationSpec>> = {
  "session.ping": { kind: "request", timeoutMs: 15_000 },
  "host.info": { kind: "request", timeoutMs: 15_000 },
  "host.status": { kind: "request", timeoutMs: 15_000 },
  // Chat (R4)
  "sessions.list": { kind: "request", timeoutMs: 30_000 },
  "sessions.create": { kind: "request", timeoutMs: 30_000 },
  "sessions.messages.list": { kind: "request", timeoutMs: 30_000 },
  "sessions.settings.get": { kind: "request", timeoutMs: 15_000 },
  "sessions.settings.update": { kind: "request", timeoutMs: 30_000 },
  "models.available": { kind: "request", timeoutMs: 45_000 },
  "chat.runs.start": { kind: "command", timeoutMs: 30_000 },
  "chat.runs.get": { kind: "request", timeoutMs: 15_000 },
  "chat.runs.cancel": { kind: "request", timeoutMs: 15_000 },
  "chat.approvals.resolve": { kind: "request", timeoutMs: 15_000 },
  "events.poll": { kind: "watch", timeoutMs: 35_000 },
  // Models (R5)
  "models.catalog.search": { kind: "request", timeoutMs: 45_000 },
  "models.catalog.get": { kind: "request", timeoutMs: 45_000 },
  "models.local.snapshot": { kind: "request", timeoutMs: 30_000 },
  "models.downloads.list": { kind: "request", timeoutMs: 15_000 },
  "models.downloads.start": { kind: "command", timeoutMs: 60_000 },
  "models.downloads.pause": { kind: "request", timeoutMs: 15_000 },
  "models.downloads.resume": { kind: "request", timeoutMs: 15_000 },
  "models.downloads.cancel": { kind: "request", timeoutMs: 15_000 },
  "models.load": { kind: "request", timeoutMs: 40_000 },
  "models.unload": { kind: "request", timeoutMs: 60_000 },
  "models.local.delete": { kind: "request", timeoutMs: 60_000 },
  "models.settings.get": { kind: "request", timeoutMs: 15_000 },
  "models.settings.update": { kind: "request", timeoutMs: 120_000 },
  "models.setDefault": { kind: "request", timeoutMs: 15_000 },
  "system.metrics": { kind: "request", timeoutMs: 15_000 },
  "models.local.watch": { kind: "watch", timeoutMs: 35_000 }
};

export const operationsOfKind = (kind: OperationKind): string[] => Object.entries(OPERATIONS).filter(([, spec]) => spec.kind === kind).map(([name]) => name);

/** State streams a screen may watch, by stream id, and the long poll that follows each one.
 * Chat streams are not here: they are followed by cursor through `events.poll`. */
export const WATCHES: Readonly<Record<string, string>> = { "models.local": "models.local.watch" };
