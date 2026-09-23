import { runCommand } from "../../utils/runCommand";
import { NodeResult } from "../types";
import {
  readConfigNumber,
  readConfigString,
  readConfigStringArray,
  renderWorkflowTemplate
} from "../template";
import { NodeExecutionContext, NodeExecutor } from "./NodeExecutor";
import { WorkflowPathPolicy } from "./WorkflowPathPolicy";
import { OperationExecutor } from "../../tools/OperationExecutor";
import { executeWorkflowOperation } from "./WorkflowOperation";

interface CommandNodeExecutorOptions {
  accessMode: "restricted" | "full";
  allowedDirectories: string[];
  workspaceDir: string;
}

export class CommandNodeExecutor implements NodeExecutor {
  readonly type = "command" as const;
  private readonly paths: WorkflowPathPolicy;

  constructor(private readonly options: CommandNodeExecutorOptions, private readonly operations?: OperationExecutor) {
    this.paths = new WorkflowPathPolicy(
      options.accessMode,
      options.allowedDirectories,
      options.workspaceDir
    );
  }

  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    context.signal?.throwIfAborted();
    const config = context.node.config;
    if (context.workspace ?? context.run.workspace) {
      if (!this.operations) throw new Error("Workspace operation executor is unavailable.");
      return executeWorkflowOperation(context, this.operations, "command.run", {
        executable: renderWorkflowTemplate(readConfigString(config, "executable", ""), context).trim(),
        args: readConfigStringArray(config, "args").map((value) => renderWorkflowTemplate(value, context)),
        cwd: renderWorkflowTemplate(readConfigString(config, "cwd", "."), context),
        timeoutMs: readConfigNumber(config, "timeoutMs", 120_000, 1_000, 120_000)
      });
    }
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
    const cwd = await this.paths.resolve(approval ? readConfigString(approval, "cwd") : renderWorkflowTemplate(readConfigString(config, "cwd", "."), context));
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
