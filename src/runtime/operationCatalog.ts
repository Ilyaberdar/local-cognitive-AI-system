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
  "sessions.setup.get": { kind: "request", timeoutMs: 15_000 },
  "sessions.rename": { kind: "request", timeoutMs: 15_000 },
  "sessions.delete": { kind: "request", timeoutMs: 60_000 },
  // Attachments: chunks are requests (never in the command ledger); the upload id makes them repeatable.
  "uploads.begin": { kind: "request", timeoutMs: 15_000 },
  "uploads.chunk": { kind: "request", timeoutMs: 30_000 },
  "uploads.commit": { kind: "request", timeoutMs: 30_000 },
  "uploads.cancel": { kind: "request", timeoutMs: 15_000 },
  // A chat's files: Review reads them as text, a saved copy in parts (scrubbed paths, checked as Review is).
  "files.stat": { kind: "request", timeoutMs: 60_000 },
  "files.read": { kind: "request", timeoutMs: 30_000 },
  // Shared folders (R5-4f): a place is a root id and a list of names, never a path of the host.
  "fs.roots": { kind: "request", timeoutMs: 15_000 },
  "fs.browse": { kind: "request", timeoutMs: 15_000 },
  "fs.mkdir": { kind: "request", timeoutMs: 15_000 },
  // Projects (R5-4g): created in a shared folder as a command; a project set up on the server is listed by name only.
  "projects.list": { kind: "request", timeoutMs: 15_000 },
  "projects.create": { kind: "command", timeoutMs: 30_000 },
  "projects.update": { kind: "request", timeoutMs: 15_000 },
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
  "models.local.watch": { kind: "watch", timeoutMs: 35_000 },
  // Tasks & workflows (R5-2)
  "orchestration.snapshot": { kind: "request", timeoutMs: 30_000 },
  "tasks.create": { kind: "command", timeoutMs: 30_000 },
  "tasks.update": { kind: "request", timeoutMs: 30_000 },
  "tasks.delete": { kind: "request", timeoutMs: 15_000 },
  "tasks.run": { kind: "command", timeoutMs: 30_000 },
  "tasks.runNext": { kind: "command", timeoutMs: 30_000 },
  "schedules.create": { kind: "command", timeoutMs: 30_000 },
  "schedules.update": { kind: "request", timeoutMs: 30_000 },
  "schedules.delete": { kind: "request", timeoutMs: 15_000 },
  "workflows.validate": { kind: "request", timeoutMs: 15_000 },
  "workflows.save": { kind: "command", timeoutMs: 30_000 },
  "workflows.runs.start": { kind: "command", timeoutMs: 30_000 },
  "workflows.runs.get": { kind: "request", timeoutMs: 30_000 },
  "workflows.runs.events": { kind: "request", timeoutMs: 30_000 },
  "workflows.runs.cancel": { kind: "request", timeoutMs: 15_000 },
  "workflows.runs.review": { kind: "command", timeoutMs: 30_000 },
  "workflows.runs.resume": { kind: "command", timeoutMs: 30_000 },
  "workflows.runs.agentTrace.get": { kind: "request", timeoutMs: 30_000 },
  // Settings (R5-3). A settings change is a field patch, safe to repeat: not a command, so no
  // hash of a key is ever stored in the command ledger.
  "settings.get": { kind: "request", timeoutMs: 15_000 },
  "settings.update": { kind: "request", timeoutMs: 120_000 },
  "providers.test": { kind: "request", timeoutMs: 330_000 }
};

export const operationsOfKind = (kind: OperationKind): string[] => Object.entries(OPERATIONS).filter(([, spec]) => spec.kind === kind).map(([name]) => name);

/** State streams a screen may watch, by stream id, and the long poll that follows each one.
 * Chat streams are not here: they are followed by cursor through `events.poll`. */
export const WATCHES: Readonly<Record<string, string>> = { "models.local": "models.local.watch" };
