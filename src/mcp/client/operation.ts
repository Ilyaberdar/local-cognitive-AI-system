import { McpClientError } from "./errors";
import { McpOperationOptions } from "./types";

/** Bounds even an injected provider that ignores cancellation, and releases timer/listeners. */
export async function mcpOperation<T>(
  options: McpOperationOptions,
  defaultTimeoutMs: number,
  action: (signal: AbortSignal, timeoutMs: number) => Promise<T>
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
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  try {
    return await Promise.race([action(controller.signal, timeoutMs), interrupted]);
  } catch (error) {
    throw interruption ?? error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
