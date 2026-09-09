import fs from "fs/promises";
import path from "path";
import { NodeResult } from "../types";
import { readConfigString, renderWorkflowTemplate } from "../template";
import { NodeExecutionContext, NodeExecutor } from "./NodeExecutor";
import { WorkflowPathPolicy } from "./WorkflowPathPolicy";

interface SaveFileNodeExecutorOptions {
  accessMode: "restricted" | "full";
  allowedDirectories: string[];
  outputDir: string;
}

export class SaveFileNodeExecutor implements NodeExecutor {
  readonly type = "file_write" as const;
  private readonly paths: WorkflowPathPolicy;

  constructor(private readonly options: SaveFileNodeExecutorOptions) {
    this.paths = new WorkflowPathPolicy(
      options.accessMode,
      options.allowedDirectories,
      options.outputDir
    );
  }

  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    context.signal?.throwIfAborted();
    const config = context.node.config;
    const access = readConfigString(config, "access", "default");
    const approval = context.approval;
    if (approval && (approval.operation !== "file_write" || typeof approval.path !== "string" ||
      typeof approval.content !== "string" || typeof approval.mode !== "string")) {
      throw new Error("Stored file approval is invalid.");
    }
    const rawPath = approval
      ? readConfigString(approval, "path")
      : renderWorkflowTemplate(readConfigString(config, "path", ""), context).trim();
    if (!rawPath) throw new Error("Save File path is required.");
    const filePath = this.paths.resolve(rawPath);
    const content = approval ? readConfigString(approval, "content") : renderWorkflowTemplate(readConfigString(config, "contentTemplate", ""), context);
    const mode = readConfigString(approval ?? config, "mode", "overwrite");
    if (!approval && access !== "full" && this.options.accessMode !== "full") {
      return {
        status: "needs_input",
        event: "file_write.approval_required",
        summary: `Approve ${mode === "append" ? "appending to" : "writing"} ${filePath}.`,
        data: { permissionRequired: true, operation: "file_write", path: filePath, mode, content }
      };
    }

    const before = await fs.readFile(filePath, "utf8").catch(() => "");

    context.signal?.throwIfAborted();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    context.signal?.throwIfAborted();
    if (mode === "append") await fs.appendFile(filePath, content, "utf8");
    else await fs.writeFile(filePath, content, "utf8");
    const after = mode === "append" ? `${before}${content}` : content;

    return {
      status: "ok",
      event: "file_write.completed",
      summary: `${mode === "append" ? "Appended" : "Saved"} ${Buffer.byteLength(content)} bytes to ${filePath}.`,
      data: {
        path: filePath,
        mode,
        bytes: Buffer.byteLength(content),
        beforeBytes: Buffer.byteLength(before),
        afterBytes: Buffer.byteLength(after)
      },
      artifacts: [{ name: path.basename(filePath), path: filePath, contentType: "text/plain" }]
    };
  }
}
