import fs from "fs";
import path from "path";
import { readInstalledRuntime } from "../local/RuntimeInstall";
import type { InferencePreference } from "./args";
import { CliError, ExitCode } from "./exitCodes";

export interface InferenceSelection {
  preference: InferencePreference;
  /** Backend of the selected build, from its runtime.json (cuda, cpu, metal). */
  backend: string;
  runtimeDir: string;
  runtimeId: string;
  fallbackReason?: string;
}

const hasExecutable = (directory: string) => fs.existsSync(path.join(directory, process.platform === "win32" ? "llama-server.exe" : "llama-server"));
const pinnedBuild = (llama: string): string | undefined => {
  try { return (JSON.parse(fs.readFileSync(path.join(llama, "runtime-manifest.json"), "utf8")) as { build?: string }).build; } catch { return undefined; }
};
const nvidiaDriverPresent = () => ["/proc/driver/nvidia/version", "/dev/nvidiactl"].some(file => fs.existsSync(file));

/** Why a prepared CUDA directory cannot be used, or undefined when it can. */
const cudaProblem = (directory: string, build: string | undefined): { text: string; installed: boolean } | undefined => {
  if (!hasExecutable(directory)) return { text: `the CUDA runtime is not installed in ${directory}.`, installed: false };
  const installed = readInstalledRuntime(directory);
  if (installed?.backend !== "cuda") return { text: `${directory} has no CUDA runtime.json.`, installed: true };
  if (build && installed.build !== build) return { text: `the CUDA runtime is llama.cpp ${installed.build ?? "of an unknown build"}, but this release uses ${build}. Prepare it again.`, installed: true };
  return undefined;
};

/** Chooses the llama.cpp runtime directory. The runtime probes devices again before loading a
 * model; this only decides which build is used and records why CUDA is not. */
export const selectInference = (preference: InferencePreference,
  options: { release: string; override?: string; platform?: string; arch?: string; nvidiaDriverPresent?: () => boolean }): InferenceSelection => {
  if (options.override) {
    const runtimeDir = path.resolve(options.override), installed = readInstalledRuntime(runtimeDir);
    const backend = installed?.backend ?? "cpu";
    if (preference === "cuda" && backend !== "cuda") throw new CliError(`CUDA was requested, but ${runtimeDir} is not a CUDA runtime.`, ExitCode.config);
    if (preference === "cpu" && backend === "cuda") throw new CliError(`--inference cpu cannot use the CUDA runtime in ${runtimeDir}.`, ExitCode.config);
    return { preference, backend, runtimeDir, runtimeId: installed?.id ?? path.basename(runtimeDir) };
  }
  const llama = path.join(options.release, "resources", "llama"), id = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`;
  const base = path.join(llama, id), cudaId = `${id}-cuda12`, cuda = path.join(llama, cudaId);
  const cpu = (fallbackReason?: string): InferenceSelection =>
    ({ preference, backend: readInstalledRuntime(base)?.backend ?? "cpu", runtimeDir: base, runtimeId: id, ...(fallbackReason ? { fallbackReason } : {}) });
  if (preference === "cpu") return cpu();
  const problem = cudaProblem(cuda, pinnedBuild(llama));
  if (!problem) return { preference, backend: "cuda", runtimeDir: cuda, runtimeId: cudaId };
  if (preference === "cuda") throw new CliError(`CUDA was requested, but ${problem.text}`, ExitCode.config);
  // A host without an NVIDIA driver is expected to run on the CPU: nothing to explain.
  const explain = problem.installed || (options.nvidiaDriverPresent ?? nvidiaDriverPresent)();
  return cpu(explain ? `CUDA is not used: ${problem.text} Models run on the CPU.` : undefined);
};
