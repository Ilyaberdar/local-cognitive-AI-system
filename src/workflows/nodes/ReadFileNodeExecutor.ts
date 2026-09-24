import { OperationExecutor } from "../../tools/OperationExecutor";
import { NodeResult } from "../types";
import { readConfigNumber, readConfigString, renderWorkflowTemplate } from "../template";
import { NodeExecutionContext, NodeExecutor } from "./NodeExecutor";
import { executeWorkflowOperation } from "./WorkflowOperation";

export class ReadFileNodeExecutor implements NodeExecutor {
  readonly type = "file_read" as const;
  constructor(private readonly operations: OperationExecutor) {}
  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    const config = context.node.config;
    const result = await executeWorkflowOperation(context, this.operations, "file.read", {
      path: renderWorkflowTemplate(readConfigString(config, "path", ""), context),
      startLine: readConfigNumber(config, "startLine", 1, 1, 1_000_000),
      ...(config.endLine === undefined ? {} : { endLine: readConfigNumber(config, "endLine", 200, 1, 1_000_000) })
    });
    if (result.status !== "ok") return result;
    const content = JSON.parse(String(result.data.output));
    if (content.error) return { ...result, status: "failed", error: content.error, summary: content.error };
    return { ...result, summary: `Read ${String(result.data.filePath ?? result.data.path)}${content.truncated ? " (partial; select another line range to read more)" : ""}`,
      data: { ...result.data, path: result.data.filePath ?? result.data.path, ...content, formattedContent: content.content,
        content: String(content.content ?? "").replace(/^\d+: /gm, "") } };
  }
}
