import fs from "fs/promises";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { ModeResult, ToolExecutionRequest, ToolExecutionResult } from "../types";
import { Tool } from "./Tool.interface";
import { authorizeOperation, canonicalPath, isWorkspacePath } from "./AccessPolicy";
import { isReviewEditRequest, readReviewSelection, reviewInputPath } from "../utils/reviewSelection";

interface FileToolOptions {
  outputDir: string;
  accessMode: "restricted" | "full";
  allowedDirectories: string[];
}

interface FileDiffPreview {
  added: number;
  removed: number;
  changeStartLine: number;
  truncated: boolean;
  preview: Array<{
    type: "add" | "remove" | "context";
    line: number;
    text: string;
  }>;
}

export class FileTool implements Tool {
  name = "file";
  description = "Reads, writes, lists, and scaffolds files inside configured local filesystem boundaries.";

  constructor(private readonly options: FileToolOptions) {}

  matchesIntent(input: string): boolean {
    // Paths and quoted source can contain action words; only the comment's
    // explicit edit request may turn a Review message into a mutation.
    if (reviewInputPath(input)) return isReviewEditRequest(input);
    // Negated instructions must not become file actions through a keyword match.
    const affirmativeInput = input
      .split(/(?<=[.!?;])\s+|\n/)
      .filter((clause) => !/\b(?:do\s+not|don['’]t|never)\s+(?:write|save|export|create|build|make|read|list|delete|append|edit|rewrite|overwrite|update)\b|\b(?:without|avoid)\s+(?:writing|saving|creating|editing|changing|deleting)\b|(?:^|\s)не\s+(?:пиши|записывай|записывать|сохраняй|сохранять|создавай|создавать|изменяй|изменять|меняй|удаляй|удалять|трогай)|без\s+(?:записи|сохранения|создания|изменения|удаления)/i.test(clause))
      .join("\n");
    return /(?:save|write|export|create|build|make|read|list|delete|mkdir|append|edit|rewrite|overwrite|update).*(?:file|project|app|folder|directory|markdown|txt)|(?:в|во)\s+файл|сохрани.*файл|создай.*(?:проект|файл|папк)|прочитай.*файл|покажи.*файл|удали.*(?:файл|папк)|допиши.*файл|добавь.*(?:в|во)?.*файл|измени.*файл|обнови.*файл|перепиши.*файл/i.test(
      affirmativeInput
    );
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    // Capture the model output once. Approval resumes this exact operation without another model call.
    const input = { ...request, result: structuredClone(request.result) };
    const rawInput = input.rawInput;
    const requestedPath = this.extractPath(rawInput);
    const selection = readReviewSelection(input.context.requestMetadata);
    if (reviewInputPath(rawInput) && !selection) throw new Error("Review selection is missing. Select the text again before editing.");
    const scaffoldFiles = this.extractScaffoldFiles(input.result);
    let operation = "write";
    let files: Array<{ path: string; content?: string }>;
    if (selection) {
      if (!isReviewEditRequest(rawInput)) throw new Error("Review comments support replacing selected text. Send whole-file operations from the chat composer.");
      if (requestedPath !== selection.path) throw new Error("The requested file does not match the Review selection.");
      const output = "response" in input.result ? input.result.toolPayload || input.result.response : "";
      let replacement: unknown;
      try { replacement = JSON.parse(output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")); } catch { /* Reject malformed proposals without touching the file. */ }
      if (!replacement || typeof replacement !== "object" || typeof (replacement as { replacement?: unknown }).replacement !== "string") {
        throw new Error('The model did not return a valid Review edit {"replacement":"..."}. No file was changed.');
      }
      files = [{ path: this.resolveTargetPath(selection.path), content: (replacement as { replacement: string }).replacement }];
    } else if (this.isReadIntent(rawInput) && requestedPath) {
      operation = "read";
      files = [{ path: this.resolveTargetPath(requestedPath) }];
    } else if (this.isListIntent(rawInput)) {
      operation = "list";
      files = [{ path: this.resolveTargetPath(requestedPath ?? this.options.outputDir) }];
    } else if (this.isDeleteIntent(rawInput) && requestedPath) {
      operation = "delete";
      files = [{ path: this.resolveTargetPath(requestedPath) }];
    } else if (this.isAppendIntent(rawInput) && requestedPath) {
      operation = "append";
      files = [{ path: this.resolveTargetPath(requestedPath), content: this.renderSingleFileContent(input.result, scaffoldFiles) }];
    } else if (scaffoldFiles.length) {
      const base = requestedPath ? this.resolveTargetPath(requestedPath) : path.join(this.options.outputDir, `scaffold-${randomUUID()}`);
      files = requestedPath && this.looksLikeFilePath(requestedPath) && scaffoldFiles.length === 1
        ? [{ path: base, content: scaffoldFiles[0].content }]
        : scaffoldFiles.map((file) => ({ path: path.resolve(base, file.filePath), content: file.content }));
    } else if (this.isMkdirIntent(rawInput) && requestedPath && !this.isWriteIntent(rawInput)) {
      operation = "mkdir";
      files = [{ path: this.resolveTargetPath(requestedPath) }];
    } else if (this.isWriteIntent(rawInput) && requestedPath) {
      files = [{ path: this.resolveTargetPath(requestedPath), content: this.renderSingleFileContent(input.result) }];
    } else {
      files = [{ path: path.join(path.resolve(this.options.outputDir), `${randomUUID()}.md`), content: `# ${input.title}\n\n${input.content}\n` }];
    }
    if (operation === "write" || operation === "append") this.assertWritableResult(input.result);
    const resolveOperationPath = async (target: string) => operation === "delete"
      ? path.join(await canonicalPath(path.dirname(target)), path.basename(target))
      : canonicalPath(target);
    files = await Promise.all(files.map(async (file) => ({ ...file, path: await resolveOperationPath(file.path) })));
    const inWorkspace = (await Promise.all(files.map((file) => isWorkspacePath(file.path, this.options.allowedDirectories)))).every(Boolean);
    let selectedFileVersion: string | undefined;
    if (selection && operation === "write") {
      const previous = await fs.readFile(files[0].path, "utf8");
      selectedFileVersion = createHash("sha256").update(previous).digest("hex");
      if (selectedFileVersion !== selection.version || previous.slice(selection.startOffset, selection.endOffset) !== selection.text) {
        throw new Error("The file changed since this selection. Refresh Review and select the text again.");
      }
      // The response is a replacement for this range. Preserve every byte around
      // it rather than asking a model to reconstruct the rest of a large file.
      const replacement = files[0].content!;
      files[0].content = previous.slice(0, selection.startOffset) + replacement + previous.slice(selection.endOffset);
    }
    const readOnly = operation === "read" || operation === "list";
    const permission = await authorizeOperation(input.context, {
      tool: this.name, operation,
      summary: `${operation[0].toUpperCase()}${operation.slice(1)} ${files.length === 1 ? files[0].path : `${files.length} files`}`,
      details: files.map((file) => `${file.path}${file.content === undefined ? "" : `\n\n${file.content}`}`).join("\n\n---\n\n")
    }, inWorkspace && operation !== "delete", readOnly);
    if (permission) return permission;
    input.context.signal?.throwIfAborted();
    // Authorize the canonical paths above, never a mutable alias or a path reparsed from user text.
    for (const file of files) {
      if (await resolveOperationPath(file.path) !== file.path) throw new Error(`Path changed while awaiting approval: ${file.path}`);
      if (selectedFileVersion && createHash("sha256").update(await fs.readFile(file.path)).digest("hex") !== selectedFileVersion) {
        throw new Error("The file changed while awaiting approval. Refresh Review and retry the edit.");
      }
    }
    const executor = new FileTool({ ...this.options, accessMode: "full" });
    const results: ToolExecutionResult[] = [];
    for (const file of files) {
      input.context.signal?.throwIfAborted();
      results.push(await (operation === "read" ? executor.readFile(file.path)
        : operation === "list" ? executor.listDirectory(file.path)
        : operation === "delete" ? executor.deletePath(file.path)
        : operation === "mkdir" ? executor.makeDirectory(file.path)
        : operation === "append" ? executor.appendFile(file.path, file.content!)
        : executor.writeFile(file.path, file.content!, Boolean(selection))));
    }
    if (results.length === 1) return results[0];
    return { tool: this.name, ok: true, output: `Wrote ${results.length} files`,
      metadata: { writtenPaths: files.map((file) => file.path), files: results.map((result) => result.metadata) } };
  }

  private async writeFile(targetPath: string, content: string, preserveContent = false): Promise<ToolExecutionResult> {
    const resolved = this.resolveTargetPath(targetPath);
    this.assertAllowed(resolved);
    const before = await this.readTextIfExists(resolved);
    const nextContent = preserveContent ? content : this.normalizeFileContent(content);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, nextContent, "utf8");

    return {
      tool: this.name,
      ok: true,
      output: `Wrote file ${resolved}`,
      metadata: {
        filePath: resolved,
        operation: "write",
        beforeExists: before.exists,
        afterHash: createHash("sha256").update(nextContent).digest("hex"),
        diff: this.createDiffPreview(before.content, nextContent)
      }
    };
  }

  private async appendFile(targetPath: string, content: string): Promise<ToolExecutionResult> {
    const resolved = this.resolveTargetPath(targetPath);
    this.assertAllowed(resolved);
    const before = await this.readTextIfExists(resolved);
    const appendedContent = this.normalizeAppendContent(content);
    const nextContent = `${before.content}${appendedContent}`;
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.appendFile(resolved, appendedContent, "utf8");

    return {
      tool: this.name,
      ok: true,
      output: `Appended file ${resolved}`,
      metadata: {
        filePath: resolved,
        operation: "append",
        beforeExists: before.exists,
        afterHash: createHash("sha256").update(nextContent).digest("hex"),
        diff: this.createDiffPreview(before.content, nextContent)
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

  private async readTextIfExists(filePath: string): Promise<{ exists: boolean; content: string }> {
    try {
      return {
        exists: true,
        content: await fs.readFile(filePath, "utf8")
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") {
        return { exists: false, content: "" };
      }

      throw error;
    }
  }

  private createDiffPreview(before: string, after: string): FileDiffPreview {
    const beforeLines = this.splitPreviewLines(before);
    const afterLines = this.splitPreviewLines(after);
    let prefix = 0;

    while (
      prefix < beforeLines.length &&
      prefix < afterLines.length &&
      beforeLines[prefix] === afterLines[prefix]
    ) {
      prefix += 1;
    }

    let suffix = 0;

    while (
      suffix + prefix < beforeLines.length &&
      suffix + prefix < afterLines.length &&
      beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }

    const removedBlock = beforeLines.slice(prefix, beforeLines.length - suffix);
    const addedBlock = afterLines.slice(prefix, afterLines.length - suffix);
    const rows: FileDiffPreview["preview"] = [];
    const contextBefore = beforeLines.slice(Math.max(0, prefix - 3), prefix);
    const contextAfter = afterLines.slice(prefix + addedBlock.length, prefix + addedBlock.length + 3);
    const maxChangedRows = 36;
    let changedRows = 0;

    contextBefore.forEach((text, index) => {
      rows.push({
        type: "context",
        line: Math.max(1, prefix - contextBefore.length + index + 1),
        text: this.truncatePreviewLine(text)
      });
    });

    for (let index = 0; index < removedBlock.length && changedRows < maxChangedRows; index += 1) {
      rows.push({
        type: "remove",
        line: prefix + index + 1,
        text: this.truncatePreviewLine(removedBlock[index])
      });
      changedRows += 1;
    }

    for (let index = 0; index < addedBlock.length && changedRows < maxChangedRows; index += 1) {
      rows.push({
        type: "add",
        line: prefix + index + 1,
        text: this.truncatePreviewLine(addedBlock[index])
      });
      changedRows += 1;
    }

    contextAfter.forEach((text, index) => {
      rows.push({
        type: "context",
        line: prefix + addedBlock.length + index + 1,
        text: this.truncatePreviewLine(text)
      });
    });

    return {
      added: addedBlock.length,
      removed: removedBlock.length,
      changeStartLine: prefix + 1,
      truncated: removedBlock.length + addedBlock.length > maxChangedRows,
      preview: rows
    };
  }

  private splitPreviewLines(content: string): string[] {
    const normalized = content.replace(/\n$/, "");
    return normalized ? normalized.split(/\r?\n/) : [];
  }

  private truncatePreviewLine(line: string): string {
    return line.length > 220 ? `${line.slice(0, 217)}...` : line;
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

  private resolveTargetPath(rawPath: string): string {
    if (path.isAbsolute(rawPath)) {
      return path.resolve(rawPath);
    }

    const base =
      this.options.allowedDirectories[0] || this.options.outputDir || process.cwd();
    return path.resolve(base, rawPath);
  }

  private extractPath(input: string): string | undefined {
    const reviewPath = reviewInputPath(input);
    if (reviewPath) return reviewPath;
    const fenced = input.match(/`([^`]+)`/);

    if (fenced?.[1]) {
      return fenced[1].trim();
    }

    const pathLike = input.match(
      /(?:^|\s|["'])(~?\/[^\s"',:;]+|\.{1,2}\/[^\s"',:;]+|[\w.-]+(?:\/[\w.-]+)+|[\w-]+\.[A-Za-z0-9]{1,16})(?=$|\s|["',:;])/i
    );

    if (pathLike?.[1]) {
      return pathLike[1].trim();
    }

    if (/\b(?:current|working)\s+directory\b|\bcurrent\s+folder\b|текущ(?:ей|ую)\s+(?:директори[ию]|папк[еу])/i.test(input)) {
      return this.options.allowedDirectories.at(-1) || process.cwd();
    }

    return undefined;
  }

  private looksLikeFilePath(rawPath: string): boolean {
    return path.extname(rawPath).length > 1;
  }

  private extractScaffoldFiles(result: ModeResult): Array<{ filePath: string; content: string }> {
    if (!("response" in result)) {
      return [];
    }

    const executionOutput = result.toolPayload?.trim() || result.response;
    const matches = Array.from(
      executionOutput.matchAll(/<<<FILE:([^\n>]+)>>>\n?([\s\S]*?)<<<END FILE>>>/g)
    );

    return matches
      .map((match) => ({
        filePath: match[1].trim(),
        content: match[2].replace(/^\n+/, "")
      }))
      .filter((item) => item.filePath && item.content.trim());
  }

  private renderSingleFileContent(
    result: ModeResult,
    scaffoldFiles: Array<{ filePath: string; content: string }> = this.extractScaffoldFiles(result)
  ): string {
    if (scaffoldFiles.length === 1) {
      return scaffoldFiles[0].content;
    }

    if (!("response" in result)) {
      return JSON.stringify(result, null, 2);
    }

    return (result.toolPayload?.trim() || result.response)
      .replace(/<<<FILE:[^\n>]+>>>\n?/g, "")
      .replace(/<<<END FILE>>>/g, "")
      .trim();
  }

  private assertWritableResult(result: ModeResult): void {
    if (!("response" in result)) {
      return;
    }

    if (/^Mock response from /i.test((result.toolPayload?.trim() || result.response).trim())) {
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
    return /(?:write|save|overwrite|update|edit|rewrite|create).*(?:file)|(?:запиши|сохрани|перепиши|обнови|измени|создай).*(?:файл)/i.test(
      input
    );
  }

  private isAppendIntent(input: string): boolean {
    return /(?:append|add to).*(?:file)|(?:добавь|допиши).*(?:в|во)?.*(?:файл)|(?:добавь|допиши).*(?:в конец|в файл)/i.test(input);
  }

  toDescriptor() {
    return {
      name: this.name,
      description: this.description
    };
  }
}
