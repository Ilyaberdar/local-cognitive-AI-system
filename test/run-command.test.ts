import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../src/utils/runCommand";

const posix = process.platform !== "win32";

test("a command that times out resolves as timed out even when its group is gone by the time it is killed (EPERM on macOS, ESRCH elsewhere)", { skip: !posix }, async t => {
  for (const code of ["EPERM", "ESRCH"]) {
    const original = process.kill;
    // The group's leader and the group have ended between the timeout and the kill: the system refuses the signal.
    process.kill = ((pid: number, signal?: string | number) => {
      if (pid < 0) throw Object.assign(new Error(`kill ${code}`), { code });
      return original.call(process, pid, signal);
    }) as typeof process.kill;
    t.after(() => { process.kill = original; });
    try {
      const result = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000); process.on('SIGTERM', () => process.exit(0))"], process.cwd(), 200);
      assert.equal(result.timedOut, true, code);
      assert.equal(result.exitCode, 124);
    } finally { process.kill = original; }
  }
});
