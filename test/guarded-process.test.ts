import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { endingSignal, spawnGuarded, STOP_GRACE_SEC } from "../src/local/guardedProcess";

const posix = process.platform !== "win32";
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await delay(50)) if (check()) return true;
  return check();
};
const firstLine = (stream: NodeJS.ReadableStream) => new Promise<string>(resolve => {
  let text = "";
  stream.on("data", chunk => { text += chunk; if (text.includes("\n")) resolve(text.split("\n")[0]!); });
});
const exited = (child: ChildProcess) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));

test("a guarded runtime gets its arguments, environment and folder, and its exit status comes back", { skip: !posix }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lc-guard-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const guarded = spawnGuarded("/bin/sh", ["-c", 'printf "%s|%s|%s\\n" "$1" "$LC_GUARD_TEST" "$(pwd -P)"; exit 3', "runtime", "first arg"],
    { cwd: directory, env: { ...env, LC_GUARD_TEST: "from env" }, stdout: "pipe", stderr: "pipe" });
  const [line, end] = await Promise.all([firstLine(guarded.process.stdout!), exited(guarded.process)]);
  assert.equal(line, `first arg|from env|${fs.realpathSync(directory)}`);
  assert.deepEqual(end, { code: 3, signal: null });
});

test("stop ends the runtime; one that ignores SIGTERM is killed after the grace period", { skip: !posix, timeout: 20_000 }, async () => {
  const polite = spawnGuarded("/bin/sh", ["-c", "echo $$; exec sleep 30"], { env, stdout: "pipe", stderr: "pipe" });
  const politePid = Number(await firstLine(polite.process.stdout!));
  const politeEnd = exited(polite.process);
  polite.stop();
  await politeEnd;
  assert.ok(await until(() => !alive(politePid), 1000), "the runtime ended");

  const stubborn = spawnGuarded("/bin/sh", ["-c", 'trap "" TERM; echo $$; while :; do sleep 1; done'], { env, stdout: "pipe", stderr: "pipe" });
  const stubbornPid = Number(await firstLine(stubborn.process.stdout!));
  const asked = Date.now();
  stubborn.stop();
  assert.ok(await until(() => !alive(stubbornPid), (STOP_GRACE_SEC + 3) * 1000), "killed after the grace period");
  assert.ok(Date.now() - asked >= STOP_GRACE_SEC * 1000 - 250, "it had its grace period");
});

test("a stopped runtime releases the app's pipes with its exit: nothing left behind holds them open", { skip: !posix }, async () => {
  const guarded = spawnGuarded("/bin/sh", ["-c", "echo $$; exec sleep 30"], { env, stdout: "pipe", stderr: "pipe" });
  await firstLine(guarded.process.stdout!);
  const exitAt = new Promise<number>(resolve => guarded.process.once("exit", () => resolve(Date.now())));
  const closeAt = new Promise<number>(resolve => guarded.process.once("close", () => resolve(Date.now())));
  guarded.stop();
  const [exit, close] = await Promise.all([exitAt, closeAt]);
  assert.ok(close - exit < 500, `close came ${close - exit} ms after exit`);
});

test("a runtime killed by a signal is reported by that signal, not the shell's 128 + n", { skip: !posix }, async () => {
  assert.equal(endingSignal(137, null), "SIGKILL");
  assert.equal(endingSignal(143, null), "SIGTERM");
  assert.equal(endingSignal(3, null), undefined);
  assert.equal(endingSignal(null, "SIGSEGV"), "SIGSEGV");
  const guarded = spawnGuarded("/bin/sh", ["-c", "kill -s KILL $$"], { env, stdout: "pipe", stderr: "pipe" });
  const end = await exited(guarded.process);
  assert.equal(endingSignal(end.code, end.signal), "SIGKILL");
});

test("kill ends the runtime and what it started, at once", { skip: !posix }, async () => {
  const guarded = spawnGuarded("/bin/sh", ["-c", "sleep 30 & echo $!; wait"], { env, stdout: "pipe", stderr: "pipe" });
  const started = Number(await firstLine(guarded.process.stdout!));
  assert.ok(alive(started));
  await guarded.kill();
  assert.ok(await until(() => !alive(started), 1000));
  await guarded.kill();
});

test("the runtime does not outlive the app, even when the app is killed with SIGKILL", { skip: !posix, timeout: 20_000 }, async () => {
  const module = path.resolve(__dirname, "..", "src", "local", "guardedProcess.js");
  const app = spawn(process.execPath, ["-e", `
    const { spawnGuarded } = require(${JSON.stringify(module)});
    const guarded = spawnGuarded("/bin/sh", ["-c", "echo $$; exec sleep 30"], { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "ignore" });
    guarded.process.stdout.pipe(process.stdout);
    setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  const runtime = Number(await firstLine(app.stdout!));
  assert.ok(alive(runtime));
  app.kill("SIGKILL");
  assert.ok(await until(() => !alive(runtime), 2000), "the native runtime was reaped");
});
