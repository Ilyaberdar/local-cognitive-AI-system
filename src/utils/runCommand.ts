import { spawn } from "child_process";
import { childProcessEnv } from "../config/secrets";

export type CommandOutputHandler = (stream: "stdout" | "stderr", text: string) => void;

export const runCommand = (
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onOutput?: CommandOutputHandler,
  /** `env` replaces the app's own environment (a sandboxed check passes only what it allows).
   * `input`: written to the command's stdin, which is then closed.
   * `endWhen`: once the output so far says the command is done, its whole process group is killed,
   * while the group's leader still waits (so the group is the command's, never another's). */
  options: { env?: NodeJS.ProcessEnv; input?: string; endWhen?: (stdout: string) => boolean } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; stdoutTruncated?: boolean; stderrTruncated?: boolean }> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const grouped = process.platform !== "win32";
    const child = spawn(executable, args, { cwd, shell: false, env: options.env ?? childProcessEnv(), detached: grouped });
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
    let ended = false;
    child.stdout.on("data", (chunk: string) => {
      stdoutTruncated ||= stdout.length + chunk.length > 65_536; stdout = append(stdout, chunk); observe("stdout", chunk);
      if (!ended && options.endWhen?.(stdout)) { ended = true; kill("SIGKILL"); }
    });
    child.stderr.on("data", (chunk: string) => { stderrTruncated ||= stderr.length + chunk.length > 65_536; stderr = append(stderr, chunk); observe("stderr", chunk); });
    child.on("error", (error) => { cleanup(); reject(error); });
    // A command that exits before reading its input breaks the pipe: that is its answer, not the app's failure.
    child.stdin.on("error", () => undefined);
    if (options.input !== undefined) child.stdin.end(options.input);
    child.on("close", (code) => {
      if (aborted || timedOut) kill("SIGKILL");
      cleanup();
      if (aborted) reject(signal?.reason ?? new Error("Command cancelled."));
      else resolve({ exitCode: timedOut ? 124 : code ?? 1, stdout, stderr, timedOut,
        ...(stdoutTruncated ? { stdoutTruncated: true } : {}), ...(stderrTruncated ? { stderrTruncated: true } : {}) });
    });
  });
