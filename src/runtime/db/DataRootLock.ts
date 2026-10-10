import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isBusy, loadSqlite, type DatabaseSync } from "./sqlite";

export type RuntimeKind = "desktop" | "server" | "mcp-stdio" | "maintenance" | "test";
export interface DataRootOwner {
  instanceId: string; pid: number; kind: RuntimeKind; appVersion: string; startedAt: string; dataRoot: string; releasedAt?: string;
}

export class DataRootLockedError extends Error {
  readonly code = "data_root_locked";
  constructor(readonly dataRoot: string, readonly owner: DataRootOwner | null) {
    super(`The Local Cognitive data directory ${dataRoot} is already used by ${owner ? `${owner.kind} (pid ${owner.pid}, since ${owner.startedAt})` : "another process"}. Close it or use a different data directory.`);
  }
}

/** One runtime owns a data root. The authority is SQLite's exclusive file lock (an OS
 * lock released by close or process death), so a crash never leaves a stale lock and no
 * PID checks are needed. The owner record is informational. Never open, read or delete
 * runtime/data-root.lock with fs: on POSIX, closing any descriptor to it drops the lock. */
export class DataRootLock {
  private constructor(
    private readonly db: DatabaseSync,
    readonly owner: DataRootOwner,
    readonly previousOwner: DataRootOwner | null,
    private readonly ownerFile: string
  ) {}

  /** How the previous owner stopped: "unclean" after a crash or kill. */
  get previousShutdown(): "clean" | "unclean" | "none" {
    return !this.previousOwner ? "none" : this.previousOwner.releasedAt ? "clean" : "unclean";
  }

  static async acquire(dataRoot: string, kind: RuntimeKind, appVersion: string, options: { waitMs?: number } = {}): Promise<DataRootLock> {
    const directory = path.join(dataRoot, "runtime");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockFile = path.join(directory, "data-root.lock");
    const ownerFile = path.join(directory, "data-root.owner.json");
    const deadline = Date.now() + (options.waitMs ?? 0);
    for (;;) {
      const { DatabaseSync } = loadSqlite();
      const db = new DatabaseSync(lockFile, { timeout: 0 });
      try {
        db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
        db.exec("CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)");
        const previous = db.prepare("SELECT json FROM owner WHERE id = 1").get();
        const owner: DataRootOwner = { instanceId: randomUUID(), pid: process.pid, kind, appVersion, startedAt: new Date().toISOString(), dataRoot };
        db.prepare("INSERT OR REPLACE INTO owner(id, json) VALUES (1, ?)").run(JSON.stringify(owner));
        db.exec("COMMIT"); // EXCLUSIVE locking mode keeps the OS lock after commit.
        // A rejected process reads this copy for its error message.
        fs.writeFileSync(ownerFile, JSON.stringify(owner, null, 2), { mode: 0o600 });
        return new DataRootLock(db, owner, previous ? JSON.parse(String(previous.json)) as DataRootOwner : null, ownerFile);
      } catch (error) {
        try { if (db.isTransaction) db.exec("ROLLBACK"); } catch { /* The connection is closed next. */ }
        db.close();
        if (!isBusy(error)) throw error;
        if (Date.now() >= deadline) {
          let owner: DataRootOwner | null = null;
          try { owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as DataRootOwner; } catch { /* Owner details are optional. */ }
          throw new DataRootLockedError(dataRoot, owner);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  release(): void {
    if (!this.db.isOpen) return;
    try {
      this.db.prepare("UPDATE owner SET json = ? WHERE id = 1").run(JSON.stringify({ ...this.owner, releasedAt: new Date().toISOString() }));
    } catch { /* The next owner then reports an unclean shutdown. */ }
    try {
      const current = JSON.parse(fs.readFileSync(this.ownerFile, "utf8")) as DataRootOwner;
      if (current.instanceId === this.owner.instanceId) fs.unlinkSync(this.ownerFile);
    } catch { /* Another owner may already have replaced the record. */ }
    this.db.close();
  }
}
