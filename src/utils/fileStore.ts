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

export const writeJsonAtomically = async (filePath: string, record: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(record, null, 2), "utf8");
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};

export const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
