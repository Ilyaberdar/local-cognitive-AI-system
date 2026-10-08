import fs from "node:fs";
import path from "node:path";
import { loadSqlite, type DatabaseSync } from "./sqlite";

export interface Migration { version: number; name: string; up(db: DatabaseSync): void }
export class HostDatabaseError extends Error { constructor(message: string, readonly code: string) { super(message); } }

/** The host's durable store for commands, runs, messages, events and usage. One
 * connection per process; writes use BEGIN IMMEDIATE so a concurrent writer waits
 * for the lock instead of failing on a stale read snapshot. */
export class HostDatabase {
  private constructor(readonly db: DatabaseSync, readonly filePath: string) {}

  static open(filePath: string, migrations: readonly Migration[], options: { busyTimeoutMs?: number } = {}): HostDatabase {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    // Pre-creating the file with 0600 makes SQLite create -wal and -shm with the same mode.
    fs.closeSync(fs.openSync(filePath, "a", 0o600));
    const { DatabaseSync } = loadSqlite();
    // A busy wait blocks the event loop (Electron's main thread), so keep it short.
    const db = new DatabaseSync(filePath, { timeout: options.busyTimeoutMs ?? 2000, enableForeignKeyConstraints: true });
    try {
      const mode = db.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode;
      if (mode !== "wal") throw new HostDatabaseError(`SQLite WAL is unavailable (journal_mode=${String(mode)}).`, "wal_unavailable");
      // FULL: an acknowledged command must survive power loss.
      db.exec("PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA journal_size_limit=67108864");
      const host = new HostDatabase(db, filePath);
      host.migrate(migrations);
      return host;
    } catch (error) { db.close(); throw error; }
  }

  /** Synchronous body only: an awaited gap would let other callers interleave into the open transaction. */
  transaction<T>(body: (db: DatabaseSync) => T): T {
    if (this.db.isTransaction) throw new HostDatabaseError("Nested host transactions are not supported.", "nested_transaction");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body(this.db);
      if (result && typeof (result as { then?: unknown }).then === "function") throw new HostDatabaseError("Host transactions must be synchronous.", "async_transaction");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      // A failed multi-statement exec can leave the transaction open.
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  schemaVersion(): number { return Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0); }

  meta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM host_meta WHERE key = ?").get(key);
    return row ? String(row.value) : undefined;
  }

  private migrate(migrations: readonly Migration[]): void {
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    sorted.forEach((migration, index) => {
      if (migration.version !== index + 1) throw new HostDatabaseError("Host migrations must be contiguous from 1.", "invalid_migrations");
    });
    const current = this.schemaVersion();
    const latest = sorted.at(-1)?.version ?? 0;
    if (current > latest) throw new HostDatabaseError(`Host database schema ${current} is newer than this application (${latest}). Update the application.`, "schema_too_new");
    for (const migration of sorted.filter(item => item.version > current)) {
      this.transaction(db => {
        migration.up(db);
        db.exec(`PRAGMA user_version=${migration.version}`);
        db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(migration.version, migration.name, new Date().toISOString());
      });
    }
  }

  close(): void {
    if (!this.db.isOpen) return;
    try { this.db.exec("PRAGMA optimize"); } catch { /* Closing must not fail on an optimisation hint. */ }
    this.db.close();
  }
}
