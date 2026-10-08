import type { BackendHandle } from "../index";

/** Waits for accepted work to finish; at the deadline, running chat requests are cancelled.
 * Workflow runs left unfinished are marked interrupted on the next start. */
export const drainBackend = async (handle: BackendHandle, options: { timeoutMs: number; extraActive?: () => number; onProgress?(active: number): void; signal?: AbortSignal }) => {
  const started = Date.now();
  handle.stopAcceptingWork();
  const active = () => handle.activeWork().total + (options.extraActive?.() ?? 0);
  let last = -1, count = active();
  while (count > 0 && Date.now() - started < options.timeoutMs && !options.signal?.aborted) {
    if (count !== last) { options.onProgress?.(count); last = count; }
    await new Promise(resolve => setTimeout(resolve, 500));
    count = active();
  }
  const remaining = count;
  if (remaining > 0) handle.interruptActiveWork();
  return { drained: remaining === 0, remaining, elapsedMs: Date.now() - started };
};
