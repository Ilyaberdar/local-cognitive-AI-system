/** Fixed-window counters in memory: one Cloud replica (spec §13). */
export const createRateLimiter = (limit: number, windowMs: number, now: () => number = Date.now) => {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Counts one attempt; false when the key is over its limit for this window. */
    take(key: string): boolean {
      const at = now();
      if (windows.size > 10_000) for (const [entry, window] of windows) if (window.resetAt <= at) windows.delete(entry);
      const window = windows.get(key);
      if (!window || window.resetAt <= at) { windows.set(key, { count: 1, resetAt: at + windowMs }); return true; }
      window.count++;
      return window.count <= limit;
    }
  };
};
export type RateLimiter = ReturnType<typeof createRateLimiter>;
