import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { OperationExecutor, OperationInput } from "../../tools/OperationExecutor";
import { parseAgentAction } from "../../tools/AgentTool";
import { PendingApproval, ToolExecutionResult } from "../../types";
import { isMissingFile } from "../../utils/fileStore";
import { matchesGlob } from "../checks/architecture";
import { containedPath, MAX_ARTIFACT_BYTES, readText } from "../paths";
import { searchFilter } from "../../tools/searchGlob";
export { globMatches } from "../../tools/searchGlob";
import { SynthesisError } from "../types";
import { Checkouts, Holder } from "./Checkouts";
import { AgentTerminal, TerminalHost } from "./Terminal";

/** What an agent may touch, by project-relative patterns. `own`: of the write patterns, those whose
 * files belong to the agent that first creates or changes them. */
export interface FilePermissions { read: string[]; write: string[]; delete: string[]; own?: string[];
  /** The commands its terminal may run (terminal(...)); none without one. */
  terminal?: string[] }
/** The agents of one parallel_map: their checkouts and owned files, which of them this one is, and
 * where their terminals run. */
export interface Team { checkouts: Checkouts; me: Holder; terminal?: TerminalHost }

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
  /** Project files as the run first read them, by path as the disk spells it. */
  snapshot?: Map<string, string | null>;
  /** Keeps a first read (within the run's bound) and returns the version every agent then sees. */
  keep?(path: string, content: string | null): string | null;
}

const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const MAX_READ_BYTES = 5 * 1024 * 1024, MAX_RESULT_BYTES = 48_000;
/** The longest an agent waits for files another one holds: a wait costs no turn, a retry does. */
const MAX_WAIT_SECONDS = 600;
const SKIPPED = new Set([".git", "node_modules", "dist", "build", "release", "coverage", "vendor", "target", "Binaries", "Intermediate", "DerivedDataCache"]);

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
  /** Files this agent created, changed or deleted in the candidate (submitted), project-relative. */
  readonly touched = new Set<string>();
  /** Changes to checked-out files, the agent's own until it submits them (null: deleted). */
  private readonly pending = new Map<string, {target: string; content: string | null}>();
  private static readonly locks = new Map<string, Promise<unknown>>();
  constructor(baseDir: string, private readonly candidates: CandidateStore, private readonly rights: FilePermissions, private readonly team?: Team) { super(baseDir); }
  async hasExternalMcp(): Promise<boolean> { return false; }

  async execute(input: OperationInput): Promise<{result?: ToolExecutionResult; pendingApproval?: PendingApproval}> {
    const action = parseAgentAction({tool: input.tool, arguments: input.arguments});
    const args = action.arguments;
    input.signal?.throwIfAborted();
    if (action.tool === "terminal.run") return {result: await this.runCommand(String(args.command), (args.args as string[]) ?? [], String(args.cwd ?? "."), Number(args.timeoutSeconds ?? 60), input.signal)};
    if (!action.tool.startsWith("file.")) throw new Error(`${action.tool} is not one of this agent's tools.`);
    if (action.tool === "file.checkout") return {result: await this.checkout((args.paths as string[]).map(item => this.path(item)), Number(args.waitSeconds ?? 0), input.signal)};
    if (action.tool === "file.submit" || action.tool === "file.revert") {
      const paths = (args.paths as string[] | undefined)?.map(item => this.path(item));
      return {result: action.tool === "file.submit" ? await this.submit(paths) : this.revert(paths)};
    }
    const target = this.path(String(action.arguments.path ?? "."));
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
  /** The file or folder in the project, refused when any part of its path is a symbolic link, or when
   * the path as the disk spells it is hidden (a file system that ignores case opens SYNTHESIS as Synthesis). */
  private async inside(target: string): Promise<string> {
    const spelled = await this.spelled(target);
    if (this.candidates.hidden(spelled)) throw new Error(`This agent may not read ${target}: it belongs to a contract.`);
    try { return await containedPath(this.candidates.root, spelled); }
    catch (error) { if (error instanceof SynthesisError) throw new Error(`${target}: agents do not follow symbolic links.`); throw error; }
  }
  /** The path with each existing part as the disk spells it (the same name, another case, when the file
   * system ignores case); parts that do not exist stay as given. */
  private async spelled(target: string): Promise<string> {
    const parts: string[] = [];
    let folder = this.candidates.root, exists = true;
    for (const part of target.split("/").filter(Boolean)) {
      let name = part;
      if (exists) {
        const entries = await fs.readdir(folder).catch(() => undefined);
        if (!entries) exists = false;
        else if (!entries.includes(part)) { const twin = entries.find(entry => entry.toLowerCase() === part.toLowerCase()); if (twin) name = twin; else exists = false; }
      }
      parts.push(name); folder = `${folder}/${name}`;
    }
    return parts.join("/");
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
  /** A file as this agent sees it: its own pending change first (`mine`), then the candidate, then the project. */
  private async content(target: string, mine = true): Promise<string | null> {
    const output = this.candidates.outputPath;
    const own = mine && output && target.startsWith(`${output}/`) ? this.pending.get(target.slice(output.length + 1)) : undefined;
    if (own) return own.content;
    const copy = this.candidate(target);
    if (copy) return copy.content;
    // Every agent of the run reads one version of a project file, the one read first: an edit made
    // on disk during the run does not give agents different views (Apply then finds the edit).
    const file = await this.inside(target);
    const key = await this.spelled(target);
    const seen = this.candidates.snapshot?.get(key);
    if (seen !== undefined) return seen;
    let content: string | null;
    // Every folder on the way is checked too (inside): a link anywhere in the path could lead out of the project.
    try { content = await readText(file, MAX_READ_BYTES); } catch (error) { if (isMissingFile(error)) content = null; else throw error; }
    return this.candidates.keep?.(key, content) ?? content;
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
  /** The key two agents share for one file, whatever case they write it in. */
  private async key(target: string): Promise<string> { return (await this.spelled(target)).toLowerCase(); }
  /** Whether the other agents leave this file to this one: not checked out or owned by another, and
   * checked out here when the parallel_map requires it. */
  private mayChange(key: string, target: string): void {
    if (!this.team) return;
    const {checkouts, me} = this.team;
    const holder = checkouts.holder(key), owner = checkouts.owner(key);
    if (holder && holder.agent !== me.agent) throw new Error(`${target} is checked out by agent ${holder.agent + 1} (its task: ${holder.task.slice(0, 120)}). Read it, or work on other files; it is released when that agent submits or finishes.`);
    if (owner && owner.agent !== me.agent) throw new Error(`${target} belongs to agent ${owner.agent + 1}, which created it: agents may read it, not change it.`);
    if (checkouts.required && holder?.agent !== me.agent) throw new Error(`Check ${target} out before changing it: file.checkout {"paths":["${target}"]}.`);
  }
  private async change(tool: string, target: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const access = tool === "file.delete" ? "delete" : "write";
    this.mayWrite(target, access);
    const key = await this.key(target);
    // One change of a path at a time, whatever case an agent writes it in (the disk may ignore case).
    return SynthesisFileTools.locked(`${this.candidates.root}\0${key}`, async () => {
      const before = await this.content(target);
      // Checked again with no wait before the change: another agent may have made a twin, the last
      // file, or a checkout meanwhile.
      const relative = this.mayWrite(target, access);
      this.mayChange(key, target);
      const version = before === null ? "missing" : hash(before);
      if (args.expectedVersion !== version) throw new Error(`File version conflict at ${target}: it changed since you read it (another agent may have written it). Read it again before changing it.`);
      let after: string | null;
      if (tool === "file.delete") {
        if (before === null) throw new Error(`${target} does not exist.`);
        after = null;
      } else {
        after = String(args.content ?? "");
        if (tool === "file.append") after = (before ?? "") + after;
        if (tool === "file.replace") {
          const original = String(args.oldText), current = before ?? "";
          if (!current.includes(original) || current.indexOf(original) !== current.lastIndexOf(original)) throw new Error("oldText must match exactly one range. Read the file and provide a unique range.");
          after = current.replace(original, () => String(args.newText));
        }
        if (Buffer.byteLength(after) > MAX_ARTIFACT_BYTES) throw new Error(`A candidate file holds at most ${MAX_ARTIFACT_BYTES / 1024} KiB.`);
      }
      // A checked-out file changes in this agent's checkout: the others see it once it is submitted.
      if (this.team?.checkouts.holder(key)?.agent === this.team?.me.agent && this.team) {
        this.pending.set(relative, {target, content: after});
        return this.result(tool.slice(5), target, `${after === null ? "Deleted" : "Saved"} ${target} in your checkout: the other agents see it when you submit it (file.submit) or finish.`,
          after === null ? {} : {version: hash(after), bytes: Buffer.byteLength(after)});
      }
      await this.commit(relative, target, key, after);
      return after === null ? this.result("delete", target, `Deleted ${target} in the run's copy (the project changes only on Apply).`)
        : this.result(tool.slice(5), target, `Saved ${target} in the run's copy (the project changes only on Apply).`, {version: hash(after), bytes: Buffer.byteLength(after)});
    });
  }
  /** Puts a change into the candidate (null deletes the file), recording what the project held before it. */
  private async commit(relative: string, target: string, key: string, after: string | null): Promise<void> {
    if (!Object.hasOwn(this.candidates.baseline, relative)) {
      // What the project holds now, for Apply to find any edit made meanwhile.
      const copy = this.candidate(target);
      this.candidates.baseline[relative] = copy ? copy.content : await this.content(target, false);
    }
    if (after === null) {
      delete this.candidates.files[relative];
      if (this.candidates.baseline[relative] !== null && !this.candidates.removed.includes(relative)) this.candidates.removed.push(relative);
    } else {
      this.candidates.files[relative] = after;
      this.candidates.removed = this.candidates.removed.filter(item => item !== relative);
    }
    if (this.team && (this.rights.own ?? []).some(pattern => matchesGlob(target, pattern))) this.team.checkouts.own(key, this.team.me);
    this.touched.add(target); this.candidates.changed();
  }
  /** Takes files for this agent's work, all of them or none: the others read their last submitted
   * version and change nothing of them until it submits, reverts or finishes. */
  private async checkout(targets: string[], waitSeconds: number, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (!this.team) throw new Error("Checkouts are for agents of a parallel_map.");
    for (const target of targets) {
      const writable = [...this.rights.write, ...this.rights.delete].some(pattern => matchesGlob(target, pattern));
      if (!writable && !this.mayRead(target)) throw new Error(`This agent may not check out ${target}: it may neither read nor change it.`);
    }
    const keys = await Promise.all(targets.map(target => this.key(target)));
    const holding = this.team.checkouts.heldBy(this.team.me.agent).length > 0;
    const blocking = await this.team.checkouts.acquire(this.team.me, keys, holding ? 0 : Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.floor(waitSeconds))) * 1000, signal);
    if (blocking.length) {
      throw new Error(`Nothing was checked out: ${blocking.map(holder => `agent ${holder.agent + 1} (its task: ${holder.task.slice(0, 100)})`).join(", ")} ${blocking.length === 1 ? "holds or owns" : "hold or own"} some of these files. ` +
        (holding ? "You hold other files, so you cannot wait: submit or revert yours first, or work on other files." : "Wait for them with waitSeconds, or work on other files."));
    }
    const files = await Promise.all(targets.map(async target => { const content = await this.content(target).catch(() => null); return {path: target, version: content === null ? "missing" : hash(content)}; }));
    return this.result("checkout", targets.join(", "), JSON.stringify({checkedOut: files, note: "Change them with expectedVersion as usual; submit with file.submit, or drop the changes with file.revert."}));
  }
  /** Puts this agent's pending changes into the candidate and releases their files (all without paths). */
  private async submit(targets?: string[]): Promise<ToolExecutionResult> {
    if (!this.team) throw new Error("Checkouts are for agents of a parallel_map.");
    const keys = targets ? await Promise.all(targets.map(target => this.key(target))) : this.team.checkouts.heldBy(this.team.me.agent);
    const submitted: string[] = [];
    for (const [relative, change] of [...this.pending]) {
      const key = await this.key(change.target);
      if (!keys.includes(key)) continue;
      await SynthesisFileTools.locked(`${this.candidates.root}\0${key}`, () => this.commit(relative, change.target, key, change.content));
      this.pending.delete(relative); submitted.push(change.target);
    }
    this.team.checkouts.release(this.team.me.agent, keys);
    return this.result("submit", submitted.join(", ") || "-", submitted.length ? `Submitted ${submitted.join(", ")}: the other agents see it now, and the files are released.` : "Nothing to submit; the files are released.");
  }
  /** Drops this agent's pending changes and releases their files (all without paths). */
  private revert(targets?: string[]): ToolExecutionResult {
    if (!this.team) throw new Error("Checkouts are for agents of a parallel_map.");
    const output = this.candidates.outputPath ?? "";
    const reverted = [...this.pending].filter(([, change]) => !targets || targets.some(target => target.toLowerCase() === change.target.toLowerCase())).map(([relative, change]) => { this.pending.delete(relative); return change.target; });
    const keys = targets?.map(target => target.toLowerCase());
    this.team.checkouts.release(this.team.me.agent, keys ? this.team.checkouts.heldBy(this.team.me.agent).filter(key => keys.includes(key) || keys.includes(`${output}/${key}`)) : undefined);
    return this.result("revert", reverted.join(", ") || "-", reverted.length ? `Reverted ${reverted.join(", ")}; the files are released.` : "Nothing to revert; the files are released.");
  }
  private shell?: AgentTerminal;
  /** A command in the agent's sandboxed copy of what it may read. */
  private async runCommand(command: string, args: string[], cwd: string, timeoutSeconds: number, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (!this.rights.terminal?.length || !this.team?.terminal) throw new Error("This agent has no terminal.");
    this.shell ??= new AgentTerminal(this.team.terminal, {
      root: this.candidates.root,
      readable: limit => this.readable(limit),
      content: file => this.content(file),
      candidate: () => {
        const output = this.candidates.outputPath;
        const files: Record<string, string> = {}, removed: string[] = [];
        if (output) {
          for (const [relative, content] of Object.entries(this.candidates.files)) files[`${output}/${relative}`] = content;
          for (const relative of this.candidates.removed) removed.push(`${output}/${relative}`);
          for (const [relative, change] of this.pending) { if (change.content === null) { delete files[`${output}/${relative}`]; removed.push(`${output}/${relative}`); } else files[`${output}/${relative}`] = change.content; }
        }
        // Only what the agent may read reaches its copy.
        for (const file of Object.keys(files)) if (!this.mayRead(file)) delete files[file];
        return {files, removed: removed.filter(file => this.mayRead(file))};
      }
    }, `agent-${this.team.me.agent}`, this.rights.terminal);
    const result = await this.shell.run(command, args, cwd === "." ? "" : this.path(cwd), timeoutSeconds, signal);
    return {tool: "terminal", ok: result.exitCode === 0 && !result.timedOut, output: JSON.stringify(result),
      metadata: {operation: "run", filePath: [command, ...args].join(" ").slice(0, 200), exitCode: result.exitCode}};
  }
  /** At the end of the agent's task: a finished agent submits what it left pending, any other reverts it. */
  async finish(finished: boolean): Promise<string[]> {
    await this.shell?.dispose();
    if (!this.team) return [];
    const left = [...this.pending.values()].map(change => change.target);
    if (finished) await this.submit(); else this.revert();
    this.team.checkouts.release(this.team.me.agent);
    return finished ? [] : left;
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
  const changes = rights.write.length > 0 || rights.delete.length > 0;
  return [...rights.read.length ? ["file.list", "file.search", "file.read"] : [], ...rights.write.length ? ["file.write", "file.replace", "file.append", "file.mkdir"] : [],
    ...rights.delete.length ? ["file.delete"] : [], ...changes ? ["file.checkout", "file.submit", "file.revert"] : [], ...rights.terminal?.length ? ["terminal.run"] : []];
}
export function agentToolText(rights: FilePermissions): string {
  return [
    "Tools (arguments are JSON; paths are relative to the project, such as src/index.ts):",
    rights.read.length ? 'file.list {path:"."} lists a folder. file.search {path:".",query:"literal text",include?:["*.ts"]} finds lines (an empty query lists files). file.read {path,startLine?:1,endLine?} reads up to 200 lines and returns the file\'s version.' : "",
    rights.write.length ? 'file.write {path,content,expectedVersion} writes a whole file: for a NEW file expectedVersion is "missing", for an existing one the version file.read returned. file.replace {path,oldText,newText,expectedVersion} changes one unique range. file.append {path,content,expectedVersion} adds to the end.' : "",
    rights.delete.length ? "file.delete {path,expectedVersion} deletes a file." : "",
    rights.write.length || rights.delete.length ? 'file.checkout {paths:["a.md","src/b.ts"],waitSeconds?:0} (wait up to 600 s for files another agent holds) takes files for your work, like a checkout in Perforce: the other agents read their last submitted version and change nothing of them until you file.submit {paths?} (your changes become visible) or file.revert {paths?} (they are dropped). Check out together every file your change depends on, including ones you only read. When you finish, what you left checked out is submitted.' : "",
    rights.write.length ? "Other agents work at the same time: when a write reports a version conflict, read the file again and redo your change; when a file is checked out by or belongs to another agent, work on other files." : "",
    rights.own?.length ? `Files you create or change under ${rights.own.join(", ")} are yours: no other agent may change them.` : "",
    rights.terminal?.length ? `terminal.run {command:"${rights.terminal[0]}",args:["..."],cwd?:".",timeoutSeconds?:60} runs ${rights.terminal.join(", ")} in a sandbox: a copy of the files you may read with your current changes, no network, at most 120 s. What it writes stays in the copy; change files with the file tools. Run the tests or a build before you answer, and fix what fails.` : ""
  ].filter(Boolean).join("\n");
}
