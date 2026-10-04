import { LLMRequest, LLMResponse } from "../types";
import { Logger } from "../utils/Logger";
import { LlamaCppRuntime } from "./LlamaCppRuntime";
import { LocalModelError, LocalModelOptions, LocalRuntimeSnapshot } from "./types";

/** Resident models own independent processes. Loading one never evicts another. */
export class LocalRuntimePool {
  private readonly instances = new Map<string, LlamaCppRuntime>();
  private readonly probe: LlamaCppRuntime;
  constructor(private options: LocalModelOptions, private readonly logger: Logger, private readonly changed: () => void) {
    this.probe = new LlamaCppRuntime(options, logger, changed);
  }
  get status(): LocalRuntimeSnapshot["status"] { return this.snapshot().status; }
  get currentModelId(): string | undefined { return this.snapshot().modelId; }
  async init(): Promise<void> { await this.probe.init(); }
  forModel(id: string): LocalRuntimeSnapshot | undefined { return this.instances.get(id)?.snapshot(); }
  snapshot(): LocalRuntimeSnapshot {
    const instances = [...this.instances.values()].map(runtime => runtime.snapshot()).filter(runtime => runtime.modelId);
    const selected = instances.find(runtime => runtime.status === "loading")
      ?? instances.find(runtime => runtime.status === "ready")
      ?? instances.find(runtime => runtime.status === "error") ?? this.probe.snapshot();
    return { ...selected, modelId: instances.length === 1 ? instances[0].modelId : undefined,
      loadedModelIds: instances.filter(runtime => runtime.status === "ready").map(runtime => runtime.modelId!), instances };
  }
  async load(id: string, file: string, signal?: AbortSignal, projector?: string): Promise<void> {
    let runtime = this.instances.get(id);
    if (!runtime) {
      runtime = new LlamaCppRuntime(this.options, this.logger, this.changed);
      this.instances.set(id, runtime);
    }
    await runtime.load(id, file, signal, projector);
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
    await this.probe.reconfigure(options);
  }
  async dispose(): Promise<void> {
    await Promise.all([this.probe.dispose(), ...[...this.instances.values()].map(runtime => runtime.dispose())]);
    this.instances.clear();
  }
}
