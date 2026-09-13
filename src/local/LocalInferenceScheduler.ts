import { LocalModelError } from "./types";

interface QueueEntry<T = unknown> {
  modelId: string;
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
  onQueued?: (position: number) => void;
}

/** One slot for every local call, including translation and workflow participants. */
export class LocalInferenceScheduler {
  private queue: QueueEntry<any>[] = [];
  private active?: QueueEntry<any>;
  private idleResolvers: Array<() => void> = [];
  private closed = false;

  constructor(private readonly changed: () => void = () => {}) {}
  get queueLength(): number { return this.queue.length; }
  get busy(): boolean { return Boolean(this.active); }
  get activeModelId(): string | undefined { return this.active?.modelId; }
  isModelBusy(id: string): boolean { return this.active?.modelId === id || this.queue.some((entry) => entry.modelId === id); }

  run<T>(modelId: string, operation: () => Promise<T>, signal?: AbortSignal, onQueued?: (position: number) => void): Promise<T> {
    if (this.closed) return Promise.reject(new LocalModelError("The local model service is shutting down.", 503));
    if (signal?.aborted) return Promise.reject(new LocalModelError("Request cancelled.", 499, "cancelled"));
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = { modelId, operation, resolve, reject, signal, onQueued };
      entry.abort = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return; // Active work owns its own abort signal.
        this.queue.splice(index, 1); reject(new LocalModelError("Request cancelled.", 499, "cancelled"));
        this.notify(); this.resolveIdle();
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
      this.notify();
      this.pump();
    });
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      if (entry.abort) entry.signal?.removeEventListener("abort", entry.abort);
      entry.reject(new LocalModelError("The local model service is shutting down.", 503));
    }
    this.notify();
    if (this.active) await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  private pump(): void {
    if (this.active || this.closed) return;
    const entry = this.queue.shift();
    if (!entry) { this.resolveIdle(); return; }
    this.active = entry;
    if (entry.abort) entry.signal?.removeEventListener("abort", entry.abort);
    this.notify();
    void Promise.resolve().then(() => { entry.signal?.throwIfAborted(); return entry.operation(); })
      .then(entry.resolve, entry.reject).finally(() => {
        this.active = undefined; this.notify(); this.resolveIdle(); this.pump();
      });
  }

  private notify(): void {
    this.queue.forEach((entry, index) => entry.onQueued?.(index + (this.active ? 1 : 0)));
    this.changed();
  }
  private resolveIdle(): void { if (!this.active && !this.queue.length) for (const resolve of this.idleResolvers.splice(0)) resolve(); }
}
