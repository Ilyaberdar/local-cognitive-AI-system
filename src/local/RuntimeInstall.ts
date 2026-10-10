import fs from "fs";
import path from "path";
import type { LocalModelOptions } from "./types";

/** runtime.json written by scripts/prepare-llama-runtime.mjs into a prepared runtime directory. */
export interface InstalledRuntime {
  id?: string; build?: string; commit?: string; platform?: string; arch?: string; backend?: string; sha256?: string; overlaySha256?: string;
  /** What the host needs, e.g. { nvidiaDriver: "580" } for a CUDA build. */
  requires?: { nvidiaDriver?: string };
}

export const llamaExecutable = (options: Pick<LocalModelOptions, "executablePath" | "runtimeDir">): string =>
  options.executablePath || path.join(options.runtimeDir, process.platform === "win32" ? "llama-server.exe" : "llama-server");

export const runtimeDirOf = (options: Pick<LocalModelOptions, "executablePath" | "runtimeDir">): string => path.dirname(llamaExecutable(options));

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
};

export const readInstalledRuntime = (directory: string): InstalledRuntime | undefined => {
  const runtime = readJson(path.join(directory, "runtime.json")) as InstalledRuntime | undefined;
  // The Linux CUDA overlay names its requirements in its own metadata.
  if (runtime && !runtime.requires) {
    const overlay = readJson(path.join(directory, "cuda-overlay.json"));
    if (overlay?.requires && typeof overlay.requires === "object") return { ...runtime, requires: overlay.requires as InstalledRuntime["requires"] };
  }
  return runtime;
};

/** Folders that keep a runtime to itself: an empty llama.cpp configuration folder, so a user's
 * config.ini cannot change its arguments, and the CUDA kernel cache. */
export interface RuntimeIsolation { configDir: string; cudaCacheDir?: string }

export const runtimeIsolation = (dataDir: string): RuntimeIsolation =>
  ({ configDir: path.join(dataDir, "runtime", "llama-config"), cudaCacheDir: path.join(dataDir, "runtime", "cuda-cache") });

// Vulkan layers a user or another program asked for (validation layers slow inference badly).
const VULKAN_LAYER_VARIABLES = new Set(["VK_INSTANCE_LAYERS", "VK_LOADER_LAYERS_ENABLE", "VK_LAYER_PATH", "VK_ADD_LAYER_PATH"]);

/** Environment for llama.cpp processes. ggml loads backends from GGML_BACKEND_PATH and from the
 * working directory, llama-server reads LLAMA_ARG_* as arguments and MTMD_BACKEND_DEVICE as the
 * vision projector's device, so inherited values are dropped; callers run the process inside the
 * runtime directory. Overlays that hook into Vulkan programs (Steam, OBS, Epic) stay out. With an
 * isolation, the user's llama.cpp config.ini is not read (it would add arguments) and CUDA keeps
 * its compiled kernels with the app's data. On Linux the runtime directory comes first in
 * LD_LIBRARY_PATH so a host CUDA installation cannot shadow the bundled libraries. */
export const runtimeEnv = (base: NodeJS.ProcessEnv, directory: string, platform: NodeJS.Platform = process.platform, isolation?: RuntimeIsolation): NodeJS.ProcessEnv => {
  const env = Object.fromEntries(Object.entries(base).filter(([name]) => !/^(GGML_|LLAMA_ARG_|MTMD_)/i.test(name) && !VULKAN_LAYER_VARIABLES.has(name.toUpperCase())));
  env.VK_LOADER_LAYERS_DISABLE = "~implicit~";
  if (isolation) {
    if (platform === "win32") env.APPDATA = isolation.configDir; else env.XDG_CONFIG_HOME = isolation.configDir;
    if (isolation.cudaCacheDir && !base.CUDA_CACHE_PATH) env.CUDA_CACHE_PATH = isolation.cudaCacheDir;
  }
  if (platform === "linux") env.LD_LIBRARY_PATH = [directory, ...(base.LD_LIBRARY_PATH ?? "").split(":").filter(entry => entry && entry !== directory)].join(":");
  return env;
};
