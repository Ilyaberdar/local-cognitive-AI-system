import { LLMRequest, LLMResponse } from "../types";
import { Logger } from "../utils/Logger";
import { getSystemMemory } from "../utils/systemMemory";
import { DeviceInventory, createProcessProbe } from "./DeviceInventory";
import { LlamaCppRuntime, RuntimeLaunch } from "./LlamaCppRuntime";
import { InstalledRuntime, llamaExecutable, readInstalledRuntime, runtimeDirOf } from "./RuntimeInstall";
import type { ModelMemoryEstimate } from "./ModelCompatibility";
import { planPlacement, PlacementPlan, ResidentModel } from "./PlacementPlanner";
import { LocalModelError, LocalModelOptions, LocalPlacementSnapshot, LocalRuntimeSnapshot } from "./types";

const backendOf = (plan: PlacementPlan, devices: { backendName: string }[]) =>
  plan.kind === "unified" ? plan.label : plan.kind === "cpu" ? "CPU" : devices[0]?.backendName.replace(/\d+$/, "") || "GPU";

const toSnapshot = (plan: PlacementPlan, retried: boolean): LocalPlacementSnapshot => ({
  kind: plan.kind, label: plan.label, backend: backendOf(plan, plan.devices),
  devices: plan.devices.map(({ id, index, name, estimatedBytes }) => ({ id, index, name, estimatedBytes })),
  gpuLayers: plan.gpuLayers, tensorSplit: plan.tensorSplit, hostEstimatedBytes: plan.hostBytes, warnings: plan.warnings, ...(retried ? { retried } : {})
});

/** Resident models own independent processes. Loading one never evicts another. Loads are
 * serialised so two models never plan against the same free memory; inference of loaded
 * models is not blocked by a load. */
export class LocalRuntimePool {
  private readonly instances = new Map<string, LlamaCppRuntime>();
  private readonly probe: LlamaCppRuntime;
  private inventory: DeviceInventory;
  private probeOptions: LocalModelOptions;
  private installed?: InstalledRuntime;
  private loadLock: Promise<void> = Promise.resolve();

  constructor(private options: LocalModelOptions, private readonly logger: Logger, private readonly changed: () => void, inventory?: DeviceInventory) {
    this.probe = new LlamaCppRuntime(options, logger, changed);
    this.installed = readInstalledRuntime(runtimeDirOf(options));
    this.inventory = inventory ?? new DeviceInventory(createProcessProbe(llamaExecutable(options), this.installed?.backend));
    this.probeOptions = options;
  }
  get status(): LocalRuntimeSnapshot["status"] { return this.snapshot().status; }
  get currentModelId(): string | undefined { return this.snapshot().modelId; }
  async init(): Promise<void> {
    await this.probe.init();
    // An early probe shows the real backend and GPU memory before the first load.
    if (this.gpuRuntime() && this.options.gpuLayers !== 0) void this.inventory.probeDevices().then(() => this.changed(), () => undefined);
  }
  forModel(id: string): LocalRuntimeSnapshot | undefined { return this.instances.get(id)?.snapshot(); }
  snapshot(): LocalRuntimeSnapshot {
    const instances = [...this.instances.values()].map(runtime => runtime.snapshot()).filter(runtime => runtime.modelId);
    const idle = this.probe.snapshot();
    const selected = instances.find(runtime => runtime.status === "loading")
      ?? instances.find(runtime => runtime.status === "ready")
      ?? instances.find(runtime => runtime.status === "error") ?? { ...idle, backend: this.idleBackend(idle.backend) };
    const fallbackReason = this.fallbackReason();
    return { ...selected, modelId: instances.length === 1 ? instances[0].modelId : undefined,
      loadedModelIds: instances.filter(runtime => runtime.status === "ready").map(runtime => runtime.modelId!), instances,
      ...(this.installed?.id ? { runtimeId: this.installed.id } : {}), ...(fallbackReason ? { fallbackReason } : {}) };
  }
  /** Per-GPU memory for host metrics (cached; undefined without NVIDIA GPUs). */
  gpuMetrics() { return this.inventory.gpuMetrics(); }
  /** RAM plus the last measured discrete GPU memory: what a model may occupy in total. */
  memoryCapacity(): { total: number; free: number } {
    const memory = getSystemMemory();
    const gpus = (this.inventory.cached()?.devices ?? []).filter(device => device.kind === "gpu");
    return { total: memory.total + gpus.reduce((sum, device) => sum + device.totalBytes, 0), free: memory.free + gpus.reduce((sum, device) => sum + device.freeBytes, 0) };
  }

  /** With an estimate, the model is placed on GPUs and CPU by free memory; without one, the
   * configured GPU layers are used as before. */
  async load(id: string, file: string, signal?: AbortSignal, projector?: string, estimate?: ModelMemoryEstimate): Promise<void> {
    let runtime = this.instances.get(id);
    if (runtime?.isReadyFor(id, projector)) return;
    if (!runtime) {
      runtime = new LlamaCppRuntime(this.options, this.logger, this.changed);
      this.instances.set(id, runtime);
    }
    const target = runtime;
    await this.exclusive(signal, async () => {
      if (target.isReadyFor(id, projector)) return;
      if (!estimate) { await target.load(id, file, signal, projector); return; }
      await target.stop();
      let plan = await this.plan(id, estimate);
      try {
        await target.load(id, file, signal, projector, this.launch(plan, false));
      } catch (error) {
        // One retry with the next layout: estimates can be short for a specific model or driver.
        if (!(error instanceof LocalModelError) || error.code !== "out_of_memory" || plan.manual || plan.kind === "unified" || plan.kind === "cpu" || signal?.aborted) throw error;
        this.logger.warn("Model ran out of memory; retrying with another placement", { modelId: id, placement: plan.kind });
        await new Promise(resolve => setTimeout(resolve, 500));
        plan = await this.plan(id, estimate, { after: plan.kind, policy: { safetyFactor: 1.2 } });
        await target.load(id, file, signal, projector, this.launch(plan, true));
      }
    });
  }

  async generateText(request: LLMRequest): Promise<LLMResponse> {
    const runtime = this.instances.get(request.model ?? "");
    if (!runtime) throw new LocalModelError("The selected local model is not loaded.", 503);
    return runtime.generateText(request);
  }
  async stop(id?: string): Promise<void> {
    if (id) await this.instances.get(id)?.stop();
    else await Promise.all([...this.instances.values()].map(runtime => runtime.stop()));
  }
  async reconfigure(options: LocalModelOptions): Promise<void> {
    await Promise.all([...this.instances.values()].map(runtime => runtime.dispose()));
    this.instances.clear(); this.options = options;
    const installed = readInstalledRuntime(runtimeDirOf(options));
    if (llamaExecutable(options) !== llamaExecutable(this.probeOptions) || installed?.backend !== this.installed?.backend) {
      this.inventory = new DeviceInventory(createProcessProbe(llamaExecutable(options), installed?.backend));
    }
    this.installed = installed;
    this.probeOptions = options;
    await this.probe.reconfigure(options);
  }
  async dispose(): Promise<void> {
    await Promise.all([this.probe.dispose(), ...[...this.instances.values()].map(runtime => runtime.dispose())]);
    this.instances.clear();
  }

  private async plan(id: string, estimate: ModelMemoryEstimate, retry: { after?: PlacementPlan["kind"]; policy?: { safetyFactor: number } } = {}): Promise<PlacementPlan> {
    // GPU layers 0 means CPU only: no device probe, the same launch as before placement.
    const inventory = this.options.gpuLayers === 0 ? { devices: [], warnings: [] } : await this.inventory.probeDevices();
    for (const warning of inventory.warnings) this.logger.warn(warning);
    if (this.options.inference?.preference === "cuda" && this.options.gpuLayers !== 0 && !inventory.devices.some(device => device.backendName.startsWith("CUDA"))) {
      const message = `CUDA was requested (--inference cuda), but no CUDA device is available. ${this.inventory.cached()?.fallbackReason ?? ""}`.trim();
      this.instances.get(id)?.fail(id, message);
      throw new LocalModelError(message, 503, "cuda_unavailable");
    }
    const residents: ResidentModel[] = [...this.instances.entries()].flatMap(([modelId, runtime]) => {
      const placement = runtime.snapshot().placement;
      if (modelId === id || !placement || !["ready", "loading"].includes(runtime.status)) return [];
      return [{ modelId, hostBytes: placement.hostEstimatedBytes, deviceBytes: Object.fromEntries(placement.devices.map(device => [device.id, device.estimatedBytes])) }];
    });
    const totalBytes = inventory.devices.find(device => device.kind === "unified")?.totalBytes ?? getSystemMemory().total;
    const result = planPlacement({ modelId: id, estimate, contextSize: this.options.contextSize, devices: inventory.devices, system: { totalBytes }, residents,
      gpuLayers: this.options.gpuLayers, gpuRuntime: this.gpuRuntime(), ...retry });
    if (result.kind === "error") {
      this.instances.get(id)?.fail(id, result.message);
      throw new LocalModelError(result.message, 409, "insufficient_memory", { options: result.options });
    }
    for (const warning of result.warnings) this.logger.warn(warning, { modelId: id });
    // Device warnings (no usable GPU, unmatched identities) are shown with the model.
    return { ...result, warnings: [...inventory.warnings, ...result.warnings] };
  }

  private gpuRuntime(): boolean { return this.installed?.backend === "cuda"; }

  /** Backend shown while no model is loaded: the GPU build until a probe finds no device. */
  private idleBackend(current: string): string {
    if (!this.gpuRuntime() || this.options.gpuLayers === 0) return current;
    const cached = this.inventory.cached();
    return !cached || cached.devices.some(device => device.backendName.startsWith("CUDA")) ? "CUDA" : "CPU";
  }

  private fallbackReason(): string | undefined {
    if (this.options.gpuLayers === 0) return undefined;
    return (this.gpuRuntime() ? this.inventory.cached()?.fallbackReason : undefined) ?? this.options.inference?.fallbackReason;
  }

  private launch(plan: PlacementPlan, retried: boolean): RuntimeLaunch {
    return { args: plan.launch.args, env: plan.launch.env, placement: toSnapshot(plan, retried) };
  }

  /** Runs one load at a time. A waiter that is aborted leaves the queue without releasing it early. */
  private async exclusive(signal: AbortSignal | undefined, task: () => Promise<void>): Promise<void> {
    const previous = this.loadLock;
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    this.loadLock = previous.then(() => mine);
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new LocalModelError("Model loading cancelled.", 499)); return; }
        const abort = () => reject(new LocalModelError("Model loading cancelled.", 499));
        signal?.addEventListener("abort", abort, { once: true });
        void previous.then(() => { signal?.removeEventListener("abort", abort); resolve(); });
      });
      await task();
    } finally { release(); }
  }
}
