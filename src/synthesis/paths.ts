import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { isMissingFile } from "../utils/fileStore";
import { SynthesisError } from "./types";

export const MAX_SOURCE_BYTES = 128 * 1024;
export const MAX_ARTIFACT_BYTES = 128 * 1024;
export function relativePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 240 || value.includes("\\") ||
      value.split("/").some(part => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) || part === "node_modules")) {
    throw new SynthesisError("Expected a relative path without hidden folders, traversal or reserved directories.");
  }
  return value;
}
/** Reject symlinks at every component, including final files and missing-path ancestors. */
export async function containedPath(root: string, relative: string): Promise<string> {
  relativePath(relative);
  const canonical = await fs.realpath(root);
  if (path.resolve(root) !== canonical) throw new SynthesisError("Project root changed or is a symbolic link.", 409);
  let cursor = root;
  for (const segment of relative.split("/")) {
    cursor = path.join(cursor, segment);
    try {
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new SynthesisError("Symbolic links are not allowed in Synthesis paths.");
    } catch (error) { if (!isMissingFile(error)) throw error; }
  }
  return cursor;
}
export async function readText(file: string, limit = MAX_SOURCE_BYTES): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new SynthesisError(`File must be a regular UTF-8 file of at most ${limit} bytes.`);
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
export async function readOptional(file: string): Promise<string | null> {
  try { return await readText(file, MAX_ARTIFACT_BYTES); } catch (error) { if (isMissingFile(error)) return null; throw error; }
}
export function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function filesHash(files: Record<string, string>): string {
  return hash(JSON.stringify(Object.keys(files).sort().map(key => [key, files[key]])));
}
