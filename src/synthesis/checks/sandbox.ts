import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SandboxProvider } from "./types";

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
export function darwinProfile(workDir: string, readable: string[]): string {
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

const darwin: SandboxProvider = {
  name: "sandbox-exec",
  unavailable: async () => fs.existsSync("/usr/bin/sandbox-exec") ? undefined : "Contract tests need /usr/bin/sandbox-exec, which this Mac does not have.",
  wrap: (executable, args, workDir, readable) => ({
    executable: "/usr/bin/sandbox-exec",
    args: ["-p", darwinProfile(workDir, readable), executable, ...args],
    env: sandboxEnv(executable, workDir)
  })
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

const probeBwrap = () => new Promise<string | undefined>(resolve => {
  const bwrap = onPath("bwrap");
  if (!bwrap) return resolve("Contract tests need bubblewrap (bwrap) to sandbox the code: install the bubblewrap package.");
  execFile(bwrap, [...bwrapBase(), "--", "/usr/bin/true"], { timeout: 10_000, env: { PATH: "/usr/bin:/bin" } }, (error, _stdout, stderr) => {
    const detail = String(stderr).trim().split("\n")[0] || error?.message;
    resolve(error ? `bubblewrap cannot create a sandbox here (${detail}): install bubblewrap from the distribution, or allow unprivileged user namespaces (on Ubuntu 24.04: sysctl kernel.apparmor_restrict_unprivileged_userns=0).` : undefined);
  });
});
let bwrapProbe: Promise<string | undefined> | undefined;
const linux: SandboxProvider = {
  name: "bubblewrap",
  unavailable: async () => {
    const reason = await (bwrapProbe ??= probeBwrap());
    // Only success is kept: an administrator may install bubblewrap without restarting the server.
    if (reason) bwrapProbe = undefined;
    return reason;
  },
  wrap: (executable, args, workDir, readable) => ({
    executable: onPath("bwrap") ?? "bwrap", args: bwrapArgs(executable, args, workDir, readable), env: sandboxEnv(executable, real(workDir))
  })
};

/** The bubblewrap command line: the system folders, the tools' folders read-only, the work folder writable. */
export function bwrapArgs(executable: string, args: string[], workDir: string, readable: string[]): string[] {
  const work = real(workDir);
  // Toolchains under /usr are already visible; any other tool folder is bound read-only at its own path.
  const binds = [...new Set(readable.flatMap(dir => [path.resolve(dir), real(dir)]))]
    .filter(dir => !inside(dir, "/usr") && openable(dir) && fs.existsSync(dir)).flatMap(dir => ["--ro-bind", dir, dir]);
  return [...bwrapBase(), ...binds, "--bind", work, work, "--chdir", work, "--", executable, ...args];
}

const unsupported: SandboxProvider = {
  name: "none",
  unavailable: async () => "Contract tests need a sandbox, which this platform does not have yet.",
  wrap: () => { throw new Error("Contract tests need a sandbox, which this platform does not have yet."); }
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
