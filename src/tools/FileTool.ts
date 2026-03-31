import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { ToolExecutionRequest, ToolExecutionResult } from "../types";
import { Tool } from "./Tool.interface";

export class FileTool implements Tool {
  name = "file";
  description = "Writes a generated note or result to the local file system.";

  constructor(private readonly outputDir: string) {}

  matchesIntent(input: string): boolean {
    return /(?:save|write|export).*(?:file|markdown|txt)|(?:в|во)\s+файл|сохрани.*файл/i.test(input);
  }

  async execute(input: ToolExecutionRequest): Promise<ToolExecutionResult> {
    await fs.mkdir(this.outputDir, { recursive: true });

    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.md`;
    const filePath = path.join(this.outputDir, filename);
    const content = `# ${input.title}\n\n${input.content}\n`;

    await fs.writeFile(filePath, content, "utf8");

    return {
      tool: this.name,
      ok: true,
      output: `Saved file to ${filePath}`,
      metadata: { filePath }
    };
  }

  toDescriptor() {
    return {
      name: this.name,
      description: this.description
    };
  }
}
