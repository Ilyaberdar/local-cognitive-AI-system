import { spawn } from "child_process";
import { NodeResult } from "../types";
import {
  readConfigNumber,
  readConfigString,
  readConfigStringArray,
  renderWorkflowTemplate
} from "../template";
import { NodeExecutionContext, NodeExecutor } from "./NodeExecutor";
import { WorkflowPathPolicy } from "./WorkflowPathPolicy";

interface CommandNodeExecutorOptions {
  accessMode: "restricted" | "full";
  allowedDirectories: string[];
  workspaceDir: string;
}

export class CommandNodeExecutor implements NodeExecutor {
  readonly type = "command" as const;
  private readonly paths: WorkflowPathPolicy;

  constructor(private readonly options: CommandNodeExecutorOptions) {
    this.paths = new WorkflowPathPolicy(
      options.accessMode,
      options.allowedDirectories,
      options.workspaceDir
    );
  }

  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    context.signal?.throwIfAborted();
    const config = context.node.config;
    const access = readConfigString(config, "access", "default");
    const approval = context.approval;
    if (approval && (approval.operation !== "command" || typeof approval.executable !== "string" ||
      typeof approval.cwd !== "string" || !Array.isArray(approval.args) ||
      !approval.args.every((arg) => typeof arg === "string") || typeof approval.timeoutMs !== "number" ||
      !Number.isFinite(approval.timeoutMs))) {
      throw new Error("Stored command approval is invalid.");
    }
    const executable = approval
      ? readConfigString(approval, "executable")
      : renderWorkflowTemplate(readConfigString(config, "executable", ""), context).trim();
    if (!executable) throw new Error("Run Command executable is required.");
    const args = approval ? approval.args as string[] : readConfigStringArray(config, "args").map((value) => renderWorkflowTemplate(value, context));
    const cwd = this.paths.resolve(approval ? readConfigString(approval, "cwd") : renderWorkflowTemplate(readConfigString(config, "cwd", "."), context));
    const timeoutMs = readConfigNumber(approval ?? config, "timeoutMs", 120_000, 1_000, 900_000);
    if (!approval && access !== "full" && this.options.accessMode !== "full") {
      return {
        status: "needs_input",
        event: "command.approval_required",
        summary: `Approve running ${executable} in ${cwd}.`,
        data: { permissionRequired: true, operation: "command", executable, args, cwd, timeoutMs }
      };
    }

    const result = await runCommand(executable, args, cwd, timeoutMs, context.signal);

    return {
      status: result.exitCode === 0 ? "ok" : "failed",
      event: result.exitCode === 0 ? "command.completed" : "command.failed",
      summary: `${executable} exited with code ${result.exitCode}.`,
      data: {
        executable,
        args,
        cwd,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut
      },
      error: result.exitCode === 0 ? undefined : result.stderr || `Command exited with code ${result.exitCode}.`
    };
  }
}

const runCommand = (
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const grouped = process.platform !== "win32";
    const child = spawn(executable, args, { cwd, shell: false, env: process.env, detached: grouped });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
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
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code) => {
      if (aborted || timedOut) kill("SIGKILL");
      cleanup();
      if (aborted) reject(signal?.reason ?? new Error("Command cancelled."));
      else resolve({ exitCode: timedOut ? 124 : code ?? 1, stdout, stderr, timedOut });
    });
  });
