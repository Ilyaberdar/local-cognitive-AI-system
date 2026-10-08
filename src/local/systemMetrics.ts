import os from "os";
import type { SystemMetrics } from "../types";
import { getSystemMemory } from "../utils/systemMemory";

/** CPU, RAM and (when known) per-GPU memory of this machine, for the Models strip and the
 * dashboard. The same values are served locally and to a paired device. */
export const systemMetricsSnapshot = (gpus?: SystemMetrics["gpus"]): SystemMetrics => {
  const cpuCores = Math.max(1, os.cpus().length);
  const loadAverage1m = os.loadavg()[0] ?? 0;
  const cpuPercent = Math.max(0, Math.min(100, (loadAverage1m / cpuCores) * 100));
  const memory = getSystemMemory();
  const memoryTotalBytes = memory.total;
  const memoryUsedBytes = Math.max(0, memory.total - memory.free);
  const memoryCachedBytes = memory.cached;
  const ramPercent =
    memoryTotalBytes > 0 ? Math.max(0, Math.min(100, (memoryUsedBytes / memoryTotalBytes) * 100)) : 0;

  return {
    cpuPercent,
    ramPercent,
    memoryUsedBytes,
    memoryTotalBytes,
    memoryCachedBytes,
    cpuCores,
    loadAverage1m,
    ...(gpus?.length ? { gpus } : {})
  };
};
