import { NodeExecutor, NodeExecutionContext } from "./NodeExecutor";
import { NodeResult } from "../types";

export class TerminalNodeExecutor implements NodeExecutor {
  readonly type = "terminal" as const;

  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    const runStatus = String(context.node.config.runStatus ?? "done");
    const failed = runStatus === "failed";

    return {
      status: failed ? "failed" : "ok",
      event: failed ? "terminal.failed" : "terminal.done",
      summary: failed ? "Workflow reached failed terminal state." : "Workflow reached done terminal state.",
      data: {
        runStatus
      }
    };
  }
}
