import { execFileSync, spawn } from "child_process";
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

const systemctl = (args: string[]) => execFileSync("systemctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const property = (unit: string, name: string) => { try { return systemctl(["show", "-p", name, "--value", unit]); } catch { return ""; } };

/** The server as a systemd unit; its state read through the running release's `status`. */
export const systemdService = (options: { unit: string; prefix: string; dataDir: string; runner: ReleaseRunner }): ServiceControl => {
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
