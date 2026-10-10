import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { DataRootLock } from "../src/runtime/db/DataRootLock";
import { HostDatabase } from "../src/runtime/db/HostDatabase";
import { hostMigrations } from "../src/runtime/db/hostSchema";
import { backupDataRoot, listBackups, restoreDataRoot } from "../src/update/dataBackup";
import { checkDataRoot } from "../src/server/dataRoot";

const posix = process.platform !== "win32";
const cli = path.resolve(__dirname, "..", "src", "server", "cli.js");

const dataRoot = (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lc-backup-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "data");
  for (const directory of ["app/runtime", "app/integrations/host-vault", "memory", "sessions", "models", "output"]) fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "server.json"), '{"schemaVersion":1}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(root, "app", "settings.json"), '{"ui":{"language":"ru"}}', { mode: 0o600 });
  fs.writeFileSync(path.join(root, "app", "integrations", "host-vault", "a.enc"), "ciphertext", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "sessions", "s1.json"), '{"title":"chat"}');
  fs.writeFileSync(path.join(root, "models", "big.gguf"), Buffer.alloc(1024));
  fs.writeFileSync(path.join(root, "output", "result.txt"), "user file");
  fs.writeFileSync(path.join(root, "app", "runtime", "data-root.lock"), "");
  if (posix) fs.symlinkSync("/etc/hosts", path.join(root, "memory", "link"));
  return { base, root };
};

test("a backup is the server's state, consistent and private; models, output, locks and links are not in it; three are kept", (t) => {
  const { root } = dataRoot(t);
  // A live database in WAL mode, with a row only in the WAL.
  const host = HostDatabase.open(path.join(root, "app", "runtime", "host.db"), hostMigrations);
  host.db.prepare("INSERT INTO host_meta(key, value) VALUES ('probe', 'kept')").run();
  const result = backupDataRoot(root, { label: "before-0.2.0", now: new Date("2026-10-10T10:00:00Z") });
  host.close();
  assert.equal(path.basename(result.directory), "20261010T100000Z-before-0.2.0");
  const copied = (relative: string) => path.join(result.directory, relative);
  const db = new (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync(copied("app/runtime/host.db"), { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM host_meta WHERE key = 'probe'").get()?.value, "kept", "the WAL's rows are in the copy");
  db.close();
  assert.equal(fs.readFileSync(copied("app/settings.json"), "utf8"), '{"ui":{"language":"ru"}}');
  assert.equal(fs.readFileSync(copied("app/integrations/host-vault/a.enc"), "utf8"), "ciphertext");
  for (const absent of ["models", "output", "app/runtime/data-root.lock", "app/runtime/host.db-wal", "memory/link"]) assert.equal(fs.existsSync(copied(absent)), false, absent);
  if (posix) {
    assert.equal(fs.statSync(copied("app/settings.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.directory).mode & 0o777, 0o700);
  }
  for (let hour = 11; hour <= 13; hour++) backupDataRoot(root, { label: "x", now: new Date(`2026-10-10T${hour}:00:00Z`) });
  assert.deepEqual(listBackups(root).map(item => item.name), ["20261010T130000Z-x", "20261010T120000Z-x", "20261010T110000Z-x"], "the newest three");
});

test("a restore puts the state back and keeps what it replaced; models stay", (t) => {
  const { root } = dataRoot(t);
  const backup = backupDataRoot(root, { label: "before", now: new Date("2026-10-10T10:00:00Z") });
  fs.writeFileSync(path.join(root, "app", "settings.json"), '{"ui":{"language":"en"},"migrated":true}');
  fs.writeFileSync(path.join(root, "sessions", "s2.json"), "{}");
  const { replaced } = restoreDataRoot(root, backup.directory, new Date("2026-10-10T11:00:00Z"));
  assert.equal(fs.readFileSync(path.join(root, "app", "settings.json"), "utf8"), '{"ui":{"language":"ru"}}');
  assert.equal(fs.existsSync(path.join(root, "sessions", "s2.json")), false);
  assert.equal(fs.existsSync(path.join(root, "backup.json")), false);
  assert.match(fs.readFileSync(path.join(replaced, "app", "settings.json"), "utf8"), /migrated/, "the replaced state is kept aside");
  assert.equal(fs.statSync(path.join(root, "models", "big.gguf")).size, 1024);
  assert.throws(() => restoreDataRoot(root, path.join(os.tmpdir())), /Not a backup/);
});

test("a restore gives back a complete data directory, empty folders included: the server checks its layout at start", { skip: !posix }, (t) => {
  const { root } = dataRoot(t);
  // A new server: no chats yet, and nothing kept in memory.
  fs.rmSync(path.join(root, "sessions", "s1.json"));
  fs.rmSync(path.join(root, "memory", "link"));
  const { directory } = backupDataRoot(root, { label: "before-0.2.0", now: new Date("2026-10-10T10:00:00Z") });
  assert.ok(fs.statSync(path.join(directory, "sessions")).isDirectory(), "the backup keeps the empty folder");
  assert.equal(fs.statSync(path.join(directory, "sessions")).mode & 0o777, 0o700);
  fs.writeFileSync(path.join(root, "sessions", "after.json"), "{}");
  restoreDataRoot(root, directory, new Date("2026-10-10T10:05:00Z"));
  assert.deepEqual(fs.readdirSync(path.join(root, "sessions")), [], "the chat made after the backup is set aside");
  assert.doesNotThrow(() => checkDataRoot(root), "the server's layout check passes");
  // A backup from before folders were kept: the restore still makes them.
  fs.rmSync(path.join(directory, "memory"), { recursive: true });
  fs.rmSync(path.join(directory, "sessions"), { recursive: true });
  restoreDataRoot(root, directory, new Date("2026-10-10T10:06:00Z"));
  assert.doesNotThrow(() => checkDataRoot(root));
});

test("backup, backups and restore from the command line, never while the server runs", { skip: !posix, timeout: 60_000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lc-backup-cli-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "data"), keyFile = path.join(base, "key", "vault.key");
  const env = { PATH: process.env.PATH ?? "", HOME: base, LOCAL_COGNITIVE_SENTRY: "off" };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, "--data-dir", root], { env, encoding: "utf8" });
  assert.equal(run("init", "--vault-key-file", keyFile).status, 0);
  const made = run("backup", "--label", "manual", "--json");
  assert.equal(made.status, 0, made.stderr);
  const name = path.basename(JSON.parse(made.stdout).directory);
  assert.match(run("backups").stdout, new RegExp(name));
  // A running server holds the data root.
  const lock = await DataRootLock.acquire(path.join(root, "app"), "server", "0.1.0");
  const refused = run("backup");
  assert.equal(refused.status, 75);
  assert.match(refused.stderr, /stop it first/);
  lock.release();
  const restored = run("restore", name);
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /Restored/);
  assert.equal(run("restore", "not-a-backup").status, 64);
});
