import { execFileSync } from "child_process";
import os from "os";

export interface SystemMemory { total: number; free: number; cached?: number; }

export const parseMacMemory = (output: string, total: number): SystemMemory | undefined => {
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1]);
  const freePages = Number(output.match(/^Pages free:\s+(\d+)\./m)?.[1]);
  const cachedPages = Number(output.match(/^File-backed pages:\s+(\d+)\./m)?.[1]);
  if (![pageSize, total].every(value => Number.isFinite(value) && value > 0) ||
      ![freePages, cachedPages].every(value => Number.isFinite(value) && value >= 0)) return undefined;
  const cached = Math.min(total, cachedPages * pageSize);
  return { total, free: Math.min(total, freePages * pageSize + cached), cached };
};

let cachedSnapshot: { at: number; memory: SystemMemory } | undefined;

export const getSystemMemory = (): SystemMemory => {
  const now = Date.now();
  if (cachedSnapshot && now - cachedSnapshot.at < 3000) return cachedSnapshot.memory;
  let memory: SystemMemory = { total: os.totalmem(), free: os.freemem() };
  if (process.platform === "darwin") {
    try {
      // File-backed cache can be reclaimed. Raw freemem alone makes a Mac with
      // cached GGUF files appear full even after its models have been unloaded.
      const output = execFileSync("/usr/bin/vm_stat", { encoding: "utf8", timeout: 1000, maxBuffer: 64 * 1024 });
      memory = parseMacMemory(output, memory.total) ?? memory;
    } catch { /* Use the OS fallback when metrics are unavailable. */ }
  }
  cachedSnapshot = { at: now, memory };
  return memory;
};
