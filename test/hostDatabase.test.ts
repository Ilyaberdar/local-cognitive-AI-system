import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { DataRootLock, DataRootLockedError } from "../src/runtime/db/DataRootLock";
import { HostDatabase } from "../src/runtime/db/HostDatabase";
import { hostMigrations } from "../src/runtime/db/hostSchema";

const tempDir = (t: TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-db-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const open = (t: TestContext) => {
  const host = HostDatabase.open(path.join(tempDir(t), "host.db"), hostMigrations);
  t.after(() => host.close());
  return host;
};

test("host database migrates once in WAL mode with an owner-only file and a journal epoch", (t) => {
  const file = path.join(tempDir(t), "runtime", "host.db");
  const first = HostDatabase.open(file, hostMigrations);
  const epoch = first.meta("journal_epoch");
  assert.equal(first.schemaVersion(), hostMigrations.length);
  assert.equal(first.db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.match(epoch ?? "", /^[0-9a-f-]{36}$/);
  first.close();
  const second = HostDatabase.open(file, hostMigrations);
  assert.equal(second.db.prepare("SELECT count(*) AS n FROM schema_migrations").get()?.n, hostMigrations.length);
  assert.equal(second.meta("journal_epoch"), epoch);
  second.close();
  assert.throws(() => HostDatabase.open(file, []), /newer than this application/);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("command inbox deduplicates by scope and idempotency key and detects payload conflicts", (t) => {
  const host = open(t);
  const accept = (scope: string, key: string, payload: unknown) => host.transaction(db => {
    const json = JSON.stringify(payload), sha = createHash("sha256").update(json).digest("hex"), now = new Date().toISOString();
    const inserted = db.prepare(`INSERT INTO commands(command_id, scope, idempotency_key, operation, payload_sha256, payload_json, status, accepted_at, updated_at)
      VALUES (?, ?, ?, 'chat.runs.start', ?, ?, 'accepted', ?, ?) ON CONFLICT(scope, idempotency_key) DO NOTHING RETURNING command_id`)
      .get(randomUUID(), scope, key, sha, json, now, now);
    if (inserted) return { status: "accepted", commandId: String(inserted.command_id) };
    const existing = db.prepare("SELECT command_id, payload_sha256 FROM commands WHERE scope = ? AND idempotency_key = ?").get(scope, key)!;
    return { status: existing.payload_sha256 === sha ? "duplicate" : "conflict", commandId: String(existing.command_id) };
  });
  const first = accept("acct:1/dev:1", "k1", { text: "hi" });
  assert.equal(first.status, "accepted");
  assert.deepEqual(accept("acct:1/dev:1", "k1", { text: "hi" }), { status: "duplicate", commandId: first.commandId });
  assert.equal(accept("acct:1/dev:1", "k1", { text: "other" }).status, "conflict");
  assert.equal(accept("acct:1/dev:2", "k1", { text: "hi" }).status, "accepted");
});

test("transactions roll back on error and reject async or nested bodies", (t) => {
  const host = open(t);
  assert.throws(() => host.transaction(db => { db.prepare("INSERT INTO host_meta VALUES ('a', '1')").run(); throw new Error("boom"); }), /boom/);
  assert.throws(() => host.transaction(async () => 1), /synchronous/);
  assert.throws(() => host.transaction(() => host.transaction(() => 1)), /Nested/);
  assert.equal(host.db.prepare("SELECT count(*) AS n FROM host_meta WHERE key = 'a'").get()?.n, 0);
  assert.equal(host.db.isTransaction, false);
});

test("a session has at most one active chat turn", (t) => {
  const host = open(t);
  const now = new Date().toISOString();
  const insert = host.db.prepare("INSERT INTO runs(run_id, kind, session_id, status, created_at, updated_at) VALUES (?, 'chat', 's1', ?, ?, ?)");
  insert.run("r1", "running", now, now);
  assert.throws(() => insert.run("r2", "queued", now, now), (error: { errcode?: number }) => error.errcode === 2067);
  host.db.prepare("UPDATE runs SET status = 'completed' WHERE run_id = 'r1'").run();
  insert.run("r2", "queued", now, now);
});

test("event sequences are allocated per stream inside the writing transaction", (t) => {
  const host = open(t);
  const epoch = host.meta("journal_epoch")!;
  const append = (stream: string, fail = false) => host.transaction(db => {
    const { last_sequence: sequence } = db.prepare(`INSERT INTO event_streams(stream_id, journal_epoch, last_sequence) VALUES (?, ?, 1)
      ON CONFLICT(stream_id) DO UPDATE SET last_sequence = last_sequence + 1 RETURNING last_sequence`).get(stream, epoch)!;
    db.prepare("INSERT INTO events(stream_id, sequence, event_id, type, occurred_at, payload_json) VALUES (?, ?, ?, 'test', ?, '{}')")
      .run(stream, sequence, randomUUID(), new Date().toISOString());
    if (fail) throw new Error("rolled back");
    return Number(sequence);
  });
  assert.deepEqual([append("a"), append("a"), append("b")], [1, 2, 1]);
  assert.throws(() => append("a", true), /rolled back/);
  assert.equal(append("a"), 3);
});

test("the data root lock admits one owner and reports how the previous one stopped", async (t) => {
  const root = tempDir(t);
  const first = await DataRootLock.acquire(root, "test", "0.0.0");
  assert.equal(first.previousShutdown, "none");
  await assert.rejects(DataRootLock.acquire(root, "mcp-stdio", "0.0.0"),
    (error: unknown) => error instanceof DataRootLockedError && error.owner?.pid === process.pid && /already used by test/.test(error.message));
  first.release();
  const second = await DataRootLock.acquire(root, "test", "0.0.0");
  assert.equal(second.previousOwner?.instanceId, first.owner.instanceId);
  assert.equal(second.previousShutdown, "clean");
  second.release();
});

test("a killed owner leaves no stale lock", async (t) => {
  const root = tempDir(t);
  const module = path.resolve(__dirname, "..", "src", "runtime", "db", "DataRootLock.js");
  const child = spawn(process.execPath, ["-e", `require(${JSON.stringify(module)}).DataRootLock.acquire(${JSON.stringify(root)}, "server", "0.0.0")
    .then(() => { process.stdout.write("locked\\n"); setInterval(() => {}, 1000); })`], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("exit", () => reject(new Error("lock holder exited"))); });
  await assert.rejects(DataRootLock.acquire(root, "test", "0.0.0"),
    (error: unknown) => error instanceof DataRootLockedError && error.owner?.pid === child.pid);
  child.kill("SIGKILL");
  const next = await DataRootLock.acquire(root, "test", "0.0.0", { waitMs: 5000 });
  assert.equal(next.previousShutdown, "unclean");
  next.release();
});

test("a second MCP server on the same data directory exits with a clear message", { timeout: 20000 }, async (t) => {
  const root = tempDir(t);
  const env = { PATH: process.env.PATH, APP_DATA_DIR: path.join(root, "app"), SESSION_DIR: path.join(root, "sessions"),
    MEMORY_DIR: path.join(root, "memory"), MEMORY_ADAPTER: "local-json", OUTPUT_DIR: path.join(root, "output"),
    PLUGINS_DIR: path.resolve(process.cwd(), "plugins"), LLAMA_RUNTIME_DIR: path.join(root, "runtime"),
    LOCAL_MODELS_DIR: path.join(root, "models"), LOCAL_COGNITIVE_CONFIG: path.join(root, "absent-config.json"),
    LOCAL_COGNITIVE_ENV_FILE: path.join(root, "absent.env"), MCP_ENABLED: "true", TELEGRAM_ENABLED: "false" };
  const entry = path.resolve(__dirname, "..", "src", "mcp.js");
  const first = spawn(process.execPath, [entry], { cwd: root, env, stdio: ["pipe", "ignore", "pipe"] });
  t.after(() => { if (first.exitCode === null) first.kill("SIGKILL"); });
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    first.stderr!.on("data", (chunk) => { stderr += chunk; if (stderr.includes("MCP stdio transport started")) resolve(); });
    first.once("exit", () => reject(new Error(`first MCP server exited: ${stderr}`)));
  });
  const second = spawn(process.execPath, [entry], { cwd: root, env, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  second.stderr!.on("data", (chunk) => { stderr += chunk; });
  const [code] = await new Promise<[number | null]>((resolve) => second.once("exit", (exitCode) => resolve([exitCode])));
  assert.equal(code, 1);
  assert.match(stderr, /already used by mcp-stdio/);
  assert.match(stderr, /own APP_DATA_DIR/);
});
