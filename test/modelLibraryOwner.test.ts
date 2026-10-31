import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ModelLibraryStore, ownerGone } from "../src/local/ModelLibraryStore";

const library = async (t: TestContext, owner?: Record<string, unknown>) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lc-library-owner-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const modelsDir = path.join(root, "models");
  await fs.mkdir(modelsDir);
  if (owner) await fs.writeFile(path.join(modelsDir, ".owner.json"), JSON.stringify({ token: "left-behind", ...owner }));
  return { store: new ModelLibraryStore(path.join(root, "data"), modelsDir), lock: path.join(modelsDir, ".owner.json") };
};

test("a library lock left before the computer started is taken over, though its PID is in use again (fedora after a power cut)", async t => {
  const { store, lock } = await library(t, { pid: process.pid, createdAt: "2000-01-01T00:00:00.000Z" });
  await store.init();
  assert.notEqual(JSON.parse(await fs.readFile(lock, "utf8")).token, "left-behind");
});

test("a library lock of a running process of this start is respected; one whose process ended is taken over", async t => {
  const live = await library(t, { pid: process.pid, createdAt: new Date().toISOString() });
  await assert.rejects(live.store.init(), (error: { code?: string }) => error.code === "library_owned");
  const ended = spawnSync(process.execPath, ["-e", ""]).pid;
  const gone = await library(t, { pid: ended, createdAt: new Date().toISOString() });
  await gone.store.init();
});

test("a lock is the app's only while its PID is a process of this user started since the computer did", () => {
  const now = Date.parse("2026-10-31T01:14:00Z"), uptime = 30;
  assert.equal(ownerGone({ pid: process.pid, createdAt: "2026-10-31T01:13:55Z" }, now, uptime), false, "made in this start, alive");
  assert.equal(ownerGone({ pid: process.pid, createdAt: "2026-10-31T01:12:50Z" }, now, uptime), false, "a clock set a little after the start");
  assert.equal(ownerGone({ pid: process.pid, createdAt: "2026-10-29T20:48:40Z" }, now, uptime), true, "made before the start");
  assert.equal(ownerGone({ pid: process.pid }, now, uptime), false, "no date: the PID decides");
  // PID 1 is the system's (another user) on macOS and Linux, and no process on Windows.
  if (process.getuid?.() !== 0) assert.equal(ownerGone({ pid: 1, createdAt: new Date(now).toISOString() }, now, uptime), true);
});
