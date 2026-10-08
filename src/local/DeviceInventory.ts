import { execFile } from "child_process";
import path from "path";
import { childProcessEnv } from "../config/secrets";
import { runtimeEnv } from "./RuntimeInstall";
import { getSystemMemory, SystemMemory } from "../utils/systemMemory";

const MiB = 1024 ** 2;

export interface InventoryDevice {
  /** GPU UUID when known, otherwise the backend name. Stable across launches. */
  id: string;
  /** Name accepted by llama-server --device, as probed (CUDA0, Vulkan1, MTL0, ...). */
  backendName: string;
  /** Ordinal in PCI order. */
  index: number;
  name: string;
  kind: "gpu" | "unified";
  totalBytes: number;
  freeBytes: number;
  uuid?: string;
  pciBusId?: string;
}

export interface DeviceSnapshot {
  devices: InventoryDevice[]; probedAt: number; warnings: string[];
  /** Why a CUDA runtime runs models on the CPU. */
  fallbackReason?: string;
}
export interface GpuMetric { id: string; index: number; name: string; totalBytes: number; usedBytes: number; freeBytes: number }

export interface DeviceProbe {
  platform: NodeJS.Platform;
  listDevices(): Promise<string>;
  /** nvidia-smi CSV, or undefined when the tool is unavailable. */
  nvidiaSmi(): Promise<string | undefined>;
  systemMemory(): SystemMemory;
  /** CUDA_VISIBLE_DEVICES of this process: probed device numbers refer to this subset. */
  parentVisibleDevices?: string;
  /** Backend of the installed runtime, from its runtime.json. */
  expectedBackend?: string;
}

interface ListedDevice { backendName: string; name: string; totalBytes: number; freeBytes: number }
interface SmiDevice { index: number; uuid: string; pciBusId: string; name: string; totalBytes: number; usedBytes: number; freeBytes: number }

/** Parses `llama-server --list-devices` (stdout). Host-only backends report 0 MiB and are skipped. */
export const parseListDevices = (stdout: string): ListedDevice[] => stdout.split(/\r?\n/).flatMap(line => {
  const match = /^ {2}(\S+): (.*) \((\d+) MiB, (\d+) MiB free\)$/.exec(line);
  if (!match || Number(match[3]) === 0) return [];
  return [{ backendName: match[1]!, name: match[2]!, totalBytes: Number(match[3]) * MiB, freeBytes: Number(match[4]) * MiB }];
});

/** Parses `nvidia-smi --query-gpu=index,uuid,pci.bus_id,name,memory.total,memory.used,memory.free --format=csv,noheader,nounits`. */
export const parseNvidiaSmi = (csv: string): SmiDevice[] => csv.split(/\r?\n/).flatMap(line => {
  const fields = line.split(",").map(field => field.trim());
  if (fields.length < 7) return [];
  // GPU names may contain commas: the first three and last three fields are fixed.
  const [index, uuid, pciBusId] = fields, [total, used, free] = fields.slice(-3);
  const name = fields.slice(3, -3).join(", ");
  const numbers = [index, total, used, free].map(Number);
  if (numbers.some(value => !Number.isFinite(value)) || !uuid?.startsWith("GPU-")) return [];
  return [{ index: numbers[0]!, uuid, pciBusId: pciBusId!, name, totalBytes: numbers[1]! * MiB, usedBytes: numbers[2]! * MiB, freeBytes: numbers[3]! * MiB }];
}).sort((left, right) => left.pciBusId.localeCompare(right.pciBusId));

/** Applies a parent CUDA_VISIBLE_DEVICES (indices or UUIDs) to the PCI-ordered rows. */
const visibleRows = (rows: SmiDevice[], parentVisible?: string): SmiDevice[] | undefined => {
  if (parentVisible === undefined || parentVisible.trim() === "") return rows;
  const entries = parentVisible.split(",").map(entry => entry.trim()).filter(Boolean);
  const selected = entries.map(entry => /^\d+$/.test(entry) ? rows.find(row => row.index === Number(entry)) : rows.find(row => row.uuid === entry));
  return selected.every(Boolean) ? selected as SmiDevice[] : undefined;
};

/** Maps CUDAi (PCI order with CUDA_DEVICE_ORDER=PCI_BUS_ID) to the i-th visible nvidia-smi row. */
export const mergeDevices = (listed: ListedDevice[], smi: SmiDevice[] | undefined, parentVisible?: string): { devices: InventoryDevice[]; warnings: string[] } => {
  const warnings: string[] = [];
  const cuda = listed.filter(device => /^CUDA\d+$/.test(device.backendName));
  const rows = smi ? visibleRows(smi, parentVisible) : undefined;
  const mapped = rows && rows.length === cuda.length && cuda.every((device, index) => device.name === rows[index]!.name);
  if (cuda.length && smi && !mapped) warnings.push("GPU identities could not be matched with nvidia-smi; devices are identified by their CUDA order.");
  const devices = listed.map((device, index): InventoryDevice => {
    const row = mapped && /^CUDA(\d+)$/.test(device.backendName) ? rows![Number(device.backendName.slice(4))] : undefined;
    return { id: row?.uuid ?? device.backendName, backendName: device.backendName, index: row ? rows!.indexOf(row) : index, name: device.name,
      kind: "gpu", totalBytes: device.totalBytes, freeBytes: device.freeBytes, uuid: row?.uuid, pciBusId: row?.pciBusId };
  });
  return { devices, warnings };
};

const run = (file: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) => new Promise<string>((resolve, reject) => {
  execFile(file, args, { env, cwd, timeout: 30_000, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

export const createProcessProbe = (executable: string, expectedBackend?: string): DeviceProbe => {
  // Same directory and environment as a model launch, so the probe sees the same backends.
  const directory = path.dirname(executable);
  const env = { ...runtimeEnv(childProcessEnv(), directory), CUDA_DEVICE_ORDER: "PCI_BUS_ID" };
  return {
    platform: process.platform,
    listDevices: () => run(executable, ["--list-devices"], env, directory),
    nvidiaSmi: () => run("nvidia-smi", ["--query-gpu=index,uuid,pci.bus_id,name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"], env)
      .catch(() => undefined),
    systemMemory: getSystemMemory,
    parentVisibleDevices: process.env.CUDA_VISIBLE_DEVICES,
    expectedBackend
  };
};

/** Free memory per device, measured before each model load. On macOS the GPU shares system RAM,
 * so it is one "unified" device; Metal's reported free memory ignores other processes. */
export class DeviceInventory {
  private snapshot?: DeviceSnapshot;
  private metrics?: GpuMetric[];
  private metricsAt = 0;
  private metricsRefresh?: Promise<void>;
  private smiMissing = false;

  constructor(private readonly probe: DeviceProbe) {}

  cached(): DeviceSnapshot | undefined { return this.snapshot; }

  async probeDevices(): Promise<DeviceSnapshot> {
    if (this.probe.platform === "darwin") {
      const memory = this.probe.systemMemory();
      return this.snapshot = { devices: [{ id: "unified", backendName: "MTL0", index: 0, name: "Unified memory", kind: "unified", totalBytes: memory.total, freeBytes: memory.free }],
        probedAt: Date.now(), warnings: [] };
    }
    const warnings: string[] = [];
    const [listed, smiOutput] = await Promise.all([
      this.probe.listDevices().then(parseListDevices, () => undefined),
      this.smiMissing ? Promise.resolve(undefined) : this.probe.nvidiaSmi()
    ]);
    const smi = smiOutput === undefined ? undefined : parseNvidiaSmi(smiOutput);
    let devices: InventoryDevice[];
    if (listed) {
      const merged = mergeDevices(listed, smi, this.probe.parentVisibleDevices);
      devices = merged.devices; warnings.push(...merged.warnings);
    } else if (smi?.length && this.probe.expectedBackend !== "cpu") {
      // Only a GPU build can use these; a CPU build that cannot list devices runs on the CPU.
      const rows = visibleRows(smi, this.probe.parentVisibleDevices) ?? smi;
      devices = rows.map((row, index) => ({ id: row.uuid, backendName: `CUDA${index}`, index, name: row.name, kind: "gpu", totalBytes: row.totalBytes,
        freeBytes: row.freeBytes, uuid: row.uuid, pciBusId: row.pciBusId }));
      warnings.push("The runtime could not list devices; GPU memory comes from nvidia-smi.");
    } else devices = [];
    let fallbackReason: string | undefined;
    if (this.probe.expectedBackend === "cuda" && !devices.some(device => device.backendName.startsWith("CUDA"))) {
      fallbackReason = smi?.length ? "An NVIDIA GPU was found, but the CUDA runtime cannot use it. Update the NVIDIA driver to 570 or newer."
        : "No NVIDIA GPU or driver was found.";
      warnings.push(`${fallbackReason} Models run on the CPU.`);
    }
    return this.snapshot = { devices, probedAt: Date.now(), warnings, ...(fallbackReason ? { fallbackReason } : {}) };
  }

  /** Cached per-GPU memory for host metrics; refreshes in the background at most every 5 s. */
  gpuMetrics(): GpuMetric[] | undefined {
    if (this.probe.platform === "darwin" || this.smiMissing) return undefined;
    if (!this.metricsRefresh && Date.now() - this.metricsAt > 5_000) {
      this.metricsRefresh = this.probe.nvidiaSmi().then(output => {
        if (output === undefined) { this.smiMissing = true; this.metrics = undefined; return; }
        this.metrics = parseNvidiaSmi(output).map((row, index) => ({ id: row.uuid, index, name: row.name, totalBytes: row.totalBytes, usedBytes: row.usedBytes, freeBytes: row.freeBytes }));
      }).finally(() => { this.metricsAt = Date.now(); this.metricsRefresh = undefined; });
    }
    return this.metrics?.length ? this.metrics : undefined;
  }
}
