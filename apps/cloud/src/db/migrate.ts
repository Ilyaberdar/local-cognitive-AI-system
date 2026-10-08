import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Serialises concurrent migration runs (several containers starting at once).
const LOCK_KEY = 7_402_113_001;
export interface Migration { version: string; name: string; sql: string; checksum: string }
export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const out: Migration[] = [];
  for (const name of files) {
    const m = FILE.exec(name);
    if (!m?.[1]) throw new Error(`Invalid migration file name: ${name}`);
    if (out.some((x) => x.version === m[1])) throw new Error(`Duplicate migration version ${m[1]}`);
    const sql = await readFile(path.join(dir, name), "utf8");
    out.push({ version: m[1], name, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  return out;
}
/** Forward-only: applies pending .sql files in order, each in its own transaction. Rollback is a
 * backup restore, so an edited applied file or a database newer than this build is refused. */
export async function migrate(pool: pg.Pool, dir: string): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations");
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const v of done.keys()) if (!migrations.some((m) => m.version === v)) throw new Error(`Database has unknown migration ${v}; refusing to run an older build`);
    for (const m of migrations) {
      const prev = done.get(m.version);
      if (prev !== undefined) { if (prev !== m.checksum) throw new Error(`Migration ${m.name} was modified after being applied`); continue; }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [m.version, m.name, m.checksum]);
        await client.query("COMMIT");
        applied.push(m.name);
      } catch (e) { await client.query("ROLLBACK"); throw e; }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}
