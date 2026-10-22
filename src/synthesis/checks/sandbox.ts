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
/** Runtime folders are never opened up either: a socket in any bound folder can be connected to from
 * inside, whatever its network (session buses, systemd, container engines). */
const openable = (dir: string) => dir.split("/").filter(Boolean).length >= 2 && !inside(real(os.homedir()), dir) &&
  !["/etc", "/private/etc", "/root", "/var/lib", "/run", "/var/run", "/dev", "/proc", "/sys", ...(process.env.XDG_RUNTIME_DIR ? [real(process.env.XDG_RUNTIME_DIR)] : [])].some(root => inside(dir, root));
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
    env: sandboxEnv(executable, workDir),
    ...(egress ? { proxyUrl: `http://127.0.0.1:${egress.port}` } : {})
  }),
  // sandbox-exec filters by rule rather than a namespace, so a single loopback port can be opened precisely.
  egressSupported: true,
  egressTransport: "tcp"
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

/** A seccomp filter for every sandboxed command (classic BPF, as bubblewrap's --seccomp takes it): socket()
 * opens only Unix, IPv4, IPv6 and netlink sockets (a network namespace does not confine others, such as
 * vsock to the host or a hypervisor), io_uring (which opens sockets without socket()) is not there, and a
 * syscall of another architecture (32-bit code on a 64-bit machine, x32) is refused. Undefined on an
 * architecture it does not know: the sandbox then runs without it, and a terminal gets no web access. */
export function seccompFilter(arch: string = process.arch): Buffer | undefined {
  const target = ({ x64: { audit: 0xC000003E, socket: 41, x32: true }, arm64: { audit: 0xC00000B7, socket: 198, x32: false } } as const)[arch as "x64" | "arm64"];
  if (!target) return undefined;
  const LD = 0x20, JEQ = 0x15, JGE = 0x35, RET = 0x06;
  const ALLOW = 0x7fff0000, ERRNO = 0x00050000, EPERM = 1, ENOSYS = 38, EAFNOSUPPORT = 97;
  type Step = { code: number; k: number; t?: string; f?: string; label?: string };
  const program: Step[] = [
    { code: LD, k: 4 }, { code: JEQ, k: target.audit, f: "foreign" },
    { code: LD, k: 0 },
    ...(target.x32 ? [{ code: JGE, k: 0x40000000, t: "foreign" }] : []),
    // io_uring_setup, io_uring_enter, io_uring_register.
    { code: JEQ, k: 425, t: "nosys" }, { code: JEQ, k: 426, t: "nosys" }, { code: JEQ, k: 427, t: "nosys" },
    { code: JEQ, k: target.socket, f: "allow" },
    // socket(family, ...): the family's high half must be 0, then AF_UNIX, AF_INET, AF_INET6 or AF_NETLINK.
    { code: LD, k: 20 }, { code: JEQ, k: 0, f: "family" },
    { code: LD, k: 16 }, { code: JEQ, k: 1, t: "allow" }, { code: JEQ, k: 2, t: "allow" }, { code: JEQ, k: 10, t: "allow" }, { code: JEQ, k: 16, t: "allow" },
    { code: RET, k: ERRNO | EAFNOSUPPORT, label: "family" },
    { code: RET, k: ALLOW, label: "allow" },
    { code: RET, k: ERRNO | ENOSYS, label: "nosys" },
    { code: RET, k: ERRNO | EPERM, label: "foreign" }
  ];
  const at = (label: string) => program.findIndex(step => step.label === label);
  const out = Buffer.alloc(program.length * 8);
  program.forEach((step, index) => {
    const jump = (label?: string) => label ? at(label) - index - 1 : 0;
    out.writeUInt16LE(step.code, index * 8);
    out.writeUInt8(jump(step.t), index * 8 + 2); out.writeUInt8(jump(step.f), index * 8 + 3);
    out.writeUInt32LE(step.k >>> 0, index * 8 + 4);
  });
  return out;
}
/** The filter, written once where only the server's user reads it (bubblewrap reads it from fd 3). */
let seccompFile: string | undefined;
function seccompPath(): string | undefined {
  if (seccompFile && fs.existsSync(seccompFile)) return seccompFile;
  const filter = seccompFilter();
  if (!filter) return undefined;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lc-seccomp-"));
  seccompFile = path.join(folder, "filter.bpf");
  fs.writeFileSync(seccompFile, filter, { mode: 0o600 });
  return seccompFile;
}
/** bubblewrap with the filter on fd 3, opened by a shell that then becomes bubblewrap. */
const SECCOMP_EXEC = 'f=$1; shift; exec "$@" 3<"$f"';
/** Whether this bubblewrap loads the filter: checked with the sandbox; without it, no web access. */
let seccompActive = false;
const withSeccomp = (bwrap: string, args: string[]) => {
  const filter = seccompActive ? seccompPath() : undefined;
  return filter ? { executable: "/bin/sh", args: ["-c", SECCOMP_EXEC, "sh", filter, bwrap, "--seccomp", "3", ...args] } : { executable: bwrap, args };
};

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
  if (!error) {
    nestedUsernsBlocked = blocks;
    // The socket filter, where this bubblewrap and kernel take it: the sandbox works without it as before.
    const filter = seccompPath();
    seccompActive = Boolean(filter) && await new Promise<boolean>(resolve => execFile("/bin/sh", ["-c", SECCOMP_EXEC, "sh", filter!, bwrap, "--seccomp", "3", ...bwrapBase(), ...(blocks ? NO_NESTED_USERNS : []), "--", "/usr/bin/true"],
      { timeout: 10_000, env: { PATH: "/usr/bin:/bin" } }, error => resolve(!error)));
    return undefined;
  }
  return `bubblewrap cannot create a sandbox here (${error}): ${fix("allow unprivileged user namespaces (on Ubuntu 24.04 and later, with the AppArmor profile bwrap-userns-restrict from apparmor-profiles)")}.`;
}
let bwrapProbe: Promise<string | undefined> | undefined;
/** The terminal's web access on Linux: checked the first time an agent needs it, then again every hour
 * (a failure after ten minutes), so a change on the server is noticed. */
let egressCheck: { result: Promise<string | undefined>; at: number } | undefined;
const EGRESS_RECHECK_MS = 60 * 60_000, EGRESS_RETRY_MS = 10 * 60_000;
const linux: SandboxProvider = {
  name: "bubblewrap",
  unavailable: async () => {
    const reason = await (bwrapProbe ??= probeBwrap());
    // Only success is kept: an administrator may install bubblewrap without restarting the server.
    if (reason) { bwrapProbe = undefined; return reason; }
    const leak = await isolated("bubblewrap", linux);
    return leak ? `bubblewrap does not isolate here: ${leak}. Nothing runs without a sandbox.` : undefined;
  },
  checkEgress: async () => {
    const unavailable = await linux.unavailable();
    if (unavailable) { linux.egressSupported = false; return unavailable; }
    if (!egressCheck || Date.now() - egressCheck.at > (linux.egressSupported ? EGRESS_RECHECK_MS : EGRESS_RETRY_MS)) {
      egressCheck = { at: Date.now(), result: (async () => {
        // An older bubblewrap lets the command make namespaces of its own, with capabilities in them over
        // networks of its own: the kernel then answers more than the proxy alone, so no web access.
        if (!nestedUsernsBlocked) return "this bubblewrap cannot keep commands from making user namespaces of their own (it needs 0.8 or later)";
        if (!seccompActive) return "the sandbox's socket filter (seccomp) could not be loaded here";
        return verifyEgress(linux).catch(error => `it could not be checked (${error instanceof Error ? error.message : String(error)})`);
      })() };
    }
    const reason = await egressCheck.result;
    linux.egressSupported = !reason;
    return reason;
  },
  wrap: (executable, args, workDir, readable, egress) => {
    if (nestedUsernsBlocked === undefined) throw new Error("bubblewrap has not been checked on this machine yet.");
    const bwrap = onPath("bwrap") ?? "bwrap", env = sandboxEnv(executable, real(workDir));
    if (!egress) return { ...withSeccomp(bwrap, bwrapArgs(executable, args, workDir, readable, nestedUsernsBlocked)), env };
    const wired = linuxEgress(egress);
    return { ...withSeccomp(bwrap, bwrapArgs(executable, args, workDir, readable, nestedUsernsBlocked, wired)), env: { ...env, ...wired.env }, proxyUrl: EGRESS_URL };
  },
  egressTransport: "unix"
};

/** Inside a Linux sandbox: where the proxy's socket folder is seen (read-only), and the loopback port the
 * forwarder listens on for the command's tools. */
const EGRESS_DIR = "/run/lc-egress", EGRESS_PORT = 3128, EGRESS_URL = `http://127.0.0.1:${EGRESS_PORT}`;
/** The forwarder: a byte pipe from the sandbox's 127.0.0.1:3128 to the proxy's socket, so proxy-aware
 * tools find the proxy at a usual address. It runs beside the command (same user, same namespaces) and
 * is no boundary: the command may stop it or connect to the socket itself, and still reaches only the
 * proxy, which decides everything. It parses nothing, says "ready" once it listens, and never closes its
 * stdout (a reused descriptor would reset connections). */
export const EGRESS_FORWARDER = 'const net=require("net"),fs=require("fs");const [sock,port]=process.argv.slice(1);'
  + 'const srv=net.createServer(c=>{const u=net.connect(sock);c.pipe(u);u.pipe(c);const end=()=>{c.destroy();u.destroy();};u.on("error",end);c.on("error",end);u.on("close",()=>c.end());c.on("close",()=>u.destroy());});'
  + 'srv.on("error",e=>{process.stderr.write("lc-egress: "+e.message+"\\n");process.exit(70);});'
  + 'srv.listen(Number(port),"127.0.0.1",()=>fs.writeSync(1,"ready\\n"));';
/** Starts the forwarder and runs the command only once it listens: if it cannot start, the command does
 * not run (exit 70). The FIFO is in the sandbox's own /tmp, never the copy's TMPDIR. Descriptors are
 * bounded first, for the forwarder and the command alike. */
const EGRESS_BOOT = `ulimit -n 4096 2>/dev/null
f=/tmp/.lc-egress-ready; mkfifo -m 600 "$f" || exit 70
"$LC_EGRESS_NODE" -e "$LC_EGRESS_FORWARDER" ${EGRESS_DIR}/proxy.sock ${EGRESS_PORT} > "$f" 2>/dev/null &
read -r ok < "$f"; rm -f "$f"; [ "$ok" = ready ] || { echo "the terminal's web access could not start" >&2; exit 70; }
unset LC_EGRESS_NODE LC_EGRESS_FORWARDER; exec "$@"`;

/** The forwarder's runtime: the server's own Node. Never Electron: a Linux desktop window gives its
 * terminals no web access. */
const egressRuntime = (): string | undefined => {
  if (process.versions.electron) return undefined;
  const node = real(process.execPath);
  return openable(path.dirname(node)) ? node : undefined;
};
interface LinuxEgress { socketDir: string; runtime: string; env: NodeJS.ProcessEnv }
/** What a sandbox needs for web access: the proxy's socket and the forwarder's runtime. The socket must be
 * alone in a folder of its own that the proxy made (lce-XXXXXX in the temporary folder, this user's, 0700):
 * that folder is bound into the sandbox, so no other socket may be in it. Without them nothing is wrapped:
 * never a fall back to a shared network. */
export function linuxEgress(egress: { socketPath?: string }, runtime: string | null | undefined = egressRuntime(), tmp = os.tmpdir()): LinuxEgress {
  const socketPath = egress.socketPath;
  if (!socketPath || path.basename(socketPath) !== "proxy.sock") throw new Error("The terminal's web access on Linux needs the egress proxy's socket.");
  if (Buffer.byteLength(socketPath) >= 100) throw new Error("The egress proxy's socket path is too long.");
  const socketDir = path.dirname(socketPath);
  if (path.dirname(socketDir) !== tmp || !/^lce-[A-Za-z0-9]{6}$/.test(path.basename(socketDir))) throw new Error("The egress proxy's socket must be in a folder of its own in the temporary folder.");
  const stat = fs.lstatSync(socketDir);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) throw new Error("The egress proxy's socket folder must be this user's alone.");
  if (fs.readdirSync(socketDir).join("/") !== "proxy.sock") throw new Error("The egress proxy's socket must be alone in its folder.");
  if (!runtime) throw new Error("The terminal's web access on Linux needs the server's own Node.");
  return { socketDir, runtime, env: { LC_EGRESS_NODE: runtime, LC_EGRESS_FORWARDER: EGRESS_FORWARDER } };
}

/** The bubblewrap command line: the system folders, the tools' folders read-only, the work folder writable.
 * With `egress`, the network stays bubblewrap's own (only lo: never --share-net); the proxy's socket folder
 * is bound read-only at /run/lc-egress and the forwarder's runtime read-only, and the command starts after
 * the forwarder listens. */
export function bwrapArgs(executable: string, args: string[], workDir: string, readable: string[], noNestedUserns = false, egress?: Pick<LinuxEgress, "socketDir" | "runtime">): string[] {
  const work = real(workDir);
  // Toolchains under /usr are already visible; any other tool folder is bound read-only at its own path.
  const folders = [...readable, ...(egress ? [path.dirname(egress.runtime)] : [])];
  const binds = [...new Set(folders.flatMap(dir => [path.resolve(dir), real(dir)]))]
    .filter(dir => !inside(dir, "/usr") && openable(dir) && fs.existsSync(dir)).flatMap(dir => ["--ro-bind", dir, dir]);
  const web = egress ? ["--ro-bind", egress.socketDir, EGRESS_DIR] : [];
  const command = egress ? ["/bin/sh", "-c", EGRESS_BOOT, "sh", executable, ...args] : [executable, ...args];
  return [...bwrapBase(), ...(noNestedUserns ? NO_NESTED_USERNS : []), ...binds, ...web, "--bind", work, work, "--chdir", work, "--", ...command];
}

/** What the probe inside the sandbox tries; each line is `NAME=answer`. */
const EGRESS_PROBE = `const net=require("net"),fs=require("fs"),dns=require("dns"),dgram=require("dgram");
const [token,other4,other6,hostPort,abstract,ns,...addrs]=process.argv.slice(1);
const out=s=>process.stdout.write(s+"\\n");
const tcp=o=>new Promise(r=>{const c=net.connect({...o,timeout:2000});let d="";c.on("data",x=>d+=x);c.on("connect",()=>setTimeout(()=>{c.destroy();r("open:"+d);},300));c.on("error",e=>r("closed:"+e.code));c.on("timeout",()=>{c.destroy();r("closed:timeout");});});
const udp=h=>new Promise(r=>{const s=dgram.createSocket(h.includes(":")?"udp6":"udp4");s.on("error",e=>{try{s.close();}catch{}r("closed:"+e.code);});s.send(Buffer.from([0]),53,h,e=>{try{s.close();}catch{}r(e?"closed:"+e.code:"sent");});});
(async()=>{
out("PROXY="+(await tcp({host:"127.0.0.1",port:${EGRESS_PORT}})));
out("OTHER="+(await tcp({host:"127.0.0.1",port:Number(other4)})));
if(Number(other6))out("OTHER="+(await tcp({host:"::1",port:Number(other6)})));
for(const a of addrs)out("HOST="+(await tcp({host:a,port:Number(hostPort)})));
if(abstract)out("ABSTRACT="+(await tcp({path:"\\0"+abstract})));
for(const h of ns.split(",").filter(Boolean))out("UDP="+(await udp(h)));
out("DNS="+await new Promise(r=>dns.lookup("example.com",e=>r(e?"fail":"ok"))));
const r4=fs.readFileSync("/proc/net/route","utf8").split("\\n").slice(1).map(l=>l.trim().split(/\\s+/)[0]).filter(Boolean);
const r6=fs.readFileSync("/proc/net/ipv6_route","utf8").split("\\n").map(l=>l.trim().split(/\\s+/)[9]).filter(Boolean);
out("ROUTES="+([...r4,...r6].filter(i=>i!=="lo").join(",")||"none"));
out("NETNS="+fs.readlinkSync("/proc/self/ns/net"));
try{fs.unlinkSync("${EGRESS_DIR}/proxy.sock");out("UNLINK=done");}catch(e){out("UNLINK="+e.code);}
out("LC_EGRESS_END");})();`;
/** Whether the sandbox can open a vsock (to the host or a hypervisor): a network namespace does not
 * confine that family, only the server's unit (RestrictAddressFamilies) or the kernel does. */
const VSOCK_PROBE = `import socket
try:
    socket.socket(getattr(socket, "AF_VSOCK", 40), socket.SOCK_STREAM)
    print("VSOCK=open")
except OSError:
    print("VSOCK=blocked")`;

/** Whether a sandbox's web access goes to the proxy and nowhere else, run through the provider as a
 * terminal's command is. The proxy must answer through the forwarder. These must stay unreachable:
 * another loopback port (IPv4 and IPv6), this machine's own addresses, an abstract socket, the resolvers
 * and DNS, and vsock. The sandbox must have no route but lo's, a network that is not the server's, and
 * the proxy's socket must not be replaceable. Any other answer means no web access (never a sandbox
 * without one: the terminal then runs with no network). The probe binds no tool folders of a real command. */
export async function verifyEgress(provider: Pick<SandboxProvider, "wrap">, runtime: string | null | undefined = egressRuntime()): Promise<string | undefined> {
  if (!runtime) return "the server's own Node is needed for it";
  const python = ["/usr/bin/python3", "/bin/python3"].find(file => fs.existsSync(file));
  if (!python) return "python3 is needed to check that a sandbox has no other way out";
  const token = randomBytes(12).toString("hex");
  const hits = { proxy: 0, other: 0, host: 0, abstract: 0 };
  const interfaces = Object.values(os.networkInterfaces()).flat().filter((item): item is os.NetworkInterfaceInfo => Boolean(item) && !item!.internal);
  const addresses = interfaces.filter(item => item.family === "IPv4" || !item.address.toLowerCase().startsWith("fe80")).map(item => item.address);
  // Only connections from this machine count: a scanner elsewhere reaching the listener says nothing.
  const own = new Set([...interfaces.map(item => item.address), "127.0.0.1", "::1"]);
  const servers: net.Server[] = [];
  const serve = (handler: (socket: net.Socket) => void) => { const server = net.createServer(handler); servers.push(server); return server; };
  const listen = (server: net.Server, ...at: [string] | [number, string]) => new Promise<void>((resolve, reject) => { server.once("error", reject); (server.listen as (...args: unknown[]) => void)(...at, resolve); });
  const portOf = (server: net.Server) => (server.address() as net.AddressInfo).port;
  let folder: string | undefined, work: string | undefined;
  try {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "lce-"));
    work = fs.mkdtempSync(path.join(os.tmpdir(), "lc-egress-probe-"));
    const socketPath = path.join(folder, "proxy.sock");
    await listen(serve(socket => { hits.proxy++; socket.end(token); }), socketPath);
    const other4 = serve(socket => { hits.other++; socket.destroy(); });
    await listen(other4, 0, "127.0.0.1");
    const other6 = serve(socket => { hits.other++; socket.destroy(); });
    const has6 = await listen(other6, 0, "::1").then(() => true, () => false);
    const host = serve(socket => { if (own.has((socket.remoteAddress ?? "").replace(/^::ffff:/, ""))) hits.host++; socket.destroy(); });
    await listen(host, 0, "::").catch(() => listen(host, 0, "0.0.0.0"));
    // Abstract sockets are Linux's own (the check runs there; elsewhere only in tests).
    const abstract = process.platform === "linux" ? `lc-egress-${token}` : "";
    if (abstract) await listen(serve(socket => { hits.abstract++; socket.destroy(); }), `\0${abstract}`);
    // A resolver on loopback (127.0.0.53) answers nothing in the sandbox's own network either: not asked.
    const resolvers = (fs.existsSync("/etc/resolv.conf") ? fs.readFileSync("/etc/resolv.conf", "utf8") : "").split("\n")
      .map(line => /^\s*nameserver\s+(\S+)/.exec(line)?.[1]).filter((item): item is string => Boolean(item) && !/^(127\.|::1$)/.test(item!)).slice(0, 3);
    const endpoint = { host: "127.0.0.1", port: 0, socketPath };
    const run = (executable: string, args: string[]) => {
      const wrapped = provider.wrap(executable, args, work!, [], endpoint);
      return new Promise<string>(resolve => execFile(wrapped.executable, wrapped.args, { cwd: work, env: wrapped.env, timeout: 30_000 }, (_error, out) => resolve(String(out))));
    };
    const stdout = await run(runtime, ["-e", EGRESS_PROBE, token, String(portOf(other4)), String(has6 ? portOf(other6) : 0), String(portOf(host)), abstract, resolvers.join(","), ...addresses]);
    const lines = (name: string, text = stdout) => text.split("\n").filter(item => item.startsWith(`${name}=`)).map(item => item.slice(name.length + 1));
    if (!stdout.includes("LC_EGRESS_END")) return "the check did not run to its end";
    if (lines("PROXY")[0] !== `open:${token}` || hits.proxy < 1) return "the proxy did not answer through the sandbox";
    if (lines("OTHER").some(item => !item.startsWith("closed")) || hits.other > 0) return "a sandboxed process reached another port on this machine";
    if (lines("HOST").some(item => !item.startsWith("closed")) || hits.host > 0) return "a sandboxed process reached this machine's own address";
    if ((abstract && !lines("ABSTRACT")[0]?.startsWith("closed")) || hits.abstract > 0) return "a sandboxed process reached an abstract socket of this machine";
    if (lines("UDP").some(item => item === "sent")) return "a sandboxed process could send to this machine's resolver";
    if (lines("DNS")[0] !== "fail") return "a sandboxed process resolved a name";
    if (lines("ROUTES")[0] !== "none") return `the sandbox has a route besides lo (${lines("ROUTES")[0]})`;
    let ours = ""; try { ours = fs.readlinkSync("/proc/self/ns/net"); } catch { /* not Linux */ }
    if (!lines("NETNS")[0] || lines("NETNS")[0] === ours) return "the sandbox shares the server's network";
    if (lines("UNLINK")[0] === "done" || !fs.existsSync(socketPath)) return "a sandboxed process could replace the proxy's socket";
    const vsock = lines("VSOCK", await run(python, ["-I", "-c", VSOCK_PROBE]))[0];
    if (vsock !== "blocked") return vsock === "open" ? "a sandboxed process could open a vsock to the host (run the server with its systemd unit)" : "the vsock check did not run";
    return undefined;
  } catch (error) {
    return `it could not be checked (${error instanceof Error ? error.message : String(error)})`;
  } finally {
    for (const server of servers) server.close();
    for (const dir of [folder, work]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
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
