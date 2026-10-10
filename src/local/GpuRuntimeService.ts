import { execFile } from "child_process";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "fs";
import fs from "fs/promises";
import { createHash, randomUUID } from "crypto";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { z } from "zod";
import { childProcessEnv } from "../config/secrets";
import { diagnostics } from "../diagnostics/DiagnosticLog";
import { getFreeDiskBytes } from "./ModelCompatibility";
import { readInstalledRuntime, runtimeEnv, runtimeIsolation } from "./RuntimeInstall";
import type { GpuAccelerationSnapshot } from "./types";

// Windows: the installer brings llama.cpp's Vulkan build. On a PC with an NVIDIA GPU the app offers
// llama.cpp's CUDA build (about half again as fast), downloaded on request into the app's data:
// upstream's CUDA archive and its archive of NVIDIA's DLLs, pinned by sha256 in the runtime manifest.
// NVIDIA's license is shown before anything is downloaded; models switch without a restart, and a
// CUDA build that cannot see the GPU leaves them on Vulkan.

export const CUDA_LICENSE = { name: "NVIDIA CUDA Toolkit End User License Agreement", url: "https://docs.nvidia.com/cuda/eula/" };
/** What the window sends when the user agreed to NVIDIA's license. */
export const CUDA_LICENSE_TOKEN = "nvidia-cuda-eula";
const CUDA_NOTICE = `This folder includes NVIDIA CUDA Runtime and cuBLAS libraries, redistributed unmodified under the ${CUDA_LICENSE.name}:\n${CUDA_LICENSE.url}\n`;
// Upstream's Windows builds need Microsoft's C++ runtime: the copies bundled with the Vulkan build go along.
const VC_RUNTIME = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
const STALL_MS = 60_000;
const MiB = 1024 ** 2;

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const version = z.string().regex(/^\d+(?:\.\d+){0,3}$/);
const archive = z.object({ url: z.string().startsWith("https://"), sha256: sha, size: z.number().int().positive() });
const variantSchema = z.object({
  platform: z.string(), arch: z.string(), backend: z.literal("cuda"), executable: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  archive, overlay: archive, files: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/), sha),
  requires: z.object({ nvidiaDriver: version, minComputeCapability: version, nativeComputeCapabilities: z.array(version) }),
  installedBytes: z.number().int().positive()
});
export type CudaVariant = z.infer<typeof variantSchema> & { id: string; build: string; commit: string };

/** The CUDA builds the runtime manifest pins for this platform, the newest CUDA first. */
export const cudaVariants = (manifest: unknown, platform: string, arch: string): CudaVariant[] => {
  const root = manifest as { build?: unknown; commit?: unknown; runtimes?: Record<string, unknown> } | undefined;
  if (typeof root?.build !== "string" || typeof root.commit !== "string") return [];
  const build = root.build, commit = root.commit;
  return Object.entries(root.runtimes ?? {}).flatMap(([id, entry]) => {
    const parsed = variantSchema.safeParse(entry);
    return parsed.success && parsed.data.platform === platform && parsed.data.arch === arch && /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(id) ? [{ ...parsed.data, id, build, commit }] : [];
  }).sort((left, right) => right.id.localeCompare(left.id, undefined, { numeric: true }));
};

export interface NvidiaGpu { name: string; driver: string; computeCapability?: string; memoryBytes?: number }

/** `nvidia-smi --query-gpu=name,driver_version,memory.total,compute_cap --format=csv,noheader,nounits`;
 * older drivers answer without compute_cap. GPU names may contain commas, so fields count from the end. */
export const parseNvidiaQuery = (csv: string): NvidiaGpu[] => csv.split(/\r?\n/).flatMap(line => {
  const fields = line.split(",").map(field => field.trim());
  const withCompute = fields.length >= 4 && /^\d+\.\d+$/.test(fields.at(-1)!) && /^\d+$/.test(fields.at(-2)!);
  const tail = withCompute ? 3 : 2;
  if (fields.length < tail + 1) return [];
  const [driver, memory, compute] = fields.slice(-tail);
  const name = fields.slice(0, -tail).join(", ");
  if (!name || !/^\d+(?:\.\d+)+$/.test(driver!) || !/^\d+$/.test(memory!)) return [];
  return [{ name, driver: driver!, memoryBytes: Number(memory) * MiB, ...(withCompute ? { computeCapability: compute! } : {}) }];
});

export const compareVersions = (left: string, right: string): number => {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
};

/** The CUDA build for these GPUs. One with ready code for every GPU comes first (nothing to compile on
 * the first load); otherwise the one with the lowest requirements, whose kernels the driver compiles. */
export const chooseCudaVariant = (gpus: NvidiaGpu[], variants: CudaVariant[]): { variant?: CudaVariant; reason?: string } => {
  if (!gpus.length) return { reason: "No NVIDIA GPU was found." };
  if (!variants.length) return { reason: "This version of the app has no CUDA runtime for this computer." };
  const driver = gpus[0]!.driver;
  const fits = variants.filter(variant => compareVersions(driver, variant.requires.nvidiaDriver) >= 0
    && gpus.every(gpu => !gpu.computeCapability || compareVersions(gpu.computeCapability, variant.requires.minComputeCapability) >= 0));
  const native = fits.find(variant => gpus.every(gpu => gpu.computeCapability && variant.requires.nativeComputeCapabilities.includes(gpu.computeCapability)));
  const chosen = native ?? fits.at(-1);
  if (chosen) return { variant: chosen };
  const lowest = [...variants].sort((left, right) => compareVersions(left.requires.nvidiaDriver, right.requires.nvidiaDriver))[0]!;
  if (compareVersions(driver, lowest.requires.nvidiaDriver) < 0) return { reason: `Update the NVIDIA driver to ${lowest.requires.nvidiaDriver} or newer to use CUDA (this computer has ${driver}).` };
  return { reason: "This NVIDIA GPU is too old for the CUDA runtime." };
};

export class GpuRuntimeError extends Error { constructor(message: string, readonly code: string) { super(message); this.name = "GpuRuntimeError"; } }

const sha256File = async (file: string): Promise<string> => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
  return digest.digest("hex");
};

/** Downloads `url` to `file`, resuming a partial download; gives up only when nothing arrives for a minute. */
export const downloadResumable = async ({ url, file, size, sha256, signal, fetcher = fetch, onProgress, stallMs = STALL_MS }: {
  url: string; file: string; size: number; sha256: string; signal: AbortSignal; fetcher?: typeof fetch; onProgress?: (received: number) => void; stallMs?: number
}): Promise<void> => {
  if (existsSync(file) && (await fs.stat(file)).size === size && await sha256File(file) === sha256) return;
  const part = `${file}.part`;
  let have = await fs.stat(part).then(stat => stat.size, () => 0);
  if (have > size) { await fs.rm(part, { force: true }); have = 0; }
  if (have < size) {
    const stalled = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const alive = () => { clearTimeout(timer); timer = setTimeout(() => stalled.abort(new GpuRuntimeError("The download stopped: nothing arrived for a minute.", "stalled")), stallMs); };
    alive();
    try {
      const response = await fetcher(url, { signal: AbortSignal.any([signal, stalled.signal]), ...(have ? { headers: { Range: `bytes=${have}-` } } : {}) });
      if (response.status === 200) have = 0;   // the server sent it whole: start over
      else if (response.status !== 206 || !have) throw new GpuRuntimeError(`The download failed (HTTP ${response.status}).`, "download_failed");
      if (!response.body) throw new GpuRuntimeError("The download failed (no data).", "download_failed");
      let received = have;
      const counter = new Transform({ transform(chunk: Buffer, _encoding, done) { alive(); received += chunk.length; onProgress?.(received); done(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), counter, createWriteStream(part, { flags: have ? "a" : "w" }));
    } catch (error) {
      if (stalled.signal.aborted) throw stalled.signal.reason;
      throw error;
    } finally { clearTimeout(timer); }
  }
  if ((await fs.stat(part)).size !== size || await sha256File(part) !== sha256) {
    await fs.rm(part, { force: true });
    throw new GpuRuntimeError("The download does not match the pinned release: it was changed or cut short.", "checksum_mismatch");
  }
  await fs.rename(part, file);
};

const runFile = (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}) => new Promise<{ status: number; stdout: string; stderr: string }>(resolve => {
  execFile(file, args, { ...options, windowsHide: true, maxBuffer: 16 * MiB, encoding: "utf8" }, (error, stdout, stderr) =>
    resolve({ status: error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
});

/** Unpacks a zip archive after checking every name in it: Windows' own bsdtar (tar.exe) on Windows. */
export const extractZip = async (file: string, into: string, platform: NodeJS.Platform = process.platform): Promise<void> => {
  const tar = platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : platform === "darwin" ? "/usr/bin/tar" : undefined;
  const listing = tar ? await runFile(tar, ["-tf", file]) : await runFile("unzip", ["-Z1", file]);
  if (listing.status !== 0) throw new GpuRuntimeError("The downloaded archive could not be read.", "archive_unreadable");
  for (const name of listing.stdout.split(/\r?\n/).filter(Boolean)) {
    if (name.includes("\\") || /^[A-Za-z]:/.test(name) || name.startsWith("/") || name.split("/").includes("..")) throw new GpuRuntimeError(`The archive contains an unsafe path ${name}.`, "archive_unsafe");
  }
  const result = tar ? await runFile(tar, ["-xf", file, "-C", into]) : await runFile("unzip", ["-q", file, "-d", into]);
  if (result.status !== 0) throw new GpuRuntimeError("The downloaded archive could not be unpacked.", "archive_unreadable");
};

export interface GpuRuntimeOptions {
  /** Where downloaded runtimes live: <app data>/runtimes/llama. */
  runtimesDir: string;
  /** The bundled Vulkan runtime: its C++ runtime DLLs go along with the CUDA build. */
  bundledRuntimeDir: string;
  /** The runtime manifest that pins the CUDA builds. */
  manifestFile: string;
  /** For the runtime's isolation (its own llama.cpp configuration folder and CUDA cache). */
  dataDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetcher?: typeof fetch;
  /** nvidia-smi's CSV for the detection query, or undefined without an NVIDIA driver. */
  nvidiaSmi?: () => Promise<string | undefined>;
  run?: (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => Promise<{ status: number; stdout: string; stderr: string }>;
  changed: () => void;
  /** Switches models to the runtime now chosen (after install or removal) and reloads them. */
  activate: () => Promise<void>;
}

interface PersistedState { offerDismissed?: boolean; failed?: { id: string; reason: string } }

const defaultNvidiaSmi = (platform: NodeJS.Platform) => async (): Promise<string | undefined> => {
  const smi = platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "nvidia-smi.exe") : "nvidia-smi";
  if (platform === "win32" && !existsSync(smi)) return undefined;
  const full = await runFile(smi, ["--query-gpu=name,driver_version,memory.total,compute_cap", "--format=csv,noheader,nounits"], { timeout: 30_000 });
  if (full.status === 0) return full.stdout;
  // Drivers before compute_cap was a query field.
  const basic = await runFile(smi, ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"], { timeout: 30_000 });
  return basic.status === 0 ? basic.stdout : undefined;
};

/** Finds the NVIDIA GPU, offers the CUDA build that suits it, installs and removes it. */
export class GpuRuntimeService {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly variants: CudaVariant[];
  private gpus: NvidiaGpu[] = [];
  private detected = false;
  private chosen?: CudaVariant;
  private unavailableReason?: string;
  private state: GpuAccelerationSnapshot["cuda"]["state"] = "unavailable";
  private progress?: { receivedBytes: number; totalBytes: number; bytesPerSecond?: number };
  private error?: string;
  private persisted: PersistedState = {};
  private job?: AbortController;
  private running?: Promise<void>;
  private lastEmit = 0;
  /** While removing: models switch back to the bundled build before the files go. */
  private deactivated = false;

  constructor(private readonly options: GpuRuntimeOptions, manifest: unknown) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.variants = cudaVariants(manifest, this.platform, this.arch);
    // Read now: the runtime folder is chosen before anything else starts.
    try { this.persisted = JSON.parse(readFileSync(this.stateFile, "utf8")) as PersistedState; } catch { this.persisted = {}; }
    if (this.installedVariant()) this.state = this.persisted.failed ? "failed" : "installed";
  }

  /** The folder a variant is installed in: named by build, so an app update with a new build installs beside it. */
  private folder(variant: CudaVariant): string { return path.join(this.options.runtimesDir, `${variant.id}-${variant.build}`); }
  private get stateFile(): string { return path.join(this.options.runtimesDir, "acceleration.json"); }

  private installedVariant(): CudaVariant | undefined {
    return this.variants.find(variant => {
      const installed = readInstalledRuntime(this.folder(variant));
      return installed?.backend === "cuda" && installed.build === variant.build && existsSync(path.join(this.folder(variant), variant.executable));
    });
  }

  /** The CUDA runtime folder models should use, or undefined for the bundled build. */
  activeRuntimeDir(): string | undefined {
    const variant = this.installedVariant();
    return variant && !this.deactivated && this.persisted.failed?.id !== variant.id ? this.folder(variant) : undefined;
  }

  /** Looks for an NVIDIA GPU once (in the background after startup), or again when asked. */
  async detect(): Promise<void> {
    const output = await (this.options.nvidiaSmi ?? defaultNvidiaSmi(this.platform))().catch(() => undefined);
    this.gpus = output ? parseNvidiaQuery(output) : [];
    this.detected = true;
    const { variant, reason } = chooseCudaVariant(this.gpus, this.variants);
    this.chosen = variant; this.unavailableReason = reason;
    if (!["downloading", "installing", "removing"].includes(this.state)) {
      const installed = this.installedVariant();
      this.state = installed ? (this.persisted.failed ? "failed" : "installed") : variant ? "available" : "unavailable";
    }
    this.options.changed();
  }

  snapshot(): GpuAccelerationSnapshot {
    const variant = this.installedVariant() ?? this.chosen;
    const gpu = this.gpus[0];
    return {
      ...(gpu ? { gpu: { name: gpu.name, driver: gpu.driver, ...(gpu.computeCapability ? { computeCapability: gpu.computeCapability } : {}), ...(gpu.memoryBytes ? { memoryBytes: gpu.memoryBytes } : {}), count: this.gpus.length } } : {}),
      cuda: {
        state: this.state,
        ...(this.state === "failed" ? { reason: this.persisted.failed?.reason ?? this.error } : this.error ? { reason: this.error } : this.state === "unavailable" && this.detected && this.unavailableReason ? { reason: this.unavailableReason } : {}),
        ...(variant ? { variant: variant.id, downloadBytes: variant.archive.size + variant.overlay.size, installedBytes: variant.installedBytes } : {}),
        ...(this.progress ? { progress: this.progress } : {}),
        offer: this.state === "available" && !this.persisted.offerDismissed && !this.error,
        license: CUDA_LICENSE
      }
    };
  }

  private async persist(patch: Partial<PersistedState>): Promise<void> {
    this.persisted = { ...this.persisted, ...patch };
    for (const key of Object.keys(patch) as Array<keyof PersistedState>) if (patch[key] === undefined) delete this.persisted[key];
    await fs.mkdir(this.options.runtimesDir, { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.persisted));
    await fs.rename(temporary, this.stateFile);
  }

  /** The user declined the first-launch offer: Settings still has the button. */
  async dismissOffer(): Promise<void> { await this.persist({ offerDismissed: true }); this.options.changed(); }

  /** Checks that the CUDA build can be installed, then downloads, checks and installs it in the
   * background (progress in the snapshot) and switches models to it. */
  async install(license: unknown): Promise<void> {
    if (license !== CUDA_LICENSE_TOKEN) throw new GpuRuntimeError("Accept NVIDIA's license to install the CUDA runtime.", "license_required");
    if (this.job) return;
    if (!this.detected) await this.detect();
    const variant = this.chosen;
    if (!variant) throw new GpuRuntimeError(this.unavailableReason ?? "CUDA is not available on this computer.", "unavailable");
    await fs.mkdir(this.options.runtimesDir, { recursive: true });
    const free = await getFreeDiskBytes(this.options.runtimesDir);
    const needed = variant.archive.size + variant.overlay.size + variant.installedBytes + 256 * MiB;
    if (free !== undefined && free < needed) throw new GpuRuntimeError(`The CUDA runtime needs about ${Math.ceil(needed / 1024 ** 3)} GB of free disk space.`, "disk_space");
    const job = this.job = new AbortController();
    this.error = undefined;
    this.state = "downloading";
    await this.persist({ offerDismissed: true, failed: undefined });
    this.options.changed();
    this.running = this.run(variant, job);
  }

  /** Resolves when the install in progress has ended, however it ended. */
  whenIdle(): Promise<void> { return this.running ?? Promise.resolve(); }

  private async run(variant: CudaVariant, job: AbortController): Promise<void> {
    let stage: "download" | "install" | "check" | "activate" = "download";
    const staging = path.join(this.options.runtimesDir, `.staging-${randomUUID()}`);
    try {
      const downloads = path.join(this.options.runtimesDir, ".downloads");
      await fs.mkdir(downloads, { recursive: true });
      const total = variant.archive.size + variant.overlay.size;
      const started = Date.now();
      let done = 0;
      for (const item of [variant.archive, variant.overlay]) {
        await downloadResumable({ url: item.url, file: path.join(downloads, `${item.sha256}.zip`), size: item.size, sha256: item.sha256, signal: job.signal, fetcher: this.options.fetcher,
          onProgress: received => this.report(done + received, total, started) });
        done += item.size;
      }
      stage = "install"; this.state = "installing"; this.progress = undefined; this.options.changed();
      await fs.mkdir(staging, { recursive: true });
      await extractZip(path.join(downloads, `${variant.archive.sha256}.zip`), staging);
      if (!existsSync(path.join(staging, variant.executable))) throw new GpuRuntimeError(`The CUDA archive has no ${variant.executable}.`, "archive_invalid");
      const overlay = path.join(staging, ".overlay");
      await fs.mkdir(overlay);
      await extractZip(path.join(downloads, `${variant.overlay.sha256}.zip`), overlay);
      const overlayFiles = await fs.readdir(overlay);
      for (const name of overlayFiles) if (!Object.hasOwn(variant.files, name)) throw new GpuRuntimeError(`The NVIDIA archive contains ${name}, which the manifest does not list.`, "archive_invalid");
      for (const [name, digest] of Object.entries(variant.files)) {
        if (!overlayFiles.includes(name) || await sha256File(path.join(overlay, name)) !== digest) throw new GpuRuntimeError(`${name} does not match the pinned release.`, "checksum_mismatch");
        await fs.rename(path.join(overlay, name), path.join(staging, name));
      }
      await fs.rm(overlay, { recursive: true, force: true });
      for (const name of VC_RUNTIME) {
        if (existsSync(path.join(this.options.bundledRuntimeDir, name))) await fs.copyFile(path.join(this.options.bundledRuntimeDir, name), path.join(staging, name));
      }
      await fs.writeFile(path.join(staging, "CUDA_NOTICE.txt"), CUDA_NOTICE);
      await fs.writeFile(path.join(staging, "runtime.json"), JSON.stringify({ id: variant.id, build: variant.build, commit: variant.commit, platform: variant.platform, arch: variant.arch,
        backend: "cuda", sha256: variant.archive.sha256, overlaySha256: variant.overlay.sha256, requires: { nvidiaDriver: variant.requires.nvidiaDriver } }, null, 2));
      stage = "check";
      await this.check(variant, staging);
      const target = this.folder(variant);
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(staging, target);
      for (const item of [variant.archive, variant.overlay]) await fs.rm(path.join(downloads, `${item.sha256}.zip`), { force: true });
      this.state = "installed";
      this.options.changed();
      stage = "activate";
      await this.options.activate();
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      const cancelled = job.signal.aborted;
      this.state = this.installedVariant() ? "installed" : "available";
      this.error = cancelled ? undefined : error instanceof Error ? error.message : String(error);
      if (!cancelled) diagnostics().record("local_runtime.install_failed", { backend: "cuda", stage, code: error instanceof GpuRuntimeError ? error.code : "unknown" });
    } finally {
      if (this.job === job) this.job = undefined;
      this.progress = undefined;
      this.options.changed();
    }
  }

  private report(received: number, total: number, started: number): void {
    const seconds = (Date.now() - started) / 1000;
    this.progress = { receivedBytes: received, totalBytes: total, ...(seconds > 1 ? { bytesPerSecond: Math.round(received / seconds) } : {}) };
    if (Date.now() - this.lastEmit >= 500) { this.lastEmit = Date.now(); this.options.changed(); }
  }

  /** The new build must start and see a CUDA device before any model uses it. */
  private async check(variant: CudaVariant, directory: string): Promise<void> {
    const run = this.options.run ?? ((file, args, options) => runFile(file, args, options));
    const env = runtimeEnv(childProcessEnv(), directory, this.platform, runtimeIsolation(this.options.dataDir));
    const options = { cwd: directory, env, timeout: 120_000 };
    const version = await run(path.join(directory, variant.executable), ["--version"], options);
    if (version.status !== 0 || !`${version.stdout}${version.stderr}`.includes(variant.build.replace(/^b/, ""))) throw new GpuRuntimeError("The CUDA runtime did not start.", "check_failed");
    const devices = await run(path.join(directory, variant.executable), ["--list-devices"], options);
    if (!/^\s*CUDA\d+:/m.test(devices.stdout)) {
      throw new GpuRuntimeError(`The CUDA runtime does not see the GPU. Update the NVIDIA driver to ${variant.requires.nvidiaDriver} or newer and try again.`, "no_cuda_device");
    }
  }

  /** Why the CUDA build in use cannot run models on the GPU (it does not start or lists no CUDA device), or undefined. */
  async problem(): Promise<string | undefined> {
    const variant = this.installedVariant();
    if (!variant || !this.activeRuntimeDir()) return undefined;
    try { await this.check(variant, this.folder(variant)); return undefined; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  /** The switched runtime could not use the GPU: models stay on the bundled build, and the reason shows. */
  async markFailed(reason: string): Promise<void> {
    const variant = this.installedVariant();
    if (!variant) return;
    this.state = "failed";
    await this.persist({ failed: { id: variant.id, reason } });
    this.options.changed();
  }

  /** Stops a download; what arrived is kept, so installing again continues it. */
  cancel(): void { this.job?.abort(new GpuRuntimeError("Cancelled.", "cancelled")); }

  /** Back to the bundled build, then the CUDA files go. */
  async remove(): Promise<void> {
    if (this.job) throw new GpuRuntimeError("The CUDA runtime is being installed.", "busy");
    const variants = this.variants.filter(variant => existsSync(this.folder(variant)));
    if (!variants.length) return;
    this.state = "removing";
    this.deactivated = true;
    this.options.changed();
    try {
      await this.options.activate();
      // Windows keeps a DLL's folder while a process still holds it: a few tries.
      for (const variant of variants) await fs.rm(this.folder(variant), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      await this.persist({ failed: undefined });
    } finally {
      this.deactivated = false;
      this.state = this.installedVariant() ? "installed" : this.chosen ? "available" : "unavailable";
      this.options.changed();
    }
  }
}
