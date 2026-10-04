import { LocalModelError } from "./types";

interface QueueEntry<T = unknown> {
  modelId: string;
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
  onQueued?: (position: number) => void;
  exclusive?: boolean;
}

/** One slot per model; configuration changes form an exclusive FIFO barrier. */
export class LocalInferenceScheduler {
  private queue: QueueEntry<any>[] = [];
  private active = new Map<string, QueueEntry<any>>();
  private idleResolvers: Array<() => void> = [];
  private closed = false;

  constructor(private readonly changed: () => void = () => {}) {}
  get queueLength(): number { return this.queue.length; }
  get busy(): boolean { return this.active.size > 0; }
  get activeModelId(): string | undefined { return this.active.keys().next().value; }
  isModelBusy(id: string): boolean { return this.active.has(id) || this.queue.some((entry) => entry.modelId === id); }

  runExclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue("__exclusive", operation, signal, undefined, true);
  }

  run<T>(modelId: string, operation: () => Promise<T>, signal?: AbortSignal, onQueued?: (position: number) => void): Promise<T> {
    return this.enqueue(modelId, operation, signal, onQueued);
  }

  private enqueue<T>(modelId: string, operation: () => Promise<T>, signal?: AbortSignal, onQueued?: (position: number) => void, exclusive = false): Promise<T> {
    if (this.closed) return Promise.reject(new LocalModelError("The local model service is shutting down.", 503));
    if (signal?.aborted) return Promise.reject(new LocalModelError("Request cancelled.", 499, "cancelled"));
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = { modelId, operation, resolve, reject, signal, onQueued, exclusive };
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
    for (let index = 0; index < this.queue.length;) {
      const entry = this.queue[index];
      if (entry.exclusive && this.active.size) break;
      if (this.active.has(entry.modelId)) { index++; continue; }
      this.queue.splice(index, 1);
      this.start(entry);
      if (entry.exclusive) break;
    }
    this.resolveIdle();
  }

  private start(entry: QueueEntry<any>): void {
    this.active.set(entry.modelId, entry);
    if (entry.abort) entry.signal?.removeEventListener("abort", entry.abort);
    this.notify();
    void Promise.resolve().then(() => { entry.signal?.throwIfAborted(); return entry.operation(); })
      .then(entry.resolve, entry.reject).finally(() => {
        this.active.delete(entry.modelId); this.pump(); this.notify(); this.resolveIdle();
      });
  }

  private notify(): void {
    this.queue.forEach((entry, index) => entry.onQueued?.(1 + this.queue.slice(0, index).filter(other => other.modelId === entry.modelId || other.exclusive).length));
    this.changed();
  }
  private resolveIdle(): void { if (!this.active.size && !this.queue.length) for (const resolve of this.idleResolvers.splice(0)) resolve(); }
}
