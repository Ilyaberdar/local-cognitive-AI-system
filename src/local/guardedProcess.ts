import { spawn, type ChildProcess } from "child_process";
import os from "os";

/** How long a runtime asked to stop has before it is killed. */
export const STOP_GRACE_SEC = 2;

// POSIX: /bin/sh starts the runtime in the process group of its own new session and watches the
// app's end of its stdin. At end of file (the app asked it to stop, exited, crashed or was killed:
// the kernel closes the app's end however it ends) the group gets SIGTERM, then SIGKILL. A
// background job's stdin is /dev/null, so the watcher reads the app's pipe through fd 3. The shell
// ignores SIGTERM (set after the runtime started, which keeps the default) and waits for the
// runtime: when the shell exits, the runtime has ended and been reaped. The watcher writes nowhere,
// so a sleep it leaves behind does not hold the app's pipes open.
const WATCH_SCRIPT = [
  "exec 3<&0",
  '"$@" </dev/null 3<&- &',
  "child=$!",
  "trap '' TERM",
  `( read -r line <&3; kill -s TERM 0; sleep ${STOP_GRACE_SEC}; kill -s KILL 0 ) </dev/null >/dev/null 2>&1 &`,
  "watcher=$!",
  "exec 3<&-",
  'wait "$child"; status=$?',
  'kill -s KILL "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null',
  'exit "$status"'
].join("\n");

/** The signal that ended a runtime: the watching shell reports one killed by signal n as 128 + n. */
export const endingSignal = (code: number | null, signal: NodeJS.Signals | null): NodeJS.Signals | undefined => {
  if (signal) return signal;
  if (process.platform === "win32" || code === null || code <= 128) return undefined;
  return Object.entries(os.constants.signals).find(([, number]) => number === code - 128)?.[0] as NodeJS.Signals | undefined;
};

export interface GuardedProcess {
  /** The watching shell on POSIX, the runtime itself on Windows: it exits when the runtime does. */
  readonly process: ChildProcess;
  /** Asks the runtime to end: SIGTERM, and SIGKILL after STOP_GRACE_SEC (Windows: ends it now). */
  stop(): void;
  /** Ends the runtime and whatever it started, now. Safe to call when it has ended. */
  kill(): Promise<void>;
}

export interface GuardedOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdout: "pipe" | "ignore";
  stderr: "pipe" | "ignore";
}

/** Starts a native runtime (llama-server, whisper) so that it never outlives the app, however the
 * app ends. Nothing runs as a Node child of the app, so the packaged app needs no ELECTRON_RUN_AS_NODE.
 * Windows: started directly; libuv puts it in the app's job object, which ends it with the app. */
export const spawnGuarded = (executable: string, args: readonly string[], options: GuardedOptions): GuardedProcess => {
  if (process.platform === "win32") {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", options.stdout, options.stderr], windowsHide: true, shell: false });
    const kill = () => new Promise<void>(resolve => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.once("exit", () => resolve());
      killer.once("error", () => { child.kill(); resolve(); });
    });
    return { process: child, stop: () => { void kill(); }, kill };
  }
  const child = spawn("/bin/sh", ["-c", WATCH_SCRIPT, "local-cognitive-runtime", executable, ...args], {
    cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", options.stdout, options.stderr], shell: false
  });
  // Nothing is written to the watch pipe: an error on it only means the shell has gone.
  child.stdin?.on("error", () => undefined);
  const group = child.pid;
  return {
    process: child,
    stop: () => { child.stdin?.end(); },
    kill: async () => { if (group) try { process.kill(-group, "SIGKILL"); } catch { /* The group has ended. */ } }
  };
};
