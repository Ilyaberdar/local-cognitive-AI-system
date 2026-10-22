import { LocalModelError } from "./types";

interface QueueEntry<T = unknown> {
  modelId: string;
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
  /** `heldBy`: what keeps it waiting, by the labels of the requests that have its model. */
  onQueued?: (position: number, heldBy: string[]) => void;
  /** Names the request to the ones waiting behind it, e.g. "Synthesis · Calculator". */
  label?: string;
  exclusive?: boolean;
  /** An inference request: it shares the model with others, up to its slots. */
  shared?: boolean;
}

/** Each model takes as many inference requests at once as it has slots (one unless loaded with more);
 * anything else for a model (load, unload, delete) has it alone. Configuration changes form an
 * exclusive FIFO barrier. */
export class LocalInferenceScheduler {
  private queue: QueueEntry<any>[] = [];
  private active = new Map<string, Set<QueueEntry<any>>>();
  private idleResolvers: Array<() => void> = [];
  private closed = false;

  constructor(private readonly changed: () => void = () => {}, private readonly slots: (modelId: string) => number = () => 1) {}
  get queueLength(): number { return this.queue.length; }
  get busy(): boolean { return this.active.size > 0; }
  get activeModelId(): string | undefined { return this.active.keys().next().value; }
  isModelBusy(id: string): boolean { return this.active.has(id) || this.queue.some((entry) => entry.modelId === id); }

  runExclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue("__exclusive", operation, signal, undefined, true);
  }

  run<T>(modelId: string, operation: () => Promise<T>, signal?: AbortSignal, onQueued?: QueueEntry["onQueued"], label?: string): Promise<T> {
    return this.enqueue(modelId, operation, signal, onQueued, false, false, label);
  }
  /** An inference request: it runs beside the model's other requests while a slot is free. */
  infer<T>(modelId: string, operation: () => Promise<T>, signal?: AbortSignal, onQueued?: QueueEntry["onQueued"], label?: string): Promise<T> {
    return this.enqueue(modelId, operation, signal, onQueued, false, true, label);
  }

  private enqueue<T>(modelId: string, operation: () => Promise<T>, signal?: AbortSignal, onQueued?: QueueEntry["onQueued"], exclusive = false, shared = false, label?: string): Promise<T> {
    if (this.closed) return Promise.reject(new LocalModelError("The local model service is shutting down.", 503));
    if (signal?.aborted) return Promise.reject(new LocalModelError("Request cancelled.", 499, "cancelled"));
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = { modelId, operation, resolve, reject, signal, onQueued, exclusive, shared, label };
      entry.abort = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return; // Active work owns its own abort signal.
        this.queue.splice(index, 1); reject(new LocalModelError("Request cancelled.", 499, "cancelled"));
        this.notify(); this.resolveIdle(); this.pump();
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
      this.pump();
      this.notify();
    });
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      if (entry.abort) entry.signal?.removeEventListener("abort", entry.abort);
      entry.reject(new LocalModelError("The local model service is shutting down.", 503));
    }
    this.notify();
    if (this.active.size) await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  private pump(): void {
    if (this.closed || this.active.has("__exclusive")) return;
    // A model whose earlier entry is still waiting keeps its later ones waiting too: first come, first served.
    const waiting = new Set<string>();
    for (let index = 0; index < this.queue.length;) {
      const entry = this.queue[index];
      if (entry.exclusive && this.active.size) break;
      const running = this.active.get(entry.modelId);
      const fits = !running || (entry.shared && [...running].every(other => other.shared) && running.size < Math.max(1, this.slots(entry.modelId)));
      if (waiting.has(entry.modelId) || !fits) { waiting.add(entry.modelId); index++; continue; }
      this.queue.splice(index, 1);
      this.start(entry);
      if (entry.exclusive) break;
    }
    this.resolveIdle();
  }

  private start(entry: QueueEntry<any>): void {
    let running = this.active.get(entry.modelId);
    if (!running) { running = new Set(); this.active.set(entry.modelId, running); }
    running.add(entry);
    if (entry.abort) entry.signal?.removeEventListener("abort", entry.abort);
    this.notify();
    void Promise.resolve().then(() => { entry.signal?.throwIfAborted(); return entry.operation(); })
      .then(entry.resolve, entry.reject).finally(() => {
        running.delete(entry);
        if (!running.size && this.active.get(entry.modelId) === running) this.active.delete(entry.modelId);
        this.pump(); this.notify(); this.resolveIdle();
      });
  }

  private notify(): void {
    this.queue.forEach((entry, index) => {
      const ahead = this.queue.slice(0, index).filter(other => other.modelId === entry.modelId || other.exclusive);
      entry.onQueued?.(1 + ahead.length, this.holders(entry, ahead));
    });
    this.changed();
  }
  /** What keeps a waiting request waiting: the requests that have its model, or a settings change. */
  private holders(entry: QueueEntry<any>, ahead: QueueEntry<any>[]): string[] {
    const settings = "a change of model settings";
    const running = this.active.get("__exclusive") ?? this.active.get(entry.modelId);
    const names = [...(running ?? [])].map(other => other.exclusive ? settings : other.label ?? "another request");
    if (!names.length && ahead.some(other => other.exclusive)) names.push(settings);
    return [...new Set(names)];
  }
  private resolveIdle(): void { if (!this.active.size && !this.queue.length) for (const resolve of this.idleResolvers.splice(0)) resolve(); }
}
