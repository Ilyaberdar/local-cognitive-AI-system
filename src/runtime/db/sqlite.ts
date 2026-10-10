import type * as Sqlite from "node:sqlite";

export type SqliteModule = typeof Sqlite;
export type DatabaseSync = Sqlite.DatabaseSync;
export type SQLInputValue = Sqlite.SQLInputValue;

let loaded: SqliteModule | undefined;

/** Loads node:sqlite once. Node 22 emits an ExperimentalWarning synchronously on the first
 * require, so only that warning is filtered, and only during that call (Node 24, bundled with
 * Electron 44, emits none). All access to node:sqlite goes through this module. */
export const loadSqlite = (): SqliteModule => {
  if (loaded) return loaded;
  const original = process.emitWarning;
  process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined);
    const message = typeof warning === "string" ? warning : warning.message;
    if (type === "ExperimentalWarning" && message.startsWith("SQLite is an experimental feature")) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try { loaded = require("node:sqlite") as SqliteModule; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_UNKNOWN_BUILTIN_MODULE") throw new Error("Local Cognitive requires Node.js 22.16 or newer (node:sqlite).");
    throw error;
  } finally { process.emitWarning = original; }
  return loaded;
};

/** SQLITE_BUSY and its extended codes (e.g. BUSY_SNAPSHOT). */
export const isBusy = (error: unknown): boolean =>
  typeof error === "object" && error !== null && typeof (error as { errcode?: unknown }).errcode === "number" &&
  ((error as { errcode: number }).errcode & 0xff) === 5;
