import { spawn } from "child_process";

/** IPC disconnect also happens after force quit/crash of Electron: reap the native process. */
if (require.main === module) {
  const executable = process.argv[2];
  const args = JSON.parse(process.argv[3] ?? "[]") as string[];
  const child = spawn(executable, args, { shell: false, detached: process.platform !== "win32", stdio: ["ignore", "inherit", "inherit"] });
  // The parent can still reap our native child if this guardian itself is killed.
  if (child.pid && process.connected) process.send?.({ type: "native-started", pid: child.pid });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (!child.pid) { process.exit(0); return; }
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => child.kill("SIGKILL"));
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 1500).unref();
    }
  };
  process.on("disconnect", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("message", (message) => { if (message === "stop") stop(); });
  child.once("error", (error) => { process.stderr.write(`Native runtime could not start: ${error.message}\n`); process.exit(1); });
  child.once("exit", (code) => process.exit(stopping ? 0 : (code ?? 1)));
  // Do not leave an inference server behind if IPC disconnected before handlers were installed.
  if (!process.connected) stop();
}
