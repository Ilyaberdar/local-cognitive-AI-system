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
    const config = context.node.config;
    const access = readConfigString(config, "access", "default");

    if (access !== "full" && this.options.accessMode !== "full") {
      return {
        status: "needs_input",
        event: "command.approval_required",
        summary: "Run Command requires access=full or global filesystem full access.",
        data: { permissionRequired: true, operation: "command" }
      };
    }

    const executable = renderWorkflowTemplate(readConfigString(config, "executable", ""), context).trim();
    if (!executable) throw new Error("Run Command executable is required.");
    const args = readConfigStringArray(config, "args").map((value) => renderWorkflowTemplate(value, context));
    const cwd = this.paths.resolve(renderWorkflowTemplate(readConfigString(config, "cwd", "."), context));
    const timeoutMs = readConfigNumber(config, "timeoutMs", 120_000, 1_000, 900_000);
    const result = await runCommand(executable, args, cwd, timeoutMs);

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
  timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString("utf8")}`.slice(-65_536);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : code ?? 1, stdout, stderr, timedOut });
    });
  });
