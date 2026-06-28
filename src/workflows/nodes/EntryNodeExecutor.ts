import { NodeExecutor, NodeExecutionContext } from "./NodeExecutor";
import { NodeResult } from "../types";

export class EntryNodeExecutor implements NodeExecutor {
  readonly type = "entry" as const;

  async execute(_context: NodeExecutionContext): Promise<NodeResult> {
    return {
      status: "ok",
      event: "entry.completed",
      summary: "Workflow entry completed.",
      data: {}
    };
  }
}
