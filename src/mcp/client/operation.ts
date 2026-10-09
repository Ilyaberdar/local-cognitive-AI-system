import { McpClientError } from "./errors";
import { McpOperationOptions } from "./types";

/** Bounds even an injected provider that ignores cancellation, and releases timer/listeners.
 * With `maxTotalMs` the timeout counts from the last `progressed()` (a server reporting progress
 * on a long call), and the whole operation still ends at `maxTotalMs`. */
export async function mcpOperation<T>(
  options: McpOperationOptions,
  defaultTimeoutMs: number,
  action: (signal: AbortSignal, timeoutMs: number, progressed: () => void) => Promise<T>,
  maxTotalMs?: number
): Promise<T> {
  if (options.signal?.aborted) throw new McpClientError("cancelled");
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new McpClientError("invalid_configuration");
  }
  const controller = new AbortController();
  let interruption: McpClientError | undefined;
  let rejectInterrupted!: (error: McpClientError) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  const stop = (code: "cancelled" | "timeout") => {
    interruption ??= new McpClientError(code);
    controller.abort(interruption);
    rejectInterrupted(interruption);
  };
  const onAbort = () => stop("cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timer = setTimeout(() => stop("timeout"), timeoutMs);
  const total = maxTotalMs === undefined ? undefined : setTimeout(() => stop("timeout"), Math.max(maxTotalMs, timeoutMs));
  const progressed = () => {
    if (maxTotalMs === undefined || interruption) return;
    clearTimeout(timer);
    timer = setTimeout(() => stop("timeout"), timeoutMs);
  };
  try {
    return await Promise.race([action(controller.signal, timeoutMs, progressed), interrupted]);
  } catch (error) {
    throw interruption ?? error;
  } finally {
    clearTimeout(timer);
    clearTimeout(total);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
