import type { InventoryDevice } from "./DeviceInventory";
import type { ModelMemoryEstimate } from "./ModelCompatibility";

const MiB = 1024 ** 2;
const GB = 1024 ** 3;

export type PlacementKind = "unified" | "single-gpu" | "multi-gpu" | "partial" | "cpu";
const ladder: PlacementKind[] = ["single-gpu", "multi-gpu", "partial", "cpu"];

export interface ResidentModel { modelId: string; deviceBytes: Record<string, number>; hostBytes: number }
export interface PlacementPolicy { gpuHeadroomBytes: number; gpuContextBytes: number; computeBytes: number; safetyFactor: number }
// Measured on a GTX 1070 Ti (CUDA 12, Qwen2.5-14B Q4_K_M, 4096 context): CUDA context and compute
// buffers took ~765 MiB, each offloaded layer ~171 MiB. The headroom absorbs driver and display variance.
export const defaultPlacementPolicy: PlacementPolicy = { gpuHeadroomBytes: 512 * MiB, gpuContextBytes: 384 * MiB, computeBytes: 384 * MiB, safetyFactor: 1 };

export interface PlacementInput {
  modelId: string;
  estimate: ModelMemoryEstimate;
  contextSize: number;
  devices: InventoryDevice[];
  system: { totalBytes: number };
  residents: ResidentModel[];
  gpuLayers: number | "auto";
  /** The runtime is a GPU build: a CPU placement must keep it off the GPUs explicitly. */
  gpuRuntime?: boolean;
  policy?: Partial<PlacementPolicy>;
  /** Retry after an out-of-memory failure: only kinds after this one are tried, except that a
   * partial placement is first retried with fewer layers (scaled by the policy's safety factor). */
  after?: PlacementKind;
}

export interface PlannedDevice { id: string; backendName: string; index: number; name: string; estimatedBytes: number }
export interface PlacementPlan {
  kind: PlacementKind;
  manual: boolean;
  label: string;
  devices: PlannedDevice[];
  tensorSplit?: number[];
  gpuLayers: number | "all";
  hostBytes: number;
  warnings: string[];
  launch: { args: string[]; env: Record<string, string> };
}
export type PlacementOption = { action: "unload"; modelId: string; freesBytes: number } | { action: "reduce_context"; contextSize: number } | { action: "smaller_quantization" };
export interface PlacementFailure { kind: "error"; message: string; options: PlacementOption[] }

const gb = (bytes: number) => (bytes / GB).toFixed(1);

const launchFor = (devices: InventoryDevice[], layers: number | "all", tensorSplit?: number[]): PlacementPlan["launch"] => {
  const ordered = [...devices].sort((left, right) => left.index - right.index);
  const env: Record<string, string> = {};
  let names = ordered.map(device => device.backendName);
  if (ordered.every(device => device.backendName.startsWith("CUDA"))) {
    env.CUDA_DEVICE_ORDER = "PCI_BUS_ID";
    // Restricting each process to its GPUs keeps other models' processes off them.
    if (ordered.every(device => device.uuid)) { env.CUDA_VISIBLE_DEVICES = ordered.map(device => device.uuid).join(","); names = ordered.map((_, index) => `CUDA${index}`); }
  }
  const args = ["--device", names.join(",")];
  if (tensorSplit && ordered.length > 1) args.push("--split-mode", "layer", "--tensor-split", tensorSplit.join(","));
  // The planner already fixed devices and layers; llama.cpp's own fitting would only re-probe.
  args.push("--n-gpu-layers", String(layers), "--fit", "off");
  return { args, env };
};

const label = (devices: InventoryDevice[], suffix = "") =>
  devices.map(device => `GPU ${device.index}`).join(" + ") + suffix;

const subsets = <T>(items: T[], size: number): T[][] => {
  if (size === 0) return [[]];
  return items.flatMap((item, index) => subsets(items.slice(index + 1), size - 1).map(rest => [item, ...rest]));
};

/** Chooses where a model runs. GPU always comes first; the CPU gets only what does not fit.
 * Nothing already loaded is evicted: without room, the result explains the options. */
export const planPlacement = (input: PlacementInput): PlacementPlan | PlacementFailure => {
  const policy = { ...defaultPlacementPolicy, ...input.policy };
  const { estimate } = input;
  const hostUsed = input.residents.reduce((sum, resident) => sum + resident.hostBytes, 0);
  const hostBudget = input.system.totalBytes - hostUsed;
  const unified = input.devices.find(device => device.kind === "unified");

  const failure = (capacityBytes: number): PlacementFailure => {
    const options: PlacementOption[] = [...input.residents]
      .map(resident => ({ action: "unload" as const, modelId: resident.modelId, freesBytes: resident.hostBytes + Object.values(resident.deviceBytes).reduce((sum, bytes) => sum + bytes, 0) }))
      .sort((left, right) => right.freesBytes - left.freesBytes);
    const deficit = estimate.totalBytes - capacityBytes;
    if (estimate.kvCacheBytes > deficit && input.contextSize > 0) {
      const perToken = estimate.kvCacheBytes / input.contextSize;
      const contextSize = Math.floor((estimate.kvCacheBytes - deficit) / perToken / 1024) * 1024;
      if (contextSize >= 512 && contextSize < input.contextSize) options.push({ action: "reduce_context", contextSize });
    }
    options.push({ action: "smaller_quantization" });
    const hints = [
      ...options.filter(option => option.action === "unload").slice(0, 2).map(option => `unload ${(option as { modelId: string }).modelId} (~${gb((option as { freesBytes: number }).freesBytes)} GB)`),
      ...options.filter(option => option.action === "reduce_context").map(option => `reduce context to ${(option as { contextSize: number }).contextSize} tokens`),
      "choose a smaller quantization"
    ];
    const gpuFree = input.devices.filter(device => device.kind === "gpu").reduce((sum, device) => sum + device.freeBytes, 0);
    return { kind: "error", options, message: `Not enough memory to load ${input.modelId}: it needs about ${gb(estimate.totalBytes)} GB; ` +
      `${gb(gpuFree)} GB is free on GPUs and ${gb(Math.max(0, hostBudget))} GB in RAM. To load it, ${hints.join(", ")}.` };
  };

  // Apple Silicon: one memory pool; layers default to the GPU as before.
  if (unified) {
    const layers = input.gpuLayers === "auto" ? 99 : input.gpuLayers;
    if (estimate.weightsBytes + estimate.projectorBytes > hostBudget) return failure(hostBudget);
    const warnings = estimate.totalBytes > hostBudget ? [`Estimated memory use (${gb(estimate.totalBytes)} GB) exceeds the memory left by loaded models (${gb(hostBudget)} GB). Loading may swap or fail.`] : [];
    return { kind: "unified", manual: input.gpuLayers !== "auto", label: layers === 0 ? "CPU" : "Metal", devices: [], gpuLayers: layers, hostBytes: estimate.totalBytes,
      warnings, launch: { args: ["--n-gpu-layers", String(layers)], env: {} } };
  }

  const gpus = input.devices.filter(device => device.kind === "gpu").sort((left, right) => left.index - right.index);
  const residentOn = (device: InventoryDevice) => input.residents.reduce((sum, resident) => sum + (resident.deviceBytes[device.id] ?? 0), 0);
  const usable = (device: InventoryDevice) =>
    Math.min(device.freeBytes, device.totalBytes - residentOn(device)) - policy.gpuHeadroomBytes - policy.gpuContextBytes - policy.computeBytes;
  const need = ((estimate.weightsBytes + estimate.projectorBytes) * 1.1 + estimate.kvCacheBytes + estimate.recurrentStateBytes) * policy.safetyFactor;
  const totalLayers = estimate.layers + 1;
  const planned = (devices: InventoryDevice[], bytes: (device: InventoryDevice) => number): PlannedDevice[] =>
    devices.map(device => ({ id: device.id, backendName: device.backendName, index: device.index, name: device.name, estimatedBytes: Math.round(bytes(device)) }));
  const splitFor = (devices: InventoryDevice[]) => devices.map(device => Math.max(1, Math.floor(usable(device) / MiB)));

  const cpuPlan = (explicit: boolean): PlacementPlan | PlacementFailure => {
    if (estimate.weightsBytes + estimate.projectorBytes > hostBudget) return failure(hostBudget + gpus.reduce((sum, device) => sum + Math.max(0, usable(device)), 0));
    const warnings: string[] = [];
    if (gpus.length && !explicit) warnings.push("No GPU has enough free memory; the model runs on the CPU and responses will be slow.");
    if (estimate.totalBytes > hostBudget) warnings.push(`Estimated memory use (${gb(estimate.totalBytes)} GB) exceeds the RAM left by loaded models (${gb(hostBudget)} GB). Loading may swap or fail.`);
    // With GPUs present, --device none keeps the CPU-only process from creating GPU contexts
    // (a GPU build also offloads prompt processing to a GPU with zero layers).
    const args = gpus.length || input.gpuRuntime ? ["--device", "none", "--n-gpu-layers", "0", "--fit", "off"] : ["--n-gpu-layers", "0"];
    return { kind: "cpu", manual: explicit, label: "CPU", devices: [], gpuLayers: 0, hostBytes: estimate.totalBytes, warnings, launch: { args, env: {} } };
  };

  if (input.gpuLayers === 0) return cpuPlan(true);
  if (!gpus.length) return cpuPlan(false);

  const singleFit = (bytes = need): InventoryDevice | undefined => {
    const fitting = gpus.filter(device => usable(device) >= bytes);
    // Prefer an idle GPU so models run in parallel; then the tightest fit keeps large GPUs free.
    const pool = fitting.some(device => residentOn(device) === 0) ? fitting.filter(device => residentOn(device) === 0) : fitting;
    return pool.sort((left, right) => (usable(left) - bytes) - (usable(right) - bytes) || left.index - right.index)[0];
  };
  const multiFit = (bytes = need): InventoryDevice[] | undefined => {
    for (let size = 2; size <= Math.min(gpus.length, 8); size++) {
      const feasible = subsets(gpus, size).filter(set => set.reduce((sum, device) => sum + usable(device), 0) >= bytes + size * estimate.perLayerBytes &&
        usable(set[0]!) >= estimate.projectorBytes * 1.1);
      if (feasible.length) return feasible.sort((left, right) => left.reduce((sum, device) => sum + usable(device), 0) - right.reduce((sum, device) => sum + usable(device), 0))[0];
    }
    return undefined;
  };

  // A user-chosen layer count is passed as is; placement only picks the devices.
  if (input.gpuLayers !== "auto") {
    const layers = Math.min(input.gpuLayers, totalLayers);
    const partly = layers < totalLayers && estimate.perLayerBytes > 0;
    const gpuBytes = partly ? estimate.projectorBytes * 1.1 + layers * estimate.perLayerBytes : need;
    const single = singleFit(gpuBytes), multi = single ? undefined : multiFit(gpuBytes), devices = single ? [single] : multi ?? gpus.filter(device => usable(device) > 0);
    if (!devices.length) return cpuPlan(false);
    const warnings = !single && !multi ? [`${layers} GPU layers may not fit in free GPU memory; loading can fail.`] : [];
    const tensorSplit = devices.length > 1 ? splitFor(devices) : undefined;
    return { kind: partly ? "partial" : devices.length > 1 ? "multi-gpu" : "single-gpu", manual: true,
      label: label(devices, partly ? ` · partly CPU (${layers}/${totalLayers} layers)` : ""), devices: planned(devices, () => gpuBytes / devices.length),
      tensorSplit, gpuLayers: input.gpuLayers, hostBytes: partly ? (totalLayers - layers) * estimate.perLayerBytes + policy.computeBytes : policy.computeBytes,
      warnings, launch: { ...launchFor(devices, input.gpuLayers, tensorSplit) } };
  }

  const start = input.after ? ladder.indexOf(input.after) + (input.after === "partial" ? 0 : 1) : 0;
  for (const kind of ladder.slice(start)) {
    if (kind === "single-gpu") {
      const device = singleFit();
      if (device) return { kind, manual: false, label: label([device]), devices: planned([device], () => need), gpuLayers: "all", hostBytes: policy.computeBytes,
        warnings: [], launch: launchFor([device], "all") };
    }
    if (kind === "multi-gpu") {
      const devices = multiFit();
      if (devices) {
        const tensorSplit = splitFor(devices), total = tensorSplit.reduce((sum, value) => sum + value, 0);
        return { kind, manual: false, label: label(devices), devices: planned(devices, device => need * Math.max(1, Math.floor(usable(device) / MiB)) / total),
          tensorSplit, gpuLayers: "all", hostBytes: policy.computeBytes, warnings: [], launch: launchFor(devices, "all", tensorSplit) };
      }
    }
    if (kind === "partial" && estimate.layers > 0 && estimate.perLayerBytes > 0) {
      const perLayer = estimate.perLayerBytes * policy.safetyFactor;
      const devices = gpus.filter(device => usable(device) > perLayer);
      const room = devices.reduce((sum, device) => sum + usable(device), 0) - estimate.projectorBytes * 1.1 - devices.length * perLayer;
      const layers = Math.min(estimate.layers, Math.floor(room / perLayer));
      if (devices.length && layers >= 1) {
        const hostBytes = (totalLayers - layers) * estimate.perLayerBytes + policy.computeBytes;
        if (hostBytes > hostBudget) return failure(hostBudget + devices.reduce((sum, device) => sum + usable(device), 0));
        const tensorSplit = devices.length > 1 ? splitFor(devices) : undefined;
        return { kind, manual: false, label: label(devices, ` · partly CPU (${layers}/${totalLayers} layers)`), devices: planned(devices, device => usable(device)),
          tensorSplit, gpuLayers: layers, hostBytes,
          warnings: [`Only ${layers} of ${totalLayers} layers fit in GPU memory; the rest runs on the CPU and responses will be slower.`],
          launch: launchFor(devices, layers, tensorSplit) };
      }
    }
    if (kind === "cpu") return cpuPlan(false);
  }
  return cpuPlan(false);
};
