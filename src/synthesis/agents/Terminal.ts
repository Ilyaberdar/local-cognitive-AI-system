import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxProvider } from "../checks/types";
import { runCommand } from "../../utils/runCommand";

/** What an agent's terminal may run: build and test tools, read-only git, search and listing. */
export const TERMINAL_COMMANDS = ["node", "npm", "npx", "python3", "git", "rg", "ls", "cat"] as const;
export type TerminalCommand = typeof TERMINAL_COMMANDS[number];
/** git only reads: history, differences, blame, search. */
const GIT_READS = new Set(["log", "show", "diff", "blame", "status", "grep", "ls-files", "rev-parse", "branch", "shortlog", "describe"]);
export const MAX_COMMAND_SECONDS = 120;
const MAX_OUTPUT_CHARS = 24_000;
/** The most a copy of the project may hold where the disk cannot clone files (it copies them). */
const MAX_COPY_BYTES = 512 * 1024 * 1024, MAX_COPY_FILES = 20_000;

/** One agent's view of the files: what it may read (project and candidate, its own pending changes
 * first), and the candidate's files as it sees them now, for the copy its commands run in. */
export interface TerminalView {
  root: string;
  readable(limit: number): Promise<string[]>;
  /** A file as the agent sees it: null when it does not exist (deleted in the candidate). */
  content(file: string): Promise<string | null>;
  /** Files of the candidate (with the agent's pending changes) and those it deleted, project-relative. */
  candidate(): { files: Record<string, string>; removed: string[] };
}
export interface TerminalHost {
  sandbox: SandboxProvider;
  /** Where the run keeps its agents' copies. */
  workRoot: string;
  /** Whether the copy may see the project's git history: not when the contract has hidden tests, which history could hold. */
  git: boolean;
}

const searchPath = () => [...new Set([...(process.env.PATH ?? "").split(path.delimiter).filter(dir => path.isAbsolute(dir)), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])];
const executableAt = async (file: string) => { try { await fs.access(file, constants.X_OK); return (await fs.stat(file)).isFile(); } catch { return false; } };
const found = new Map<string, Promise<string | undefined>>();
/** A command's program on this computer, found outside the sandbox. The desktop app's own binary is
 * Electron, so node is looked for where people install it, nvm included. */
function program(command: TerminalCommand): Promise<string | undefined> {
  let answer = found.get(command);
  if (!answer) {
    answer = (async () => {
      if (command === "node" && !process.versions.electron) return process.execPath;
      const nvm = path.join(os.homedir(), ".nvm", "versions", "node");
      const newest = (await fs.readdir(nvm).catch(() => [] as string[])).filter(name => /^v\d+/.test(name)).sort().pop();
      const dirs = [...searchPath(), ...(newest && ["node", "npm", "npx"].includes(command) ? [path.join(nvm, newest, "bin")] : [])];
      for (const dir of dirs) {
        const candidate = path.join(dir, command);
        // macOS's /usr/bin/python3 is a shim that fails in a sandbox; the real one is xcrun's.
        if (candidate === "/usr/bin/python3" && process.platform === "darwin") continue;
        if (await executableAt(candidate)) return candidate;
      }
      return undefined;
    })();
    found.set(command, answer);
    void answer.then(value => { if (!value) found.delete(command); });
  }
  return answer;
}
const clip = (text: string) => text.length <= MAX_OUTPUT_CHARS ? text
  : `${text.slice(0, Math.floor(MAX_OUTPUT_CHARS * 2 / 3))}\n[… ${text.length - MAX_OUTPUT_CHARS} characters left out …]\n${text.slice(-Math.floor(MAX_OUTPUT_CHARS / 3))}`;

/** An agent's terminal: commands run in a sandbox, in a copy of the files the agent may read with its
 * current changes, without network, writing only in that copy (never the candidate or the project). */
export class AgentTerminal {
  private copy?: Promise<string>;
  constructor(private readonly host: TerminalHost, private readonly view: TerminalView, private readonly name: string, private readonly allowed: string[]) {}

  async run(command: string, args: string[], cwd: string, timeoutSeconds: number, signal?: AbortSignal): Promise<{ exitCode: number; timedOut: boolean; stdout: string; stderr: string }> {
    if (!(TERMINAL_COMMANDS as readonly string[]).includes(command) || !this.allowed.includes(command)) {
      throw new Error(`${command} is not one of this agent's commands: ${this.allowed.join(", ")}.`);
    }
    if (command === "git" && !GIT_READS.has(args[0] ?? "")) throw new Error(`git runs only to read: git ${[...GIT_READS].join(" | ")} ...`);
    if (command === "git" && !this.host.git) throw new Error("git history is not in this copy: the contract has hidden tests, which it could hold.");
    if (command === "npm" && !["test", "run", "ls", "list", "pkg"].includes(args[0] ?? "")) throw new Error("npm runs only npm test, npm run <script> and npm ls here.");
    if (args.length > 64 || args.some(arg => arg.length > 4000 || arg.includes("\0"))) throw new Error("A command takes at most 64 arguments of 4,000 characters.");
    const executable = await program(command as TerminalCommand);
    if (!executable) throw new Error(`${command} is not installed on this computer.`);
    const reason = await this.host.sandbox.unavailable();
    if (reason) throw new Error(`The terminal needs a sandbox: ${reason}`);
    const work = await this.prepare();
    await this.sync(work);
    const folder = path.resolve(work, cwd || ".");
    if (folder !== work && !folder.startsWith(`${work}${path.sep}`)) throw new Error("cwd is a folder of the project, such as src.");
    const real = await fs.realpath(executable).catch(() => executable);
    // The tool's folders, read-only: its own, its real place (Homebrew, nvm) and that one's parent
    // (npm's own modules); the project's node_modules and git history, when the copy links them.
    const readable = [path.dirname(executable), path.dirname(real), path.dirname(path.dirname(real)), path.dirname(path.dirname(executable)),
      ...await this.links(work)];
    const wrapped = this.host.sandbox.wrap(executable, args, work, readable);
    const result = await runCommand(wrapped.executable, wrapped.args, folder, Math.min(MAX_COMMAND_SECONDS, Math.max(1, timeoutSeconds)) * 1000, signal, undefined,
      { env: { ...wrapped.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", npm_config_update_notifier: "false" } });
    const hide = (text: string) => text.split(work).join(".").split(this.view.root).join("<project>");
    return { exitCode: result.exitCode, timedOut: result.timedOut, stdout: clip(hide(result.stdout)), stderr: clip(hide(result.stderr)) };
  }

  /** Removes the agent's copy (the run's candidate keeps what the agent wrote with its file tools). */
  async dispose(): Promise<void> {
    const copy = await this.copy?.catch(() => undefined);
    if (copy) await fs.rm(copy, { recursive: true, force: true }).catch(() => undefined);
  }

  /** The copy, made once: the files the agent may read as the run sees them (one version for all its
   * agents), text files only, within bounds; the project's node_modules and .git linked read-only. */
  private prepare(): Promise<string> {
    this.copy ??= (async () => {
      const work = path.join(this.host.workRoot, this.name);
      await fs.rm(work, { recursive: true, force: true });
      await fs.mkdir(work, { recursive: true });
      const files = await this.view.readable(MAX_COPY_FILES);
      const candidate = this.view.candidate();
      let copied = 0;
      for (const file of files) {
        const target = path.join(work, ...file.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (Object.hasOwn(candidate.files, file)) { await fs.writeFile(target, candidate.files[file]!); continue; }
        const content = await this.view.content(file).catch(() => null);
        if (content === null || content.includes("\0")) continue;
        copied += Buffer.byteLength(content);
        if (copied > MAX_COPY_BYTES) throw new Error("The files this agent may read are too many for a terminal copy (512 MB): narrow its read rights.");
        await fs.writeFile(target, content);
      }
      for (const [name, wanted] of [["node_modules", true], [".git", this.host.git]] as const) {
        const source = path.join(this.view.root, name);
        if (wanted && await fs.lstat(source).then(stat => stat.isDirectory(), () => false)) await fs.symlink(await fs.realpath(source), path.join(work, name)).catch(() => undefined);
      }
      return work;
    })();
    return this.copy;
  }
  /** The candidate's files as the agent sees them now: its own and the others' submitted changes. */
  private async sync(work: string): Promise<void> {
    const { files, removed } = this.view.candidate();
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(work, ...file.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (await fs.readFile(target, "utf8").catch(() => null) !== content) await fs.writeFile(target, content);
    }
    for (const file of removed) await fs.rm(path.join(work, ...file.split("/")), { force: true });
  }
  private async links(work: string): Promise<string[]> {
    const linked: string[] = [];
    for (const name of ["node_modules", ".git"]) {
      const link = path.join(work, name);
      if (await fs.lstat(link).then(stat => stat.isSymbolicLink(), () => false)) linked.push(await fs.readlink(link));
    }
    return linked;
  }
}
