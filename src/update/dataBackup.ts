import fs from "fs";
import path from "path";
import { loadSqlite } from "../runtime/db/sqlite";
import { appVersion } from "../utils/appVersion";

/** Never copied: models are large and can be downloaded again, output is the user's own folder,
 * and backups do not nest. Locks, sockets and SQLite's side files are not state. */
const SKIPPED_TOP = new Set(["models", "output", "backups"]);
const SKIPPED_FILE = /(?:\.lock|\.sock|-wal|-shm|\.tmp|-journal)$/;
const BACKUP_NAME = /^\d{8}T\d{6}Z-[\w.+-]{1,80}$/;

export interface BackupResult { directory: string; files: number; bytes: number }

const isSqlite = (file: string) => {
  if (!/\.db$/.test(file)) return false;
  const header = Buffer.alloc(16);
  const descriptor = fs.openSync(file, "r");
  try { fs.readSync(descriptor, header, 0, 16, 0); } finally { fs.closeSync(descriptor); }
  return header.toString("latin1") === "SQLite format 3\u0000";
};

/** Every file to copy, relative to the data root, and their total size. */
const inventory = (root: string) => {
  const files: Array<{ relative: string; size: number }> = [];
  const walk = (directory: string, relative: string, depth: number) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (depth === 0 && SKIPPED_TOP.has(entry.name)) continue;
      const child = path.join(relative, entry.name), full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full, child, depth + 1);
      else if (entry.isFile() && !SKIPPED_FILE.test(entry.name)) files.push({ relative: child, size: fs.statSync(full).size });
    }
  };
  walk(root, "", 0);
  return { files, bytes: files.reduce((total, file) => total + file.size, 0) };
};

const freeBytes = (directory: string) => { const stats = fs.statfsSync(directory); return stats.bavail * stats.bsize; };

/** A consistent copy of the server's state (not its models) under `<root>/backups/<time>-<label>`.
 * SQLite databases are copied with VACUUM INTO; everything else as files with their modes. Run with
 * the server stopped (the caller holds the data root lock). The newest `keep` backups are kept. */
export const backupDataRoot = (rootInput: string, options: { label: string; now?: Date; keep?: number }): BackupResult => {
  const root = path.resolve(rootInput);
  if (!/^[\w.+-]{1,80}$/.test(options.label)) throw new Error("A backup label is letters, digits and . _ + - only.");
  const { files, bytes } = inventory(root);
  const backups = path.join(root, "backups");
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  const needed = Math.ceil(bytes * 1.1) + 64 * 1024 * 1024;
  if (freeBytes(backups) < needed) throw new Error(`Not enough free space for a backup: ${Math.ceil(needed / 1024 ** 2)} MB needed.`);
  const stamp = (options.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const directory = path.join(backups, `${stamp}-${options.label}`);
  const partial = `${directory}.partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { mode: 0o700 });
  const { DatabaseSync } = loadSqlite();
  for (const file of files) {
    const source = path.join(root, file.relative), target = path.join(partial, file.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (isSqlite(source)) {
      const db = new DatabaseSync(source, { readOnly: true });
      try { db.prepare("VACUUM INTO ?").run(target); } finally { db.close(); }
    } else fs.copyFileSync(source, target);
    fs.chmodSync(target, fs.statSync(source).mode & 0o777);
  }
  fs.writeFileSync(path.join(partial, "backup.json"), `${JSON.stringify({ createdAt: (options.now ?? new Date()).toISOString(), label: options.label,
    appVersion: appVersion(), files: files.length, bytes })}\n`, { mode: 0o600 });
  fs.renameSync(partial, directory);
  // The newest are kept; a failed update's restore needs the one just made.
  const keep = options.keep ?? 3;
  const existing = fs.readdirSync(backups).filter(name => BACKUP_NAME.test(name) && fs.existsSync(path.join(backups, name, "backup.json"))).sort();
  for (const old of existing.slice(0, Math.max(0, existing.length - keep))) fs.rmSync(path.join(backups, old), { recursive: true, force: true });
  return { directory, files: files.length, bytes };
};

/** Puts a backup's state back. What is there now is moved aside (never deleted) to
 * `<root>/backups/<time>-replaced`, so a failed version's state can still be looked at. */
export const restoreDataRoot = (rootInput: string, backupInput: string, now = new Date()): { replaced: string } => {
  const root = path.resolve(rootInput), backup = path.resolve(backupInput);
  if (path.dirname(backup) !== path.join(root, "backups") || !fs.existsSync(path.join(backup, "backup.json"))) throw new Error("Not a backup of this data directory.");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const replaced = path.join(root, "backups", `${stamp}-replaced`);
  fs.mkdirSync(replaced, { mode: 0o700 });
  for (const entry of fs.readdirSync(root)) {
    if (SKIPPED_TOP.has(entry)) continue;
    fs.renameSync(path.join(root, entry), path.join(replaced, entry));
  }
  fs.cpSync(backup, root, { recursive: true, preserveTimestamps: true, filter: source => path.basename(source) !== "backup.json" || path.dirname(source) !== backup });
  // The restored files keep the backup's modes; the data root stays private.
  fs.chmodSync(root, 0o700);
  return { replaced };
};

/** Backups of a data directory, newest first. */
export const listBackups = (rootInput: string): Array<{ name: string; directory: string; createdAt?: string; label?: string; appVersion?: string; bytes?: number }> => {
  const backups = path.join(path.resolve(rootInput), "backups");
  let names: string[] = [];
  try { names = fs.readdirSync(backups).filter(name => BACKUP_NAME.test(name)).sort().reverse(); } catch { return []; }
  return names.flatMap(name => {
    try { return [{ name, directory: path.join(backups, name), ...JSON.parse(fs.readFileSync(path.join(backups, name, "backup.json"), "utf8")) }]; }
    catch { return []; }
  });
};
