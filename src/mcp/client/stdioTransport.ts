import { execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { McpClientError } from "./errors";
import { launchEnvironment, loginShellPath, OutputTail, resolveCommand } from "./launch";

// cross-spawn runs `npx`/`uvx` shims (.cmd) through cmd.exe on Windows with correct quoting.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const spawn = require("cross-spawn") as typeof import("node:child_process").spawn;

const windows = process.platform === "win32";
const GRACE_MS = 2_000;
// Not unref'd: stopping a server is short and bounded, and must finish even when nothing else runs.
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface StdioLaunch { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }

/** A local MCP server process on stdio (as Codex runs them). Unlike the SDK's transport it finds
 * commands the user's terminal finds, says when a command or folder does not exist, keeps the
 * server's last stderr lines for Settings, and stops the server's whole process tree: `uvx` and
 * `npx` run the real server as a grandchild. */
export class LocalStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly output: OutputTail;
  private child?: ChildProcess;
  private readonly buffer = new ReadBuffer();
  /** Its streams closed (after it exited): the connection's end has been reported. */
  private ended?: Promise<void>;
  private exit?: { code: number | null; signal: NodeJS.Signals | null };
  private closing?: Promise<void>;

  constructor(private readonly launch: StdioLaunch, secrets: string[] = []) {
    this.output = new OutputTail(secrets);
  }

  get pid(): number | undefined { return this.child?.pid; }

  async start(): Promise<void> {
    if (this.child || this.exit) throw new Error("The MCP server process was already started.");
    const env = launchEnvironment(this.launch.env, await loginShellPath());
    if (this.launch.cwd && !isFolder(this.launch.cwd)) {
      throw new McpClientError("invalid_configuration", `The working directory ${this.launch.cwd} does not exist.`);
    }
    const command = resolveCommand(this.launch.command, env, this.launch.cwd);
    if (!command) {
      throw new McpClientError("command_not_found", `"${this.launch.command}" was not found. Searched PATH: ${env.PATH}. ` +
        "Enter its full path, or set PATH in the server's environment.");
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, this.launch.args ?? [], {
        cwd: this.launch.cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
        // Its own process group on macOS and Linux: stopping it reaches every process it started.
        detached: !windows
      });
      this.child = child;
      let started = false;
      child.once("exit", (code, signal) => { this.exit = { code, signal }; });
      child.once("error", error => {
        if (!started) reject(new McpClientError("server_exited", `${this.launch.command} could not be started: ${(error as NodeJS.ErrnoException).code ?? error.message}.`));
        else this.onerror?.(error);
      });
      child.once("spawn", () => { started = true; resolve(); });
      this.ended = new Promise(done => child.once("close", () => { this.child = undefined; this.onclose?.(); done(); }));
      child.stdout!.on("data", (chunk: Buffer) => {
        this.buffer.append(chunk);
        for (;;) {
          let message: JSONRPCMessage | null;
          try { message = this.buffer.readMessage(); } catch (error) { this.onerror?.(error as Error); continue; }
          if (!message) break;
          this.onmessage?.(message);
        }
      });
      child.stdout!.on("error", error => this.onerror?.(error));
      child.stdin!.on("error", error => this.onerror?.(error));
      child.stderr!.on("data", (chunk: Buffer) => this.output.append(chunk));
      child.stderr!.on("error", () => undefined);
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin || stdin.destroyed) return reject(new McpClientError("disconnected"));
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once("drain", () => resolve());
    });
  }

  /** How the process ended, with its last output, for the host's Settings. */
  failure(): McpClientError {
    const how = !this.exit ? "stopped responding" : this.exit.signal ? `was stopped (${this.exit.signal})` : `exited with code ${this.exit.code}`;
    const output = this.output.read();
    return new McpClientError("server_exited", `The MCP server process ${how}.${output ? `\n${output}` : ""}`);
  }

  close(): Promise<void> { return this.closing ??= this.stop(); }

  private async stop(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    const pid = child.pid;
    // First as the server expects: end of input. Most servers exit on it.
    try { child.stdin?.end(); } catch { /* Already closed. */ }
    await Promise.race([this.ended, wait(GRACE_MS)]);
    if (windows) {
      // Still running, or a process it started still holds its output open.
      if (this.child) await new Promise<void>(done => execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, () => done()));
    } else {
      // The group outlives its leader while a grandchild runs: it is stopped either way.
      signalGroup(pid, "SIGTERM");
      for (let waited = 0; waited < GRACE_MS && groupAlive(pid); waited += 100) await wait(100);
      if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
    }
    await Promise.race([this.ended, wait(GRACE_MS)]);
    this.buffer.clear();
  }
}

const isFolder = (folder: string) => { try { return fs.statSync(folder).isDirectory(); } catch { return false; } };
const signalGroup = (pid: number, signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch { /* No such group. */ } };
const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
