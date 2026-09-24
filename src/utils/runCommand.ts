import { spawn } from "child_process";

export type CommandOutputHandler = (stream: "stdout" | "stderr", text: string) => void;

export const runCommand = (
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onOutput?: CommandOutputHandler
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
    const append = (current: string, chunk: string): string => `${current}${chunk}`.slice(-65_536);
    const pending = { stdout: "", stderr: "" };
    const sent = { stdout: 0, stderr: 0 };
    let outputTimer: NodeJS.Timeout | undefined;
    const flush = () => {
      clearTimeout(outputTimer); outputTimer = undefined;
      for (const stream of ["stdout", "stderr"] as const) {
        const text = pending[stream]; pending[stream] = "";
        if (text && !aborted) { try { onOutput?.(stream, text); } catch {} }
      }
    };
    const observe = (stream: "stdout" | "stderr", chunk: string) => {
      if (!onOutput || aborted || sent[stream] >= 65_536) return;
      const text = chunk.slice(0, 65_536 - sent[stream]); sent[stream] += text.length;
      pending[stream] += text;
      if (sent[stream] >= 65_536) pending[stream] += "\n[Live output limit reached; see the final command result for the output tail.]\n";
      while (pending[stream].length >= 4096) {
        try { onOutput(stream, pending[stream].slice(0, 4096)); } catch {}
        pending[stream] = pending[stream].slice(4096);
      }
      outputTimer ??= setTimeout(flush, 100);
    };
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
      flush();
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdoutTruncated ||= stdout.length + chunk.length > 65_536; stdout = append(stdout, chunk); observe("stdout", chunk); });
    child.stderr.on("data", (chunk: string) => { stderrTruncated ||= stderr.length + chunk.length > 65_536; stderr = append(stderr, chunk); observe("stderr", chunk); });
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code) => {
      if (aborted || timedOut) kill("SIGKILL");
      cleanup();
      if (aborted) reject(signal?.reason ?? new Error("Command cancelled."));
      else resolve({ exitCode: timedOut ? 124 : code ?? 1, stdout, stderr, timedOut,
        ...(stdoutTruncated ? { stdoutTruncated: true } : {}), ...(stderrTruncated ? { stderrTruncated: true } : {}) });
    });
  });
