import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { ModeResult, ToolExecutionRequest, ToolExecutionResult } from "../types";
import { Tool } from "./Tool.interface";

interface FileToolOptions {
  outputDir: string;
  accessMode: "restricted" | "full";
  allowedDirectories: string[];
}

export class FileTool implements Tool {
  name = "file";
  description = "Reads, writes, lists, and scaffolds files inside configured local filesystem boundaries.";

  constructor(private readonly options: FileToolOptions) {}

  matchesIntent(input: string): boolean {
    return /(?:save|write|export|create|build|make|read|list|delete|mkdir|append|edit|rewrite|overwrite|update).*(?:file|project|app|folder|directory|markdown|txt)|(?:в|во)\s+файл|сохрани.*файл|создай.*(?:проект|файл|папк)|прочитай.*файл|покажи.*файл|удали.*(?:файл|папк)|допиши.*файл|измени.*файл|обнови.*файл|перепиши.*файл/i.test(
      input
    );
  }

  async execute(input: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const rawInput = input.rawInput;
    const requestedPath = this.extractPath(rawInput);
    const scaffoldFiles = this.extractScaffoldFiles(input.result);

    if (this.isReadIntent(rawInput) && requestedPath) {
      return this.readFile(requestedPath);
    }

    if (this.isListIntent(rawInput)) {
      return this.listDirectory(requestedPath);
    }

    if (this.isDeleteIntent(rawInput) && requestedPath) {
      const approval = this.requireFileApproval(input, "delete");
      if (approval) {
        return approval;
      }
      return this.deletePath(requestedPath);
    }

    if (this.isMkdirIntent(rawInput) && requestedPath) {
      const approval = this.requireFileApproval(input, "create directory");
      if (approval) {
        return approval;
      }
      return this.makeDirectory(requestedPath);
    }

    if (this.isAppendIntent(rawInput) && requestedPath) {
      const approval = this.requireFileApproval(input, "append file");
      if (approval) {
        return approval;
      }
      this.assertWritableResult(input.result);
      return this.appendFile(requestedPath, this.renderSingleFileContent(input.result));
    }

    if (this.isWriteIntent(rawInput) && requestedPath) {
      const approval = this.requireFileApproval(input, "write file");
      if (approval) {
        return approval;
      }
      this.assertWritableResult(input.result);
      return this.writeFile(requestedPath, this.renderSingleFileContent(input.result));
    }

    if (scaffoldFiles.length > 0) {
      const approval = this.requireFileApproval(input, "write scaffold");
      if (approval) {
        return approval;
      }
      this.assertWritableResult(input.result);
      return this.writeScaffold(scaffoldFiles, requestedPath);
    }

    return this.writeNote(input);
  }

  private async writeNote(input: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const outputDir = path.resolve(this.options.outputDir);
    this.assertAllowed(outputDir);

    await fs.mkdir(outputDir, { recursive: true });

    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.md`;
    const filePath = path.join(outputDir, filename);
    const content = `# ${input.title}\n\n${input.content}\n`;

    await fs.writeFile(filePath, content, "utf8");

    return {
      tool: this.name,
      ok: true,
      output: `Saved file to ${filePath}`,
      metadata: { filePath }
    };
  }

  private async writeScaffold(
    files: Array<{ filePath: string; content: string }>,
    targetPath?: string
  ): Promise<ToolExecutionResult> {
    const baseDir = targetPath
      ? this.resolveTargetPath(targetPath)
      : path.join(this.options.outputDir, `scaffold-${Date.now()}`);

    this.assertAllowed(baseDir);
    await fs.mkdir(baseDir, { recursive: true });

    const writtenPaths: string[] = [];

    for (const file of files) {
      const destination = path.resolve(baseDir, file.filePath);
      this.assertAllowed(destination);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.content.replace(/\n+$/, "") + "\n", "utf8");
      writtenPaths.push(destination);
    }

    return {
      tool: this.name,
      ok: true,
      output: `Project scaffold written to ${baseDir}`,
      metadata: {
        baseDir,
        writtenPaths
      }
    };
  }

  private async writeFile(targetPath: string, content: string): Promise<ToolExecutionResult> {
    const resolved = this.resolveTargetPath(targetPath);
    this.assertAllowed(resolved);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, this.normalizeFileContent(content), "utf8");

    return {
      tool: this.name,
      ok: true,
      output: `Wrote file ${resolved}`,
      metadata: {
        filePath: resolved,
        operation: "write"
      }
    };
  }

  private async appendFile(targetPath: string, content: string): Promise<ToolExecutionResult> {
    const resolved = this.resolveTargetPath(targetPath);
    this.assertAllowed(resolved);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.appendFile(resolved, this.normalizeAppendContent(content), "utf8");

    return {
      tool: this.name,
      ok: true,
      output: `Appended file ${resolved}`,
      metadata: {
        filePath: resolved,
        operation: "append"
      }
    };
  }

  private async readFile(targetPath: string): Promise<ToolExecutionResult> {
    const resolved = this.resolveTargetPath(targetPath);
    this.assertAllowed(resolved);
    const content = await fs.readFile(resolved, "utf8");

    return {
      tool: this.name,
      ok: true,
      output: `Read file ${resolved}\n\n${content.slice(0, 4000)}`,
      metadata: {
        filePath: resolved
      }
    };
  }

  private async listDirectory(targetPath?: string): Promise<ToolExecutionResult> {
    const resolved = this.resolveTargetPath(targetPath ?? this.options.outputDir);
    this.assertAllowed(resolved);
    const entries = await fs.readdir(resolved, { withFileTypes: true });

    return {
      tool: this.name,
      ok: true,
      output: [
        `Directory listing for ${resolved}:`,
        ...entries.map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`)
      ].join("\n"),
      metadata: {
        directory: resolved,
        count: entries.length
      }
    };
  }

  private async makeDirectory(targetPath: string): Promise<ToolExecutionResult> {
    const resolved = this.resolveTargetPath(targetPath);
    this.assertAllowed(resolved);
    await fs.mkdir(resolved, { recursive: true });

    return {
      tool: this.name,
      ok: true,
      output: `Created directory ${resolved}`,
      metadata: {
        directory: resolved
      }
    };
  }

  private async deletePath(targetPath: string): Promise<ToolExecutionResult> {
    const resolved = this.resolveTargetPath(targetPath);
    this.assertAllowed(resolved);
    await fs.rm(resolved, { recursive: true, force: true });

    return {
      tool: this.name,
      ok: true,
      output: `Deleted ${resolved}`,
      metadata: {
        path: resolved
      }
    };
  }

  private isAllowed(targetPath: string): boolean {
    if (this.options.accessMode === "full") {
      return true;
    }

    return this.options.allowedDirectories.some((directory) => {
      const normalizedDirectory = path.resolve(directory);
      return (
        targetPath === normalizedDirectory ||
        targetPath.startsWith(`${normalizedDirectory}${path.sep}`)
      );
    });
  }

  private assertAllowed(targetPath: string): void {
    if (!this.isAllowed(targetPath)) {
      throw new Error(`Filesystem access blocked for path: ${targetPath}`);
    }
  }

  private requireFileApproval(
    input: ToolExecutionRequest,
    operation: string
  ): ToolExecutionResult | undefined {
    if (!("response" in input.result)) {
      return undefined;
    }

    const writer = input.result.subagents?.find((agent) => agent.role === "writer");

    if (writer) {
      if (writer.accessMode === "full" || this.hasExplicitFileApproval(input.rawInput)) {
        return undefined;
      }

      return {
        tool: this.name,
        ok: false,
        output: [
          `Permission required: ${writer.name} requested ${operation} with access=default.`,
          `Reply with explicit approval, for example "approve file access", or switch this subagent to full access.`
        ].join(" "),
        metadata: {
          permissionRequired: true,
          operation,
          agentId: writer.id,
          agentName: writer.name,
          accessMode: writer.accessMode
        }
      };
    }

    const accessMode = input.context.sessionSettings.defaultAccessMode;

    if (accessMode === "full" || this.hasExplicitFileApproval(input.rawInput)) {
      return undefined;
    }

    return {
      tool: this.name,
      ok: false,
      output: [
        `Permission required: current model requested ${operation} with access=default.`,
        `Reply with explicit approval, for example "approve file access", or switch the main model to full access.`
      ].join(" "),
      metadata: {
        permissionRequired: true,
        operation,
        agentId: "default-model",
        agentName: "Current model",
        accessMode
      }
    };
  }

  private hasExplicitFileApproval(input: string): boolean {
    return /approve file access|approved file access|allow file access|разрешаю доступ|подтверждаю доступ|одобряю доступ|full access/i.test(
      input
    );
  }

  private resolveTargetPath(rawPath: string): string {
    if (path.isAbsolute(rawPath)) {
      return path.resolve(rawPath);
    }

    const base =
      this.options.allowedDirectories[0] || this.options.outputDir || process.cwd();
    return path.resolve(base, rawPath);
  }

  private extractPath(input: string): string | undefined {
    const fenced = input.match(/`([^`]+)`/);

    if (fenced?.[1]) {
      return fenced[1].trim();
    }

    const pathLike = input.match(
      /(?:path|file|folder|directory|директори[яи]|папк[ауеи]?|файл[ауеы]?|путь)\s*(?:=|:|в|во|to|at)?\s*([./~\w-][^\n,]*)/i
    );

    return pathLike?.[1]?.trim();
  }

  private extractScaffoldFiles(result: ModeResult): Array<{ filePath: string; content: string }> {
    if (!("response" in result)) {
      return [];
    }

    const matches = Array.from(
      result.response.matchAll(/<<<FILE:([^\n>]+)>>>\n?([\s\S]*?)<<<END FILE>>>/g)
    );

    return matches
      .map((match) => ({
        filePath: match[1].trim(),
        content: match[2].replace(/^\n+/, "")
      }))
      .filter((item) => item.filePath && item.content.trim());
  }

  private renderSingleFileContent(result: ModeResult): string {
    if (!("response" in result)) {
      return JSON.stringify(result, null, 2);
    }

    return result.response
      .replace(/<<<FILE:[^\n>]+>>>\n?/g, "")
      .replace(/<<<END FILE>>>/g, "")
      .trim();
  }

  private assertWritableResult(result: ModeResult): void {
    if (!("response" in result)) {
      return;
    }

    if (/^Mock response from /i.test(result.response.trim())) {
      throw new Error("Refusing to write files from fallback model output.");
    }
  }

  private normalizeFileContent(content: string): string {
    const trimmed = content.replace(/^\n+/, "").replace(/\s+$/, "");
    return `${trimmed}\n`;
  }

  private normalizeAppendContent(content: string): string {
    const cleaned = content.replace(/^\n+/, "");
    return cleaned.endsWith("\n") ? cleaned : `${cleaned}\n`;
  }

  private isReadIntent(input: string): boolean {
    return /(?:read|show|open).*(?:file)|прочитай.*файл|покажи.*файл/i.test(input);
  }

  private isListIntent(input: string): boolean {
    return /(?:list|show).*(?:files|directory|folder)|покажи.*(?:файл|папк)|список.*файл/i.test(
      input
    );
  }

  private isDeleteIntent(input: string): boolean {
    return /(?:delete|remove).*(?:file|folder|directory)|удали.*(?:файл|папк)/i.test(input);
  }

  private isMkdirIntent(input: string): boolean {
    return /(?:create|make).*(?:folder|directory)|создай.*папк/i.test(input);
  }

  private isWriteIntent(input: string): boolean {
    return /(?:write|save|overwrite|update|edit|rewrite).*(?:file)|(?:запиши|сохрани|перепиши|обнови|измени).*(?:файл)/i.test(
      input
    );
  }

  private isAppendIntent(input: string): boolean {
    return /(?:append|add to).*(?:file)|(?:добавь|допиши).*(?:в|во)?.*(?:файл)/i.test(input);
  }

  toDescriptor() {
    return {
      name: this.name,
      description: this.description
    };
  }
}
