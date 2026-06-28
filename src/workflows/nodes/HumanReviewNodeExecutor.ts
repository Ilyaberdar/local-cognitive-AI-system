import { NodeExecutor, NodeExecutionContext } from "./NodeExecutor";
import { NodeResult } from "../types";

export class HumanReviewNodeExecutor implements NodeExecutor {
  readonly type = "human_review" as const;

  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    return {
      status: "needs_input",
      event: "human_review.waiting",
      summary: String(context.node.config.prompt ?? "Human review is required."),
      data: {
        nodeId: context.node.id
      }
    };
  }
}
