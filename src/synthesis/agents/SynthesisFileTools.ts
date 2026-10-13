import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { OperationExecutor, OperationInput } from "../../tools/OperationExecutor";
import { parseAgentAction } from "../../tools/AgentTool";
import { PendingApproval, ToolExecutionResult } from "../../types";
import { isMissingFile } from "../../utils/fileStore";
import { matchesGlob } from "../checks/architecture";
import { containedPath, MAX_ARTIFACT_BYTES, readText } from "../paths";
import { SynthesisError } from "../types";

/** What an agent may touch, by project-relative patterns. */
export interface FilePermissions { read: string[]; write: string[]; delete: string[] }

/** The run's copy of the files it may change: the files of the candidate and what the project holds. */
export interface CandidateStore {
  /** The project folder; reads of anything outside the candidate come from here. */
  root: string;
  /** The candidate's folder (checkout), project-relative; undefined before checkout. */
  outputPath?: string;
  /** Candidate files by path relative to the checkout folder. */
  files: Record<string, string>;
  /** What each changed file held in the project when the run first touched it (null: it did not exist). */
  baseline: Record<string, string | null>;
  /** Project files the run deleted (relative to the checkout folder). */
  removed: string[];
  /** Whether the contract lets the run write this checkout-relative path, and why not. */
  writable(relative: string): string | undefined;
  /** Paths no agent reads, whatever its rights (the contract and its tests). */
  hidden(projectRelative: string): boolean;
  /** Called after every change, so the run can record it. */
  changed(): void;
}

const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const MAX_READ_BYTES = 5 * 1024 * 1024, MAX_RESULT_BYTES = 48_000;
const SKIPPED = new Set([".git", "node_modules", "dist", "build", "release", "coverage", "vendor", "target", "Binaries", "Intermediate", "DerivedDataCache"]);

/** Whether a path matches a glob ("*" within a folder, "**" across folders), in time proportional to
 * the pattern's length times the path's: patterns come from the model, so no backtracking regex. */
export function globMatches(pattern: string, value: string): boolean {
  const tokens: Array<"*" | "**" | string> = [];
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] !== "*") { tokens.push(pattern[index]); continue; }
    let end = index; while (pattern[end + 1] === "*") end++;
    const double = end > index;
    // "**/" may also stand for no folder at all: "src/**/a.ts" matches "src/a.ts".
    if (double && pattern[end + 1] === "/" && (index === 0 || pattern[index - 1] === "/")) { tokens.push("**/"); end++; }
    else tokens.push(double ? "**" : "*");
    index = end;
  }
  // reachable[j]: the tokens so far can match value[0, j).
  let reachable = new Array<boolean>(value.length + 1).fill(false); reachable[0] = true;
  for (const token of tokens) {
    const next = new Array<boolean>(value.length + 1).fill(false);
    for (let j = 0; j <= value.length; j++) {
      if (token === "*" || token === "**") {
        // Any run of characters (without "/" for "*") after a reachable position.
        if (reachable[j] || (j > 0 && next[j - 1] && (token === "**" || value[j - 1] !== "/"))) next[j] = true;
      } else if (token === "**/") {
        if (reachable[j]) next[j] = true;
        if (j > 0 && value[j - 1] === "/") for (let k = j - 1; k >= 0; k--) { if (reachable[k]) { next[j] = true; break; } }
      } else if (j > 0 && reachable[j - 1] && value[j - 1] === token) next[j] = true;
    }
    reachable = next;
  }
  return reachable[value.length];
}
/** Like a filename filter in a search, "*.ts" matches at any depth; a pattern with "/" is anchored to the search root. */
function searchFilter(pattern: string): (value: string) => boolean {
  const rootRelative = pattern.startsWith("./") || pattern.includes("/");
  const normalized = pattern.replace(/^\.\//, "");
  return value => globMatches(normalized, value) || (!rootRelative && value.split("/").some((_part, index, parts) => index > 0 && globMatches(normalized, parts.slice(index).join("/"))));
}
/** The literal folder a pattern starts with: "src/**" → "src", "**" → "". */
const staticPrefix = (pattern: string) => { const parts: string[] = []; for (const part of pattern.split("/")) { if (part.includes("*")) break; parts.push(part); } return parts.join("/"); };
/** Whether a folder may hold files the pattern matches (the folder is above or inside the pattern's own folder). */
function mayHold(folder: string, pattern: string): boolean {
  if (!folder) return true;
  const prefix = staticPrefix(pattern);
  if (prefix === pattern) return pattern === folder || pattern.startsWith(`${folder}/`);
  return !prefix || prefix === folder || prefix.startsWith(`${folder}/`) || folder.startsWith(`${prefix}/`);
}

/** A Synthesis agent's file tools: reads the project within its rights, writes only into the run's copy.
 * Nothing it does reaches the project before Apply, and nothing asks for approval: a refusal is final. */
export class SynthesisFileTools extends OperationExecutor {
  /** Files this agent created, changed or deleted, project-relative. */
  readonly touched = new Set<string>();
  private static readonly locks = new Map<string, Promise<unknown>>();
  constructor(baseDir: string, private readonly candidates: CandidateStore, private readonly rights: FilePermissions) { super(baseDir); }
  async hasExternalMcp(): Promise<boolean> { return false; }

  async execute(input: OperationInput): Promise<{result?: ToolExecutionResult; pendingApproval?: PendingApproval}> {
    const action = parseAgentAction({tool: input.tool, arguments: input.arguments});
    if (!action.tool.startsWith("file.")) throw new Error(`${action.tool} is not one of this agent's tools.`);
    const target = this.path(String(action.arguments.path ?? "."));
    const args = action.arguments;
    input.signal?.throwIfAborted();
    switch (action.tool) {
      case "file.list": return {result: await this.list(target, Number(args.limit))};
      case "file.search": return {result: await this.search(target, String(args.query), Number(args.maxResults ?? args.limit), Number(args.maxFiles), args)};
      case "file.read": return {result: await this.read(target, Number(args.startLine), args.endLine === undefined ? undefined : Number(args.endLine))};
      case "file.mkdir": this.mayWrite(target, "write"); return {result: this.result("mkdir", target, `Folders are created with their first file: ${target} is ready.`)};
      default: return {result: await this.change(action.tool, target, args)};
    }
  }

  /** A project-relative path, without traversal, hidden folders or absolute forms. */
  private path(raw: string): string {
    const value = raw.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (!value || value === ".") return "";
    if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) throw new Error(`Use a project-relative path such as src/index.ts, not ${raw}.`);
    if (value.split("/").some(part => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) || part === "node_modules")) throw new Error(`${raw} is not a path this agent may use: no hidden folders, "..", spaces or node_modules.`);
    if (value.length > 240) throw new Error("Paths are at most 240 characters.");
    return value;
  }
  /** The file or folder in the project, refused when any part of its path is a symbolic link. */
  private async inside(target: string): Promise<string> {
    try { return await containedPath(this.candidates.root, target); }
    catch (error) { if (error instanceof SynthesisError) throw new Error(`${target}: agents do not follow symbolic links.`); throw error; }
  }
  private mayRead(target: string): boolean {
    return !this.candidates.hidden(target) && this.rights.read.some(pattern => matchesGlob(target, pattern));
  }
  private mayWrite(target: string, access: "write" | "delete"): string {
    const patterns = access === "delete" ? this.rights.delete : this.rights.write;
    if (!target || !patterns.some(pattern => matchesGlob(target, pattern))) throw new Error(`This agent may not ${access} ${target || "the project root"}. It may ${access}: ${patterns.join(", ") || "nothing"}.`);
    const output = this.candidates.outputPath;
    if (!output || !target.startsWith(`${output}/`)) throw new Error(`${target} is outside the run's candidate folder ${output ?? "(none checked out)"}: agents write only there.`);
    const relative = target.slice(output.length + 1);
    const refusal = this.candidates.writable(relative);
    if (refusal) throw new Error(refusal);
    return relative;
  }
  /** The candidate's copy of a file under the checkout folder, if the run has one. */
  private candidate(target: string): {relative: string; content: string | null} | undefined {
    const output = this.candidates.outputPath;
    if (!output || !target.startsWith(`${output}/`)) return undefined;
    const relative = target.slice(output.length + 1);
    if (Object.hasOwn(this.candidates.files, relative)) return {relative, content: this.candidates.files[relative]};
    if (this.candidates.removed.includes(relative)) return {relative, content: null};
    return undefined;
  }
  private async content(target: string): Promise<string | null> {
    const copy = this.candidate(target);
    if (copy) return copy.content;
    try {
      // Every folder on the way is checked too: a link anywhere in the path could lead out of the project.
      return await readText(await this.inside(target), MAX_READ_BYTES);
    } catch (error) { if (isMissingFile(error)) return null; throw error; }
  }
  private async read(target: string, startLine: number, endLine?: number): Promise<ToolExecutionResult> {
    if (!this.mayRead(target)) throw new Error(`This agent may not read ${target || "the project root"}. It may read: ${this.rights.read.join(", ") || "nothing"}.`);
    const content = await this.content(target);
    if (content === null) throw new Error(`${target} does not exist.`);
    if (content.includes("\0")) throw new Error(`${target} is a binary file.`);
    const lines = content.split("\n");
    const end = Math.min(endLine ?? startLine + 199, lines.length);
    if (end < startLine && lines.length >= startLine) throw new Error("endLine must be at least startLine.");
    const selected: string[] = [];
    let size = 0;
    for (let index = startLine - 1; index < end; index++) {
      const row = `${index + 1}: ${lines[index]}`;
      if (size + Buffer.byteLength(row) > MAX_RESULT_BYTES) break;
      selected.push(row); size += Buffer.byteLength(row) + 1;
    }
    const data = {path: target, version: hash(content), startLine, endLine: startLine + selected.length - 1, totalLines: lines.length,
      truncated: startLine + selected.length - 1 < lines.length, content: selected.join("\n")};
    return this.result("read", target, JSON.stringify(data), {version: data.version});
  }
  /** The files this agent may read, project-relative (at most `limit`). */
  async readable(limit = 400): Promise<string[]> { return (await this.readableFiles("", limit)).files; }
  /** Every readable file under a folder: the project's, then the candidate's own. */
  private async readableFiles(folder: string, limit: number): Promise<{files: string[]; truncated: boolean}> {
    // A file named where a folder is expected: that file alone.
    if (folder && this.mayRead(folder) && await this.content(folder).catch(() => null) !== null) return {files: [folder], truncated: false};
    const found = new Set<string>();
    const queue = [folder];
    let truncated = false;
    while (queue.length) {
      const current = queue.shift()!;
      let entries: import("node:fs").Dirent[] = [];
      try { entries = await fs.readdir(current ? await this.inside(current) : this.candidates.root, {withFileTypes: true}); }
      catch (error) { if (isMissingFile(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue; throw error; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".") || SKIPPED.has(entry.name) || entry.isSymbolicLink()) continue;
        const relative = current ? `${current}/${entry.name}` : entry.name;
        if (this.candidates.hidden(relative)) continue;
        if (entry.isDirectory()) { if (this.rights.read.some(pattern => mayHold(relative, pattern))) queue.push(relative); continue; }
        if (entry.isFile() && this.mayRead(relative)) { if (found.size >= limit) { truncated = true; break; } found.add(relative); }
      }
      if (truncated) break;
    }
    const output = this.candidates.outputPath;
    if (output) for (const relative of Object.keys(this.candidates.files)) {
      const target = `${output}/${relative}`;
      if ((!folder || target.startsWith(`${folder}/`)) && this.mayRead(target)) found.add(target);
    }
    if (output) for (const relative of this.candidates.removed) found.delete(`${output}/${relative}`);
    return {files: [...found].sort(), truncated};
  }
  private async list(target: string, limit: number): Promise<ToolExecutionResult> {
    if (!this.rights.read.some(pattern => mayHold(target, pattern) || matchesGlob(target, pattern))) throw new Error(`This agent may not list ${target || "the project root"}. It may read: ${this.rights.read.join(", ") || "nothing"}.`);
    const {files} = await this.readableFiles(target, 5000);
    const prefix = target ? `${target}/` : "";
    const entries = new Map<string, "file" | "directory">();
    for (const file of files) {
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      entries.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? "file" : "directory");
    }
    const listed = [...entries].sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([name, type]) => ({name, type}));
    return this.result("list", target || ".", JSON.stringify({path: target || ".", entries: listed, truncated: entries.size > limit, total: entries.size}), {entries: listed});
  }
  private async search(root: string, query: string, limit: number, maxFiles: number, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const include = (args.include as string[] | undefined)?.map(searchFilter);
    const exclude = (args.exclude as string[] | undefined)?.map(searchFilter) ?? [];
    const {files, truncated: more} = await this.readableFiles(root, maxFiles);
    const matches: Array<{path: string; line?: number; text?: string}> = [];
    let scanned = 0;
    for (const file of files) {
      const relative = root ? file.slice(root.length + 1) : file;
      if (exclude.some(matches => matches(relative)) || (include?.length && !include.some(matches => matches(relative)))) continue;
      scanned++;
      if (!query) { matches.push({path: file}); if (matches.length >= limit) break; continue; }
      const content = await this.content(file).catch(() => null);
      if (!content || Buffer.byteLength(content) > Number(args.maxFileBytes ?? 524288) || content.includes("\0")) continue;
      const needle = query.toLocaleLowerCase();
      for (const [index, line] of content.split("\n").entries()) {
        if (line.toLocaleLowerCase().includes(needle)) matches.push({path: file, line: index + 1, text: line.slice(0, 500)});
        if (matches.length >= limit) break;
      }
      if (matches.length >= limit) break;
    }
    return this.result("search", root || ".", JSON.stringify({root: root || ".", query, scannedFiles: scanned, matches, truncated: more || matches.length >= limit,
      note: "Paths are relative to the project; pass them to file.read as they are."}), {results: matches});
  }
  private async change(tool: string, target: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const relative = this.mayWrite(target, tool === "file.delete" ? "delete" : "write");
    return SynthesisFileTools.locked(`${this.candidates.root}\0${target}`, async () => {
      const before = await this.content(target);
      const version = before === null ? "missing" : hash(before);
      if (args.expectedVersion !== version) throw new Error(`File version conflict at ${target}: it changed since you read it (another agent may have written it). Read it again before changing it.`);
      if (!Object.hasOwn(this.candidates.baseline, relative)) {
        // What the project holds now, for Apply to find any edit made meanwhile.
        const copy = this.candidate(target);
        this.candidates.baseline[relative] = copy ? copy.content : before;
      }
      if (tool === "file.delete") {
        if (before === null) throw new Error(`${target} does not exist.`);
        delete this.candidates.files[relative];
        if (this.candidates.baseline[relative] !== null && !this.candidates.removed.includes(relative)) this.candidates.removed.push(relative);
        this.touched.add(target); this.candidates.changed();
        return this.result("delete", target, `Deleted ${target} in the run's copy (the project changes only on Apply).`);
      }
      let after = String(args.content ?? "");
      if (tool === "file.append") after = (before ?? "") + after;
      if (tool === "file.replace") {
        const original = String(args.oldText), current = before ?? "";
        if (!current.includes(original) || current.indexOf(original) !== current.lastIndexOf(original)) throw new Error("oldText must match exactly one range. Read the file and provide a unique range.");
        after = current.replace(original, () => String(args.newText));
      }
      if (Buffer.byteLength(after) > MAX_ARTIFACT_BYTES) throw new Error(`A candidate file holds at most ${MAX_ARTIFACT_BYTES / 1024} KiB.`);
      this.candidates.files[relative] = after;
      this.candidates.removed = this.candidates.removed.filter(item => item !== relative);
      this.touched.add(target); this.candidates.changed();
      return this.result(tool.slice(5), target, `Saved ${target} in the run's copy (the project changes only on Apply).`, {version: hash(after), bytes: Buffer.byteLength(after)});
    });
  }
  private result(operation: string, filePath: string, output: string, extra: Record<string, unknown> = {}): ToolExecutionResult {
    return {tool: "file", ok: true, output, metadata: {operation, filePath, ...extra}};
  }
  /** One change of a path at a time, across every agent of every run. */
  private static async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = SynthesisFileTools.locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    SynthesisFileTools.locks.set(key, current);
    try { return await current; } finally { if (SynthesisFileTools.locks.get(key) === current) SynthesisFileTools.locks.delete(key); }
  }
}

/** The tools each right gives, and how an agent is told to use them. */
export function agentTools(rights: FilePermissions): string[] {
  return [...rights.read.length ? ["file.list", "file.search", "file.read"] : [], ...rights.write.length ? ["file.write", "file.replace", "file.append", "file.mkdir"] : [],
    ...rights.delete.length ? ["file.delete"] : []];
}
export function agentToolText(rights: FilePermissions): string {
  return [
    "Tools (arguments are JSON; paths are relative to the project, such as src/index.ts):",
    rights.read.length ? 'file.list {path:"."} lists a folder. file.search {path:".",query:"literal text",include?:["*.ts"]} finds lines (an empty query lists files). file.read {path,startLine?:1,endLine?} reads up to 200 lines and returns the file\'s version.' : "",
    rights.write.length ? 'file.write {path,content,expectedVersion} writes a whole file: for a NEW file expectedVersion is "missing", for an existing one the version file.read returned. file.replace {path,oldText,newText,expectedVersion} changes one unique range. file.append {path,content,expectedVersion} adds to the end.' : "",
    rights.delete.length ? "file.delete {path,expectedVersion} deletes a file." : "",
    rights.write.length ? "Other agents work at the same time: when a write reports a version conflict, read the file again and redo your change." : ""
  ].filter(Boolean).join("\n");
}
