import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { EgressEndpoint, SandboxProvider } from "./types";

/** The whole environment of a sandboxed command: nothing from the app's own (keys, tokens, PATH). */
export function sandboxEnv(executable: string, workDir: string): NodeJS.ProcessEnv {
  const tmp = path.join(workDir, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const tool = path.isAbsolute(executable) ? [path.dirname(executable)] : [];
  return {
    PATH: [...new Set([...tool, "/usr/bin", "/bin"])].join(":"),
    HOME: workDir, TMPDIR: tmp, LANG: "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8",
    ASAN_OPTIONS: "detect_leaks=0:abort_on_error=0",
    UBSAN_OPTIONS: "print_stacktrace=1:halt_on_error=1"
  };
}

const real = (file: string) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
const inside = (file: string, folder: string) => file === folder || file.startsWith(`${folder}/`);
/** A tool's folder may be opened up; never the home folder or a parent of it (/, /Users), nor system state. */
const openable = (dir: string) => dir.split("/").filter(Boolean).length >= 2 && !inside(real(os.homedir()), dir) &&
  !["/etc", "/private/etc", "/root", "/var/lib"].some(root => inside(dir, root));
const quote = (value: string) => `"${value.replace(/[\\"]/g, "\\$&")}"`;
const ancestors = (file: string) => {
  const found: string[] = [];
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) found.push(dir);
  return found;
};

/** The macOS profile. The sandbox matches resolved paths (/var is /private/var), so every path is a
 * realpath. Unfiltered rules are per-operation defaults; filtered ones are last-match-wins, so the
 * exceptions for the work folder and the tools follow the deny of the home folder. */
export function darwinProfile(workDir: string, readable: string[], egress?: EgressEndpoint): string {
  const work = real(workDir), home = real(os.homedir());
  const reads = [...new Set([work, ...readable.map(real).filter(openable)])];
  const hidden = [home, "/Users", "/private/var/folders", "/private/tmp", "/private/var/tmp", "/Volumes"];
  // A folder inside a hidden one stays usable only if its parents can be stat'ed (node's realpath does);
  // listing or reading them stays denied. access() is file-test-existence, not a read: denied with them.
  const parents = [...new Set(reads.flatMap(ancestors))].filter(dir => hidden.some(root => inside(dir, root)));
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    // The terminal's egress, when the project allows it, goes out only through a loopback proxy on this one
    // port (which enforces the same allowlist as http.request); every other network connection stays denied.
    ...(egress ? [`(allow network-outbound (remote ip "localhost:${egress.port}"))`] : []),
    // No way out through other processes: no system services (LaunchServices would start an app outside
    // the sandbox, as `open` does), no Apple Events (`osascript` driving Terminal), no signals to others.
    "(deny mach-lookup)",
    "(deny appleevent-send)",
    "(deny signal (target others))",
    "(deny file-write*)",
    `(allow file-write* (subpath ${quote(work)}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    // Nothing of the user's, not even whether a file exists: the home folder, every user's temporary and
    // cache folders, /tmp, other disks.
    `(deny file-read* file-test-existence ${hidden.map(dir => `(subpath ${quote(dir)})`).join(" ")})`,
    `(allow file-read* file-test-existence ${reads.map(dir => `(subpath ${quote(dir)})`).join(" ")})`,
    ...(parents.length ? [`(allow file-read-metadata file-test-existence ${parents.map(dir => `(literal ${quote(dir)})`).join(" ")})`] : [])
  ].join("\n");
}

/** Whether the sandbox isolates in fact, not only exists: a process inside it tries to read a file
 * outside its folders, to write outside its work folder and to reach a port on this machine. Any
 * success means no sandbox, and nothing runs (a deprecated sandbox-exec that stopped enforcing its
 * profile, a bubblewrap that lost its namespaces). The probe's own run must succeed: a sandbox that
 * runs nothing is no answer either. */
export async function verifyIsolation(provider: Pick<SandboxProvider, "wrap">): Promise<string | undefined> {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lc-sandbox-canary-"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "lc-sandbox-probe-"));
  // Given to the sandbox to read only (as a tool's folder is): a write there tests the write rule alone.
  const readOnly = fs.mkdtempSync(path.join(os.tmpdir(), "lc-sandbox-readonly-"));
  const secret = randomBytes(12).toString("hex");
  const canary = path.join(outside, "canary.txt"), written = path.join(readOnly, "written.txt");
  fs.writeFileSync(canary, secret);
  let connections = 0;
  const server = net.createServer(socket => { connections++; socket.destroy(); });
  try {
    const port = await new Promise<number>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)); });
    const script = 'cat "$1" 2>/dev/null; echo x > "$2" 2>/dev/null; if command -v nc >/dev/null 2>&1; then nc -z -w 2 127.0.0.1 "$3" >/dev/null 2>&1 && echo LC_REACHED; fi; echo LC_PROBE_RAN';
    const wrapped = provider.wrap("/bin/sh", ["-c", script, "sh", canary, written, String(port)], work, [readOnly]);
    const result = await new Promise<{ stdout: string; error?: string }>(resolve => execFile(wrapped.executable, wrapped.args, { cwd: work, env: wrapped.env, timeout: 20_000 },
      (error, stdout, stderr) => resolve({ stdout: String(stdout), ...(error && !String(stdout).includes("LC_PROBE_RAN") ? { error: String(stderr).trim().split("\n")[0] || error.message } : {}) })));
    if (result.error) return `the sandbox could not run a check (${result.error})`;
    if (!result.stdout.includes("LC_PROBE_RAN")) return "the sandbox did not run its check";
    if (result.stdout.includes(secret)) return "a sandboxed process read a file outside its folders";
    if (fs.existsSync(written)) return "a sandboxed process wrote outside its work folder";
    if (result.stdout.includes("LC_REACHED") || connections > 0) return "a sandboxed process reached the network";
    return undefined;
  } catch (error) {
    return `the sandbox could not be checked (${error instanceof Error ? error.message : String(error)})`;
  } finally {
    server.close();
    for (const dir of [outside, work, readOnly]) fs.rmSync(dir, { recursive: true, force: true });
  }
}
/** Kept once a check passes: a failed one is asked again, in case it was fixed meanwhile. */
const verified = new Map<string, Promise<string | undefined>>();
const isolated = (name: string, provider: Pick<SandboxProvider, "wrap">): Promise<string | undefined> => {
  let check = verified.get(name);
  if (!check) {
    check = verifyIsolation(provider);
    verified.set(name, check);
    void check.then(reason => { if (reason) verified.delete(name); });
  }
  return check;
};

const darwin: SandboxProvider = {
  name: "sandbox-exec",
  unavailable: async () => {
    if (!fs.existsSync("/usr/bin/sandbox-exec")) return "Contract tests need /usr/bin/sandbox-exec, which this Mac does not have.";
    const reason = await isolated("sandbox-exec", darwin);
    return reason ? `sandbox-exec does not isolate on this Mac: ${reason}. Nothing runs without a sandbox.` : undefined;
  },
  wrap: (executable, args, workDir, readable, egress) => ({
    executable: "/usr/bin/sandbox-exec",
    args: ["-p", darwinProfile(workDir, readable, egress), executable, ...args],
    env: sandboxEnv(executable, workDir)
  }),
  // sandbox-exec filters by rule rather than a namespace, so a single loopback port can be opened precisely.
  egressSupported: true
};

const onPath = (name: string) => [...(process.env.PATH ?? "").split(path.delimiter), "/usr/bin", "/bin"]
  .filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, name))
  .find(file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });

/** The system folders a toolchain needs, read-only; /home, /root, /etc and /var stay out of the sandbox. */
function bwrapBase(): string[] {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", "/usr", "/usr"];
  for (const dir of ["/bin", "/sbin", "/lib", "/lib64"]) {
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink()) args.push("--symlink", fs.readlinkSync(dir), dir);
      else if (stat.isDirectory()) args.push("--ro-bind", dir, dir);
    } catch {}
  }
  for (const file of ["/etc/alternatives", "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d"]) args.push("--ro-bind-try", file, file);
  return args;
}

/** bubblewrap 0.8 and later also keep the code under test from making user namespaces of its own
 * (and so capabilities over mounts and networks of its own), now that the server's unit allows them.
 * What this bubblewrap knows decides it, never a failed attempt: one that knows the option and fails
 * with it is no sandbox. Unknown until a check passes, and then nothing runs without the answer. */
const NO_NESTED_USERNS = ["--unshare-user", "--disable-userns"];
let nestedUsernsBlocked: boolean | undefined;
/** A server installed by install.sh sets bubblewrap and its service up with its own command. */
const fix = (otherwise: string) => fs.existsSync("/usr/local/bin/local-cognitive-server") ? "on this server, run sudo local-cognitive-server sandbox" : otherwise;

async function probeBwrap(): Promise<string | undefined> {
  const bwrap = onPath("bwrap");
  if (!bwrap) return `Contract tests need bubblewrap (bwrap) to sandbox the code: ${fix("install the bubblewrap package")}.`;
  const run = (args: string[]) => new Promise<{ stdout: string; error?: string }>(resolve =>
    execFile(bwrap, args, { timeout: 10_000, env: { PATH: "/usr/bin:/bin" } }, (error, stdout, stderr) =>
      resolve({ stdout: String(stdout), error: error ? String(stderr).trim().split("\n")[0] || error.message : undefined })));
  const help = await run(["--help"]);
  if (help.error) return `bubblewrap does not answer (${help.error}): ${fix("reinstall the bubblewrap package")}.`;
  // An older bubblewrap (0.6 on Ubuntu 22.04) does not know the option, and runs without it.
  const blocks = help.stdout.includes("--disable-userns");
  const { error } = await run([...bwrapBase(), ...(blocks ? NO_NESTED_USERNS : []), "--", "/usr/bin/true"]);
  if (!error) { nestedUsernsBlocked = blocks; return undefined; }
  return `bubblewrap cannot create a sandbox here (${error}): ${fix("allow unprivileged user namespaces (on Ubuntu 24.04 and later, with the AppArmor profile bwrap-userns-restrict from apparmor-profiles)")}.`;
}
let bwrapProbe: Promise<string | undefined> | undefined;
const linux: SandboxProvider = {
  name: "bubblewrap",
  unavailable: async () => {
    const reason = await (bwrapProbe ??= probeBwrap());
    // Only success is kept: an administrator may install bubblewrap without restarting the server.
    if (reason) { bwrapProbe = undefined; return reason; }
    const leak = await isolated("bubblewrap", linux);
    return leak ? `bubblewrap does not isolate here: ${leak}. Nothing runs without a sandbox.` : undefined;
  },
  wrap: (executable, args, workDir, readable) => {
    if (nestedUsernsBlocked === undefined) throw new Error("bubblewrap has not been checked on this machine yet.");
    return { executable: onPath("bwrap") ?? "bwrap", args: bwrapArgs(executable, args, workDir, readable, nestedUsernsBlocked), env: sandboxEnv(executable, real(workDir)) };
  }
};

/** The bubblewrap command line: the system folders, the tools' folders read-only, the work folder writable. */
export function bwrapArgs(executable: string, args: string[], workDir: string, readable: string[], noNestedUserns = false): string[] {
  const work = real(workDir);
  // Toolchains under /usr are already visible; any other tool folder is bound read-only at its own path.
  const binds = [...new Set(readable.flatMap(dir => [path.resolve(dir), real(dir)]))]
    .filter(dir => !inside(dir, "/usr") && openable(dir) && fs.existsSync(dir)).flatMap(dir => ["--ro-bind", dir, dir]);
  return [...bwrapBase(), ...(noNestedUserns ? NO_NESTED_USERNS : []), ...binds, "--bind", work, work, "--chdir", work, "--", executable, ...args];
}

/** Said for contract tests and for agents' terminals alike: neither runs code without a sandbox. */
const NO_SANDBOX = `${process.platform === "win32" ? "Windows" : "This platform"} has no sandbox for code a model wrote yet (one is planned); contract tests and agents' terminals run only in one: sandbox-exec on macOS, bubblewrap on Linux.`;
const unsupported: SandboxProvider = {
  name: "none",
  unavailable: async () => NO_SANDBOX,
  wrap: () => { throw new Error(NO_SANDBOX); }
};

/** The sandbox of this platform: sandbox-exec on macOS, bubblewrap on Linux, none elsewhere. */
export function platformSandbox(): SandboxProvider {
  return process.platform === "darwin" ? darwin : process.platform === "linux" ? linux : unsupported;
}

/** FOR TESTS ONLY: runs the command directly, with the same minimal environment but no isolation.
 * Model-written code must never run through it in the product. */
export const unsandboxed: SandboxProvider = {
  name: "unsandboxed",
  unavailable: async () => undefined,
  wrap: (executable, args, workDir) => ({ executable, args, env: sandboxEnv(executable, workDir) })
};
