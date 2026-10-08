import fs from "fs";
import path from "path";
import type { LocalModelOptions } from "./types";

/** runtime.json written by scripts/prepare-llama-runtime.mjs into a prepared runtime directory. */
export interface InstalledRuntime { id?: string; build?: string; commit?: string; platform?: string; arch?: string; backend?: string; sha256?: string; overlaySha256?: string }

export const llamaExecutable = (options: Pick<LocalModelOptions, "executablePath" | "runtimeDir">): string =>
  options.executablePath || path.join(options.runtimeDir, process.platform === "win32" ? "llama-server.exe" : "llama-server");

export const runtimeDirOf = (options: Pick<LocalModelOptions, "executablePath" | "runtimeDir">): string => path.dirname(llamaExecutable(options));

export const readInstalledRuntime = (directory: string): InstalledRuntime | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, "runtime.json"), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as InstalledRuntime : undefined;
  } catch { return undefined; }
};

/** Environment for llama.cpp processes. ggml loads backends from GGML_BACKEND_PATH and from the
 * working directory, and llama-server reads LLAMA_ARG_* as arguments, so inherited values are
 * dropped; callers run the process inside the runtime directory. On Linux the runtime directory
 * comes first in LD_LIBRARY_PATH so a host CUDA installation cannot shadow the bundled libraries. */
export const runtimeEnv = (base: NodeJS.ProcessEnv, directory: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv => {
  const env = Object.fromEntries(Object.entries(base).filter(([name]) => !/^(GGML_|LLAMA_ARG_)/i.test(name)));
  if (platform === "linux") env.LD_LIBRARY_PATH = [directory, ...(base.LD_LIBRARY_PATH ?? "").split(":").filter(entry => entry && entry !== directory)].join(":");
  return env;
};
