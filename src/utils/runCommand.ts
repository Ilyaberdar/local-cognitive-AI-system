import { spawn } from "child_process";

export const runCommand = (
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; stdoutTruncated?: boolean; stderrTruncated?: boolean }> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const grouped = process.platform !== "win32";
    const child = spawn(executable, args, { cwd, shell: false, env: process.env, detached: grouped });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString("utf8")}`.slice(-65_536);
    const kill = (kind: NodeJS.Signals): void => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const terminate = (): void => {
      kill("SIGTERM");
      if (!killTimer) killTimer = setTimeout(() => kill("SIGKILL"), 100);
    };
    const onAbort = (): void => { aborted = true; terminate(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdoutTruncated ||= stdout.length + chunk.toString("utf8").length > 65_536; stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderrTruncated ||= stderr.length + chunk.toString("utf8").length > 65_536; stderr = append(stderr, chunk); });
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code) => {
      if (aborted || timedOut) kill("SIGKILL");
      cleanup();
      if (aborted) reject(signal?.reason ?? new Error("Command cancelled."));
      else resolve({ exitCode: timedOut ? 124 : code ?? 1, stdout, stderr, timedOut,
        ...(stdoutTruncated ? { stdoutTruncated: true } : {}), ...(stderrTruncated ? { stderrTruncated: true } : {}) });
    });
  });
