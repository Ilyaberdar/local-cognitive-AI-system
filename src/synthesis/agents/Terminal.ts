import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxProvider } from "../checks/types";
import type { EgressProxy } from "./AgentHttpProxy";
import { nodeTestIsolationFlag } from "../checks/sandbox";
import { runCommand } from "../../utils/runCommand";

/** What an agent's terminal may run: build and test tools, read-only git, search and listing. */
export const TERMINAL_COMMANDS = ["node", "npm", "npx", "python3", "git", "rg", "ls", "cat"] as const;
export type TerminalCommand = typeof TERMINAL_COMMANDS[number];
/** Windows runs no shell inside the sandbox in v1: an agent there uses the app's own Node (node, npm,
 * npx), and git, ls and cat are refused. */
const WINDOWS_TERMINAL_UNSUPPORTED = new Set(["git", "ls", "cat", "python3", "rg"]);
/** The Node runtime the app ships for the Windows sandbox (never the user's). */
const shippedSandboxNode = (): string | undefined => process.env.LC_SANDBOX_NODE && existsSync(process.env.LC_SANDBOX_NODE) ? process.env.LC_SANDBOX_NODE : undefined;
/** What to run before the user's arguments on Windows: node runs its own, npm and npx run the shipped
 * Node's cli scripts (their .cmd shims are batch files the sandbox refuses); git, ls, cat, python3 and rg
 * are refused. The caller runs the shipped Node as the executable. */
export function windowsTerminalPrefix(command: TerminalCommand, nodeDir: string): string[] {
  if (WINDOWS_TERMINAL_UNSUPPORTED.has(command)) throw new Error(`${command} is not available in the Windows terminal yet; an agent there uses node, npm and npx.`);
  if (command === "npm" || command === "npx") return [path.win32.join(nodeDir, "node_modules", "npm", "bin", command === "npm" ? "npm-cli.js" : "npx-cli.js")];
  return [];
}
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
  /** Starts a loopback egress proxy for an agent whose http right names web targets, so its terminal may
   * reach only those (the same allowlist, owner consent and run budget as http.request). Set only when the
   * project allows web access; a terminal has no network without it, as before. */
  egress?(allow: readonly string[]): Promise<EgressProxy>;
}

/** The proxy env a sandboxed tool reads to send its web requests through the egress proxy and nowhere
 * else (curl, git and python honour different casings; nothing is exempted). */
const proxyEnv = (url: string): Record<string, string> => {
  return { HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, http_proxy: url, https_proxy: url, all_proxy: url, NO_PROXY: "", no_proxy: "" };
};

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
      // A server's own Node brings npm and npx beside it.
      if ((command === "npm" || command === "npx") && !process.versions.electron) {
        const beside = path.join(path.dirname(process.execPath), command);
        if (await executableAt(beside)) return beside;
      }
      const nvm = path.join(os.homedir(), ".nvm", "versions", "node");
      const newest = (await fs.readdir(nvm).catch(() => [] as string[])).filter(name => /^v\d+/.test(name)).sort().pop();
      const dirs = [...searchPath(), ...(newest && ["node", "npm", "npx"].includes(command) ? [path.join(nvm, newest, "bin")] : [])];
      for (const dir of dirs) {
        const candidate = path.join(dir, command);
        // macOS's /usr/bin/python3 is a shim that fails in a sandbox; the real one is xcrun's. A program
        // in the user's own folders (other than nvm's) would open them to reading: not taken.
        if (candidate === "/usr/bin/python3" && process.platform === "darwin") continue;
        if (underHome(candidate) && !candidate.startsWith(`${nvmDir()}${path.sep}`)) continue;
        if (await executableAt(candidate)) return candidate;
      }
      return undefined;
    })();
    found.set(command, answer);
    void answer.then(value => { if (!value) found.delete(command); });
  }
  return answer;
}
/** Runs "$@" with a bound on every process's CPU time (one that leaves the group still ends), says
 * when it is done and with what status, and waits: the app then kills the whole group with SIGKILL
 * while this shell, its leader, is still alive. */
const ENDS_ITS_GROUP = 'ulimit -t "$1" 2>/dev/null; token="$2"; shift 2; "$@"; status=$?; printf "\\n%s:%s\\n" "$token" "$status"; read -r _';
/** CPU seconds any process of a command may use (its time limit is wall clock, this one CPU). */
const CPU_SECONDS = MAX_COMMAND_SECONDS * 2;
/** Empties a folder sandboxed code has used, inside the sandbox (links it left lead nowhere but the
 * folder), then removes the empty folder; never a recursive delete by the app itself. */
export async function removeInSandbox(sandbox: SandboxProvider, folder: string): Promise<void> {
  try {
    // Where the sandbox has no shell (Windows), its own built-in empties the folder (never following a
    // reparse point a command left); elsewhere a /bin/sh in the sandbox does.
    const wrapped = sandbox.empty
      ? sandbox.empty(folder)
      : sandbox.wrap("/bin/sh", ["-c", 'trap "" TERM; kill -TERM 0 2>/dev/null; chmod -R u+rwx . 2>/dev/null; rm -rf -- ./* ./.[!.]* ./..?* 2>/dev/null; exit 0'], folder, []);
    await runCommand(wrapped.executable, wrapped.args, folder, 30_000, undefined, undefined, { env: wrapped.env });
  } catch { /* No sandbox to empty it with: the folder stays, under the app's own data. */ }
  await fs.rmdir(folder).catch(() => undefined);
}
/** A toolchain's own prefix (Homebrew's, /usr/local, an nvm version), never a folder of the user's. */
const underHome = (dir: string) => dir === os.homedir() || dir.startsWith(`${os.homedir()}${path.sep}`);
const nvmDir = () => path.join(os.homedir(), ".nvm", "versions", "node");
export const toolchainPrefix = (dir: string): boolean =>
  underHome(dir) ? dir.startsWith(`${nvmDir()}${path.sep}`) : dir.split(path.sep).filter(Boolean).length >= 2;
const clip = (text: string) => text.length <= MAX_OUTPUT_CHARS ? text
  : `${text.slice(0, Math.floor(MAX_OUTPUT_CHARS * 2 / 3))}\n[… ${text.length - MAX_OUTPUT_CHARS} characters left out …]\n${text.slice(-Math.floor(MAX_OUTPUT_CHARS / 3))}`;

/** An agent's terminal: commands run in a sandbox, in a copy of the files the agent may read with its
 * current changes, without network, writing only in that copy (never the candidate or the project). */
export class AgentTerminal {
  private copy?: Promise<string>;
  /** The project folders the copy links (its node_modules, its .git), as resolved when the copy was made:
   * never read back from the copy, where a command could have replaced them. */
  private linked: string[] = [];
  /** How many copies the agent has had: a broken one is replaced by a new folder, never reused. */
  private generation = 0;
  /** The agent's egress proxy, started once when it first runs a command and the project allows the web. */
  private proxy?: Promise<EgressProxy>;
  constructor(private readonly host: TerminalHost, private readonly view: TerminalView, private readonly name: string, private readonly allowed: string[], private readonly httpTargets: readonly string[] = []) {}

  /** The egress proxy this agent's commands go out through, or undefined when it has no web
   * targets or the platform's sandbox cannot route to one (the terminal then runs with no network). */
  private egress(): Promise<EgressProxy> | undefined {
    if (!this.host.egress || !this.host.sandbox.egressSupported || !this.httpTargets.length) return undefined;
    // A failed start is tried again by the next command, not kept for the agent's whole run.
    return (this.proxy ??= this.host.egress(this.httpTargets).catch(error => { this.proxy = undefined; throw error; }));
  }

  async run(command: string, args: string[], cwd: string, timeoutSeconds: number, signal?: AbortSignal): Promise<{ exitCode: number; timedOut: boolean; stdout: string; stderr: string }> {
    if (!(TERMINAL_COMMANDS as readonly string[]).includes(command) || !this.allowed.includes(command)) {
      throw new Error(`${command} is not one of this agent's commands: ${this.allowed.join(", ")}.`);
    }
    const windows = process.platform === "win32";
    if (windows && WINDOWS_TERMINAL_UNSUPPORTED.has(command)) throw new Error(`${command} is not available in the Windows terminal yet; an agent there uses node, npm and npx.`);
    if (command === "git" && !GIT_READS.has(args[0] ?? "")) throw new Error(`git runs only to read: git ${[...GIT_READS].join(" | ")} ...`);
    if (command === "git" && !this.host.git) throw new Error("git history is not in this copy: the contract has hidden tests, which it could hold.");
    if (command === "npm" && !["test", "run", "ls", "list", "pkg"].includes(args[0] ?? "")) throw new Error("npm runs only npm test, npm run <script> and npm ls here.");
    if (args.length > 64 || args.some(arg => arg.length > 4000 || arg.includes("\0"))) throw new Error("A command takes at most 64 arguments of 4,000 characters.");
    const executable = windows ? shippedSandboxNode() : await program(command as TerminalCommand);
    if (!executable) throw new Error(windows ? "The sandbox's bundled Node runtime was not found in this install." : `${command} is not installed on this computer.`);
    const reason = await this.host.sandbox.unavailable();
    if (reason) throw new Error(`The terminal needs a sandbox: ${reason}`);
    let work = await this.prepare();
    try { await this.sync(work); }
    catch {
      // A command broke its own copy (a folder made a link out of it, which the sandbox refused):
      // the copy is the agent's scratch, so it starts again, in a new folder.
      await this.dispose();
      this.copy = undefined; this.linked = []; this.synced.clear(); this.generation++;
      work = await this.prepare();
      await this.sync(work);
    }
    const folder = path.resolve(work, cwd || ".");
    if (folder !== work && !folder.startsWith(`${work}${path.sep}`)) throw new Error("cwd is a folder of the project, such as src.");
    const hide = (text: string) => text.split(work).join(".").split(this.view.root).join("<project>");
    if (windows) {
      // node runs the app's own runtime; npm and npx run it on their cli scripts (their .cmd shims are
      // batch files the sandbox refuses). The Job object ends the whole tree when the command ends or
      // when the helper is killed (a timeout), so there is no shell wrapper and no done-token.
      const nodeDir = path.dirname(executable);
      const inject = command === "node" && args.includes("--test") ? [await nodeTestIsolationFlag(executable)] : [];
      const full = [...inject, ...windowsTerminalPrefix(command as TerminalCommand, nodeDir), ...args];
      const wrapped = this.host.sandbox.wrap(executable, full, work, [nodeDir]);
      // The per-process CPU bound that ulimit -t gives elsewhere: the helper's Job object enforces it.
      if (wrapped.args[0] === "exec") wrapped.args.splice(1, 0, "--cpu", String(CPU_SECONDS));
      const result = await runCommand(wrapped.executable, wrapped.args, folder, Math.min(MAX_COMMAND_SECONDS, Math.max(1, timeoutSeconds)) * 1000, signal, undefined,
        { env: { ...wrapped.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", npm_config_update_notifier: "false" } });
      // The likeliest reason a command hangs here: a child process started over stdio pipes, which libuv
      // cannot connect inside the sandbox (node --test starts one per file unless told otherwise, and that
      // flag is not allowed in NODE_OPTIONS, so a project's own test script must pass it).
      const note = result.timedOut
        ? `\n[Timed out. In the Windows sandbox a process that starts child processes over stdio pipes can hang: node --test does unless its files run in one process, so a test script should run "node --test ${await nodeTestIsolationFlag(executable)}".]`
        : "";
      return { exitCode: result.exitCode, timedOut: result.timedOut, stdout: clip(hide(result.stdout)), stderr: clip(hide(result.stderr) + note) };
    }
    const real = await fs.realpath(executable).catch(() => executable);
    // The tool's folders, read-only: its own and its real place (Homebrew, nvm); their parents only
    // where they are a toolchain's (npm's own modules), never a folder of the user's; the project's
    // node_modules and git history, when the copy links them.
    // npm and npx are started by node (#!/usr/bin/env node), and so are the scripts they run (npm test,
    // a package's own bin): node's folder goes first on their PATH, readable like the tool's own.
    const node = command === "npm" || command === "npx" ? await program("node") : undefined;
    const nodeDirs = node ? [...new Set([path.dirname(node), path.dirname(await fs.realpath(node).catch(() => node))])] : [];
    // The npm beside this app's own Node (a server's) reads its own modules, wherever that Node is: that
    // folder only (lib/node_modules/npm), never the rest of the Node's prefix.
    const npmModules = path.join(path.dirname(path.dirname(process.execPath)), "lib", "node_modules", "npm");
    const ownRuntime = !process.versions.electron && path.dirname(executable) === path.dirname(process.execPath) && await fs.stat(npmModules).then(stat => stat.isDirectory(), () => false) ? [npmModules] : [];
    const readable = [path.dirname(executable), path.dirname(real), ...[path.dirname(path.dirname(real)), path.dirname(path.dirname(executable))].filter(toolchainPrefix), ...nodeDirs, ...ownRuntime, ...this.linked];
    // The command runs under a shell that, once it ends, ends whatever it left running in its process
    // group, from inside the sandbox while the group is still its own (never a group the app guesses).
    const token = `LC_TERMINAL_DONE_${randomBytes(9).toString("hex")}`;
    const done = new RegExp(`\\n${token}:(\\d+)\\n$`);
    // When the project allows the web, the command goes out only through this agent's egress proxy.
    const proxy = await this.egress();
    const wrapped = this.host.sandbox.wrap("/bin/sh", ["-c", ENDS_ITS_GROUP, "sh", String(CPU_SECONDS), token, executable, ...args], work, readable, proxy?.endpoint);
    const result = await runCommand(wrapped.executable, wrapped.args, folder, Math.min(MAX_COMMAND_SECONDS, Math.max(1, timeoutSeconds)) * 1000, signal, undefined,
      // npm's scripts start under an absolute /bin/sh: looking sh up through the node_modules/.bin of every
      // parent folder (which the macOS sandbox refuses with EPERM, ending the search) would fail them.
      { env: { ...wrapped.env, ...(proxy && wrapped.proxyUrl ? proxyEnv(wrapped.proxyUrl) : {}), ...(nodeDirs.length ? { PATH: [...nodeDirs, path.dirname(executable), wrapped.env.PATH].filter(Boolean).join(path.delimiter), npm_config_script_shell: "/bin/sh" } : {}), CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", npm_config_update_notifier: "false" }, endWhen: stdout => done.test(stdout) });
    const status = done.exec(result.stdout);
    return { exitCode: status ? Number(status[1]) : result.exitCode, timedOut: result.timedOut, stdout: clip(hide(result.stdout.replace(done, "\n"))), stderr: clip(hide(result.stderr)) };
  }

  /** Removes the agent's copy (the run's candidate keeps what the agent wrote with its file tools).
   * Its contents are removed inside the sandbox, where a link a command left can lead a delete nowhere
   * but the copy; the app then removes only the empty folder, never recursively. */
  async dispose(): Promise<void> {
    const copy = await this.copy?.catch(() => undefined);
    if (copy) await removeInSandbox(this.host.sandbox, copy);
    const proxy = await this.proxy?.catch(() => undefined);
    if (proxy) await proxy.close().catch(() => undefined);
  }

  /** The copy, made once: the files the agent may read as the run sees them (one version for all its
   * agents), text files only, within bounds; the project's node_modules and .git linked read-only. */
  private prepare(): Promise<string> {
    this.copy ??= (async () => {
      const work = path.join(this.host.workRoot, this.generation ? `${this.name}-${this.generation}` : this.name);
      await fs.mkdir(this.host.workRoot, { recursive: true });
      // A new folder: one that exists already is never emptied by the app (a command may have left links in it).
      await fs.mkdir(work);
      const files = await this.view.readable(MAX_COPY_FILES);
      const candidate = this.view.candidate();
      let copied = 0;
      for (const file of files) {
        const target = path.join(work, ...file.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        // The copy is new and no command has run in it yet: the app may still write it itself.
        if (Object.hasOwn(candidate.files, file)) { await fs.writeFile(target, candidate.files[file]!); this.synced.set(file, candidate.files[file]!); continue; }
        const content = await this.view.content(file).catch(() => null);
        if (content === null || content.includes("\0")) continue;
        copied += Buffer.byteLength(content);
        if (copied > MAX_COPY_BYTES) throw new Error("The files this agent may read are too many for a terminal copy (512 MB): narrow its read rights.");
        await fs.writeFile(target, content);
      }
      // Linked only when they are the project's own (a link elsewhere would open that folder to reading).
      // Windows makes no links in v1 (a symlink needs a privilege a normal account lacks): the copy has
      // neither the project's node_modules nor its git history there.
      if (process.platform !== "win32") {
        const root = await fs.realpath(this.view.root);
        for (const [name, wanted] of [["node_modules", true], [".git", this.host.git]] as const) {
          if (!wanted) continue;
          const source = await fs.realpath(path.join(this.view.root, name)).catch(() => undefined);
          if (!source || !source.startsWith(`${root}${path.sep}`) || !await fs.stat(source).then(stat => stat.isDirectory(), () => false)) continue;
          await fs.symlink(source, path.join(work, name));
          this.linked.push(source);
        }
      }
      return work;
    })();
    return this.copy;
  }
  /** The candidate's files as the agent sees them now: its own and the others' submitted changes.
   * Once a command has run, the copy is the sandbox's to change (a folder may now be a link out of it),
   * so the app never writes there itself: a writer inside the same sandbox does, which can write
   * nowhere but the copy whatever links it meets. */
  private synced = new Map<string, string | null>();
  private async sync(work: string): Promise<void> {
    const { files, removed } = this.view.candidate();
    const changes: Array<[string, string | null]> = [...Object.entries(files).filter(([file, content]) => this.synced.get(file) !== content),
      ...removed.filter(file => this.synced.get(file) !== null).map(file => [file, null] as [string, null])];
    for (const [file, content] of changes) {
      // Inside the sandbox, so a folder a command turned into a link out of the copy leads a write or a
      // delete nowhere but the copy. Where the sandbox has no shell (Windows), its built-ins do it.
      const wrapped = content === null
        ? (this.host.sandbox.remove ? this.host.sandbox.remove(work, file) : this.host.sandbox.wrap("/bin/sh", ["-c", 'rm -f -- "$1"', "sh", file], work, []))
        : (this.host.sandbox.write ? this.host.sandbox.write(work, file) : this.host.sandbox.wrap("/bin/sh", ["-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", file], work, []));
      const result = await runCommand(wrapped.executable, wrapped.args, work, 20_000, undefined, undefined, { env: wrapped.env, ...(content === null ? {} : { input: content }) });
      if (result.exitCode !== 0) throw new Error(`The terminal's copy could not take ${file}: ${result.stderr.trim().split("\n")[0] ?? "it refused"}.`);
      this.synced.set(file, content);
    }
  }
}
