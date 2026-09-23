import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { ToolExecutionResult } from "../types";
import { AgentAction } from "./AgentTool";
import { WorkspaceSnapshot } from "../workspace/types";
import { canonicalPath, isWorkspacePath } from "./AccessPolicy";
import { withFileLock } from "../utils/fileStore";

const hash = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");
const maxReadBytes = 5 * 1024 * 1024;
const maxResultBytes = 48_000;
export class WorkspaceFileService {
  async prepare(action: AgentAction, workspace: WorkspaceSnapshot): Promise<AgentAction> {
    const key = action.tool === "command.run" ? "cwd" : "path";
    const raw = String(action.arguments[key] || ".");
    const target = path.resolve(workspace.rootPath, raw);
    // Removing a link removes the link itself, not the object it points to.
    const canonical = action.tool === "file.delete"
      ? path.join(await canonicalPath(path.dirname(target)), path.basename(target))
      : await canonicalPath(target);
    return { ...action, arguments: { ...action.arguments, [key]: canonical } };
  }

  async execute(action: AgentAction, workspace: WorkspaceSnapshot, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const target = String(action.arguments.path);
    return withFileLock(`workspace-file:${target}`, async () => {
      signal?.throwIfAborted();
      const rechecked = await this.prepare(action, workspace);
      if (rechecked.arguments.path !== target) throw new Error("The file path changed. Read it again before continuing.");
      const args = action.arguments;
      if (action.tool === "file.list") {
        const entries = (await fs.readdir(target, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name));
        const limit = Number(args.limit);
        const listed = entries.slice(0, limit).map(entry => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file" }));
        return this.result("list", target, JSON.stringify({ entries: listed, truncated: entries.length > limit, total: entries.length }), { entries: listed });
      }
      if (action.tool === "file.search") return this.search(target, String(args.query), Number(args.maxResults??args.limit), Number(args.maxFiles), signal,args);
      if (action.tool === "file.read") {
        const content = await this.read(target);
        const lines = content.split("\n");
        const start = Number(args.startLine);
        const end = Math.min(Number(args.endLine ?? start + 199), lines.length);
        if (end < start && lines.length >= start) throw new Error("endLine must be at least startLine.");
        const selected: string[] = [];
        let size = 0;
        for (let i = start - 1; i < end; i++) {
          const row = `${i + 1}: ${lines[i]}`;
          if (size + Buffer.byteLength(row) > maxResultBytes) break;
          selected.push(row); size += Buffer.byteLength(row) + 1;
        }
        if (!selected.length && start <= lines.length && lines[start - 1].length) {
          return this.result("read", target, JSON.stringify({ version: hash(content), totalLines: lines.length,
            error: "A line exceeds the output limit. Use a command with explicit approval to inspect this file." }), { version: hash(content), truncated: true });
        }
        const data = { version: hash(content), startLine: start, endLine: start + selected.length - 1,
          totalLines: lines.length, truncated: start + selected.length - 1 < lines.length, content: selected.join("\n") };
        return this.result("read", target, JSON.stringify(data), { version: data.version });
      }
      if (action.tool === "file.mkdir") {
        await fs.mkdir(target, { recursive: true });
        return this.result("mkdir", target, `Created directory ${target}`);
      }
      const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
      let before = "";
      let previousVersion = "missing";
      if (stat?.isDirectory()) previousVersion = "directory";
      else if (stat?.isSymbolicLink()) previousVersion = hash(await fs.readlink(target));
      else if (stat) { before = await this.read(target); previousVersion = hash(before); }
      if (args.expectedVersion !== previousVersion) throw new Error(`File version conflict at ${target}. Read the current file before proposing a new change.`);
      signal?.throwIfAborted();
      if (action.tool === "file.delete") {
        if (stat?.isDirectory()) await fs.rmdir(target); else await fs.unlink(target);
        return this.result("delete", target, `Deleted ${target}`);
      }
      if (stat && !stat.isFile()) throw new Error("Only regular text files can be edited.");
      let after = String(args.content ?? "");
      if (action.tool === "file.append") after = before + after;
      if (action.tool === "file.replace") {
        const original = String(args.oldText);
        if (!before.includes(original) || before.indexOf(original) !== before.lastIndexOf(original)) throw new Error("oldText must match exactly one range. Read the file and provide a unique range.");
        after = before.replace(original, () => String(args.newText));
      }
      if (Buffer.byteLength(after) > maxReadBytes) throw new Error("Result exceeds the 5 MB text file limit.");
      await fs.mkdir(path.dirname(target), { recursive: true });
      signal?.throwIfAborted();
      // Single writer per canonical file in the application; version checked inside the lock.
      await fs.writeFile(target, after, "utf8");
      return this.result(action.tool.slice(5), target, `Saved ${target}`, {
        beforeExists: Boolean(stat), afterHash: hash(after), version: hash(after), path:target,bytes:Buffer.byteLength(after),beforeBytes:Buffer.byteLength(before),afterBytes:Buffer.byteLength(after),
        diff: this.diff(before, after)
      });
    });
  }

  private async read(target: string): Promise<string> {
    const handle = await fs.open(target, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxReadBytes) throw new Error("Read supports text files up to 5 MB.");
      const buffer = Buffer.alloc(maxReadBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > maxReadBytes || buffer.subarray(0,size).includes(0)) throw new Error("File is binary or exceeds the 5 MB limit.");
      return buffer.subarray(0,size).toString("utf8");
    } finally { await handle.close(); }
  }
  private async search(root: string, query: string, limit: number, maxFiles: number, signal?: AbortSignal,args:Record<string,unknown>={}): Promise<ToolExecutionResult> {
    const queue = [root];
    const matches: Array<{path: string; line?: number; text?: string}> = [];
    let scannedFiles = 0;
    const excluded = new Set([".git", "node_modules", "dist", "release"]);
    const glob=(pattern:string)=>new RegExp("^"+pattern.split("**/").map(part=>part.split("**").map(piece=>piece.split("*").map(literal=>literal.replace(/[.+?^${}()|[\]\\]/g,"\\$&")).join("[^/]*")).join(".*")).join("(?:.*/)?")+"$");
    const include=(args.include as string[]|undefined)?.map(glob);
    const exclude=(args.exclude as string[]|undefined)?.map(glob)??[];
    while (queue.length && scannedFiles < maxFiles && matches.length < limit) {
      signal?.throwIfAborted();
      const dir = queue.shift()!;
      if (!await isWorkspacePath(dir, [root])) continue;
      for (const item of (await fs.readdir(dir, { withFileTypes:true })).sort((a,b)=>a.name.localeCompare(b.name))) {
        if (excluded.has(item.name) || item.isSymbolicLink()) continue;
        const file = path.join(dir,item.name);
        const relative = path.relative(root,file).split(path.sep).join("/");
        if(exclude.some(pattern=>pattern.test(relative)||pattern.test(relative+"/"))) continue;
        if (item.isDirectory()) { queue.push(file); continue; }
        if (!item.isFile() || !await isWorkspacePath(file,[root])) continue;
        if (++scannedFiles > maxFiles) break;
        if(include?.length&&!include.some(pattern=>pattern.test(relative)))continue;
        if (!query) matches.push({path:relative});
        else {
          const stat = await fs.stat(file);
          if (stat.size > Number(args.maxFileBytes??524288)) continue;
          const content = await this.read(file).catch(()=>"");
          for (const [i,line] of content.split("\n").entries()) {
            if (line.toLocaleLowerCase().includes(query.toLocaleLowerCase())) matches.push({path:relative,line:i+1,text:line.slice(0,500)});
            if (matches.length >= limit) break;
          }
        }
        if (matches.length >= limit) break;
      }
    }
    return this.result("search",root,JSON.stringify({root,query,scannedFiles,matches,truncated:queue.length>0||matches.length>=limit||scannedFiles>=maxFiles,skipped:"Symbolic links, .git, node_modules, dist, release and files over 512 KB"}),{root,query,scannedFiles,results:matches});
  }
  private result(operation:string,filePath:string,output:string,extra:Record<string,unknown>={}):ToolExecutionResult {
    return {tool:"file",ok:true,output,metadata:{operation,filePath,...extra}};
  }
  private diff(before:string,after:string) {
    const left=before.split("\n"),right=after.split("\n");
    let common=0;
    while(common<left.length&&common<right.length&&left[common]===right[common]) common++;
    let suffix=0;
    while(suffix<left.length-common&&suffix<right.length-common&&left[left.length-1-suffix]===right[right.length-1-suffix]) suffix++;
    const removed=left.slice(common,left.length-suffix),added=right.slice(common,right.length-suffix);
    return {removed:removed.length,added:added.length,changeStartLine:common+1,truncated:removed.length+added.length>80,
      preview:[...removed.slice(0,40).map((text,i)=>({type:"remove",line:common+i+1,text:text.slice(0,500)})),...added.slice(0,40).map((text,i)=>({type:"add",line:common+i+1,text:text.slice(0,500)}))]};
  }
}
