import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { linkedRelease, releasesDir, type ReleaseRunner, type ServiceControl } from "./serverUpdate";

/** The server's user, from the system (the updater runs as root, the server never does). */
export const serviceUser = (name: string): { uid: number; gid: number } => {
  try {
    return { uid: Number(execFileSync("id", ["-u", name], { encoding: "utf8" }).trim()), gid: Number(execFileSync("id", ["-g", name], { encoding: "utf8" }).trim()) };
  } catch { throw new Error(`The server's user ${name} does not exist (see --user).`); }
};

/** A release's own CLI, run with its own Node as the server's user: files it writes in the data
 * directory stay the server's. Only a minimal environment is passed. */
export const releaseRunner = (user?: { uid: number; gid: number }): ReleaseRunner => ({
  run: (release, args) => new Promise(resolve => {
    const node = path.join(release, "node", "bin", "node");
    const child = spawn(node, [path.join(release, "dist", "src", "server", "cli.js"), ...args], {
      stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LOCAL_COGNITIVE_SENTRY: "off" }, ...(user ? { uid: user.uid, gid: user.gid } : {})
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => resolve({ status: 127, stdout, stderr: error.message }));
    child.on("close", status => resolve({ status: status ?? 1, stdout, stderr }));
  })
});

/** A release's file that root may act on: inside the release, and neither it nor a folder above it
 * there can be changed by anyone but the updater's own user (root on a server). */
const trustedReleaseFile = (release: string, relative: string): string => {
  const root = fs.realpathSync(release), file = fs.realpathSync(path.join(release, relative)), owner = process.getuid?.() ?? 0;
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error(`${relative} leaves the release`);
  for (let item = file; ; item = path.dirname(item)) {
    const stat = fs.lstatSync(item);
    if (stat.uid !== owner || (stat.mode & 0o022) !== 0) throw new Error(`${item} can be changed by another user`);
    if (item === root) return file;
  }
};

/** The unit a release ships, for this host's data folder: what install.sh writes. */
export const releaseUnit = (release: string, dataDir: string) =>
  fs.readFileSync(trustedReleaseFile(release, "deploy/server/local-cognitive.service"), "utf8").split("/srv/local-cognitive").join(dataDir);

/** Puts a release's unit in place of the installed one when they differ. Only a unit a release
 * installed (it runs <prefix>/current/…) is replaced; drop-ins (systemctl edit, nvidia.conf) stay.
 * An update never runs the server as root: a unit without a user of its own is not taken. */
export const replaceUnit = (file: string, release: string, options: { prefix: string; dataDir: string }): boolean => {
  let installed: string, wanted: string;
  try { installed = fs.readFileSync(file, "utf8"); wanted = releaseUnit(release, options.dataDir); } catch { return false; }
  if (wanted === installed || !installed.includes(`${options.prefix}/current/`) || !/^User=(?!root$|0$)\S+$/m.test(wanted)) return false;
  fs.writeFileSync(`${file}.new`, wanted, { mode: 0o644 });
  fs.renameSync(`${file}.new`, file);
  return true;
};

const systemctl = (args: string[]) => execFileSync("systemctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const property = (unit: string, name: string) => { try { return systemctl(["show", "-p", name, "--value", unit]); } catch { return ""; } };

/** The server as a systemd unit; its state read through the running release's `status`. */
export const systemdService = (options: { unit: string; prefix: string; dataDir: string; runner: ReleaseRunner; unitDir?: string }): ServiceControl => {
  const status = async () => {
    const current = linkedRelease(options.prefix, "current");
    if (!current) return undefined;
    const result = await options.runner.run(path.join(releasesDir(options.prefix), current), ["status", "--data-dir", options.dataDir, "--json"]);
    if (result.status !== 0) return undefined;
    try { return JSON.parse(result.stdout) as { version?: string; phase?: string; activeWork?: { total?: number } }; } catch { return undefined; }
  };
  return {
    // SIGTERM drains accepted work (TimeoutStopSec in the unit bounds it).
    stop: async () => { systemctl(["stop", options.unit]); },
    start: async () => { systemctl(["start", options.unit]); },
    useUnitOf: async release => {
      // Never fails an update halfway: the release then starts with the unit that was there.
      try {
        const changed = replaceUnit(path.join(options.unitDir ?? "/etc/systemd/system", `${options.unit}.service`), release, options);
        if (changed) systemctl(["daemon-reload"]);
        return changed;
      } catch { return false; }
    },
    activeWork: async () => (await status())?.activeWork?.total,
    healthy: async (version, timeoutMs) => {
      const restartsBefore = Number(property(options.unit, "NRestarts") || 0);
      const deadline = Date.now() + timeoutMs;
      let last = "no answer";
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2_000));
        // A crash loop is a failure at once: systemd restarts it, which is never "up".
        if (Number(property(options.unit, "NRestarts") || 0) > restartsBefore) return { ok: false, reason: "it crashed and systemd restarted it" };
        const active = property(options.unit, "ActiveState");
        if (active === "failed") return { ok: false, reason: "the service failed" };
        const state = active === "active" ? await status() : undefined;
        if (state?.version === version && state.phase === "running") return { ok: true };
        last = state ? `it reports ${state.version ?? "?"} (${state.phase ?? "?"})` : `the service is ${active || "unknown"}`;
      }
      return { ok: false, reason: last };
    }
  };
};
