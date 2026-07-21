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
    const config = context.node.config;
    const access = readConfigString(config, "access", "default");

    if (access !== "full" && this.options.accessMode !== "full") {
      return {
        status: "needs_input",
        event: "file_write.approval_required",
        summary: "Save File requires access=full or global filesystem full access.",
        data: { permissionRequired: true, operation: "file_write" }
      };
    }

    const rawPath = renderWorkflowTemplate(readConfigString(config, "path", ""), context).trim();
    if (!rawPath) throw new Error("Save File path is required.");
    const filePath = this.paths.resolve(rawPath);
    const content = renderWorkflowTemplate(readConfigString(config, "contentTemplate", ""), context);
    const mode = readConfigString(config, "mode", "overwrite");
    const before = await fs.readFile(filePath, "utf8").catch(() => "");

    await fs.mkdir(path.dirname(filePath), { recursive: true });
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
