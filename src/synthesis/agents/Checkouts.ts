/** Who holds a file: an agent of the parallel_map, by its task. */
export interface Holder { agent: number; task: string }

/** Files the agents of one parallel_map have checked out, and the files they own.
 *
 * Like Perforce: a checked-out file is the holder's until it submits or reverts (or its task ends);
 * the others read the last submitted version and change nothing of it. A file under an `own` right
 * belongs to the agent that first created or changed it, for the rest of the parallel_map.
 *
 * Checkouts are taken all at once or not at all, and only an agent that holds nothing may wait for
 * them: no agent ever waits while holding a file another one waits for, so no two wait on each other. */
export class Checkouts {
  private readonly held = new Map<string, Holder>();
  private readonly owners = new Map<string, Holder>();
  private waiters: Array<() => void> = [];
  /** Every change needs a checkout first (parallel_map(..., checkout = "required")). */
  constructor(readonly required = false) {}

  holder(key: string): Holder | undefined { return this.held.get(key); }
  owner(key: string): Holder | undefined { return this.owners.get(key); }
  heldBy(agent: number): string[] { return [...this.held].filter(([, holder]) => holder.agent === agent).map(([key]) => key); }
  /** The first agent to create or change a file under an own right keeps it. */
  own(key: string, holder: Holder): void { if (!this.owners.has(key)) this.owners.set(key, holder); }

  /** Takes every key for the agent, or none: the holders and owners in the way otherwise. */
  tryAcquire(holder: Holder, keys: string[]): Holder[] {
    const blocking = keys.flatMap(key => [this.held.get(key), this.owners.get(key)]).filter((other): other is Holder => !!other && other.agent !== holder.agent);
    if (blocking.length) return [...new Map(blocking.map(other => [other.agent, other])).values()];
    for (const key of keys) this.held.set(key, holder);
    return [];
  }
  /** As tryAcquire, waiting up to `waitMs` for files held by others (never for owned ones) when the
   * agent holds nothing itself. */
  async acquire(holder: Holder, keys: string[], waitMs: number, signal?: AbortSignal): Promise<Holder[]> {
    const deadline = Date.now() + (this.heldBy(holder.agent).length ? 0 : waitMs);
    for (;;) {
      const blocking = this.tryAcquire(holder, keys);
      const owned = keys.some(key => { const owner = this.owners.get(key); return owner && owner.agent !== holder.agent; });
      if (!blocking.length || owned || Date.now() >= deadline) return blocking;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
        function wake() { clearTimeout(timer); signal?.removeEventListener("abort", stop); resolve(); }
        const stop = () => { clearTimeout(timer); reject(signal!.reason); };
        this.waiters.push(wake);
        signal?.addEventListener("abort", stop, { once: true });
      });
      signal?.throwIfAborted();
    }
  }
  /** Releases the agent's keys (all of them without `keys`) and wakes those waiting. */
  release(agent: number, keys?: string[]): void {
    for (const key of keys ?? this.heldBy(agent)) if (this.held.get(key)?.agent === agent) this.held.delete(key);
    for (const wake of this.waiters.splice(0)) wake();
  }
}
