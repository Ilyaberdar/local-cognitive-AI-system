import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

// Shared by store instances, including runtimes created during a settings reload.
const queues = new Map<string, Promise<unknown>>();

export const withFileLock = <T>(filePath: string, operation: () => Promise<T>): Promise<T> => {
  const key = path.resolve(filePath);
  const result = (queues.get(key) ?? Promise.resolve()).then(operation, operation);
  const settled = result.then(() => undefined, () => undefined);
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return result;
};

/** Windows refuses to replace a file that the antivirus or the search indexer has open for a moment
 * (EPERM, EBUSY, EACCES): the rename is tried again a few times before it counts as a failure. */
export const renameWithRetry = async (from: string, to: string, attempts = process.platform === "win32" ? 6 : 1): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try { await fs.rename(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= attempts || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
};

export const writeJsonAtomically = async (filePath: string, record: unknown, options: { mode?: number } = {}): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    // The rename keeps the temporary file's mode, so a restricted mode also replaces a looser existing one.
    await fs.writeFile(temporaryPath, JSON.stringify(record, null, 2), { encoding: "utf8", mode: options.mode });
    await renameWithRetry(temporaryPath, filePath);
  } finally {
    await fs.unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};

/** Limits an existing file to its owner on POSIX; Windows uses ACLs instead of modes. */
export const restrictToOwner = async (filePath: string): Promise<void> => {
  if (process.platform !== "win32") await fs.chmod(filePath, 0o600);
};

export const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
