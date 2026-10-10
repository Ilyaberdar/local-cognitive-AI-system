import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseServerArgs } from "../src/server/args";
import { describeStatus } from "../src/server/cli";
import { controlSocketPathFor, initDataRoot, readServerConfig } from "../src/server/dataRoot";
import { selectInference } from "../src/server/inference";
import { serverEnvironment } from "../src/server/serverEnv";

const cli = path.resolve(__dirname, "..", "src", "server", "cli.js");
const mcp = path.resolve(__dirname, "..", "src", "mcp.js");
const posix = process.platform !== "win32";

test("arguments are validated per command", () => {
  assert.equal(parseServerArgs(["start", "--data-dir", "/srv/lc", "--inference", "cpu", "--http-port", "0"]).inference, "cpu");
  assert.equal(parseServerArgs(["status"], { LOCAL_COGNITIVE_DATA_DIR: "/srv/lc" }).dataDir, "/srv/lc");
  for (const argv of [["start"], ["start", "--data-dir", "/x", "--inference", "gpu"], ["frob"], ["start", "--data-dir", "/x", "--bogus"], ["start", "--data-dir", "/x", "--http-port", "70000"]]) {
    assert.throws(() => parseServerArgs(argv, {}), (error: { exitCode?: number }) => error.exitCode === 64, argv.join(" "));
  }
});

test("pair waits for the computer unless told not to; connect-key only prints the key", () => {
  assert.equal(parseServerArgs(["pair", "--data-dir", "/srv/lc"]).wait, true);
  assert.equal(parseServerArgs(["pair", "--data-dir", "/srv/lc", "--no-wait", "--ttl", "5"]).wait, false);
  assert.equal(parseServerArgs(["pair", "--data-dir", "/srv/lc", "--ttl", "5"]).ttlMinutes, 5);
  assert.throws(() => parseServerArgs(["pair"], {}), (error: { exitCode?: number }) => error.exitCode === 64);
});

test("status says whether computers can reach the server and what to do next", () => {
  const base = { phase: "running", pid: 7, version: "0.2.0", activeWork: { total: 0 }, inference: { backend: "cuda", active: "CUDA" } };
  const online = describeStatus({ ...base, remote: { state: "online", claimed: true, devices: 2, sessions: 1 } });
  assert.match(online, /^Local Cognitive Server 0\.2\.0 — running$/m);
  assert.match(online, /Remote: +online, 2 computers paired, 1 connected now/);
  assert.match(online, /Inference: +cuda/);
  assert.match(online, /Work: +idle/);
  assert.match(describeStatus({ ...base, remote: { state: "online", claimed: false, devices: 0, sessions: 0 } }), /no owner yet: run pair to connect your computer/);
  assert.match(describeStatus({ ...base, remote: { state: "off", reason: "Remote is turned off (LOCAL_COGNITIVE_REMOTE=off)." } }), /Remote: +off \(Remote is turned off/);
  assert.match(describeStatus({ ...base, remote: { state: "offline", claimed: true, devices: 1, sessions: 0, lastError: "getaddrinfo ENOTFOUND" } }), /Remote: +offline \(getaddrinfo ENOTFOUND\), 1 computer paired/);
  assert.match(describeStatus({ ...base, activeWork: { total: 3 }, update: { available: "0.3.0" } }), /Work: +3 tasks running[\s\S]*Update: +0\.3\.0 is available: sudo local-cognitive-server update/);
});

test("init creates a private layout once and server.json carries no secrets", { skip: !posix }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lcs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o755);
  const first = initDataRoot(root, { inference: "cpu" });
  assert.equal(fs.statSync(root).mode & 0o777, 0o700, "an existing loose directory is tightened");
  for (const name of ["app", "memory", "sessions", "output", "models"]) assert.equal(fs.statSync(path.join(root, name)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, "server.json")).mode & 0o777, 0o600);
  const config = fs.readFileSync(path.join(root, "server.json"));
  assert.deepEqual(initDataRoot(root).created, []);
  assert.deepEqual(fs.readFileSync(path.join(root, "server.json")), config);
  assert.equal(first.config.inference, "cpu");
  fs.writeFileSync(path.join(root, "server.json"), JSON.stringify({ ...first.config, apiKey: "x" }));
  assert.throws(() => readServerConfig(root), (error: { exitCode?: number }) => error.exitCode === 78);
  assert.throws(() => controlSocketPathFor(`/${"x".repeat(120)}`), /longer than/);
});

test("the server environment derives every directory and never serves the UI", () => {
  const root = "/srv/lc";
  const { env, overridden } = serverEnvironment({ root, config: { schemaVersion: 1, createdAt: "", createdByVersion: "", inference: "auto", http: { enabled: true, port: 3000 }, drainTimeoutSec: 120 },
    args: parseServerArgs(["start", "--data-dir", root]), release: "/opt/lc",
    inference: { preference: "auto", backend: "cpu", runtimeDir: "/opt/lc/resources/llama/linux-x64", runtimeId: "linux-x64", fallbackReason: "CUDA is not used." },
    base: { APP_DATA_DIR: "/elsewhere", HOST: "0.0.0.0" } });
  assert.equal(env.APP_DATA_DIR, "/srv/lc/app");
  assert.equal(env.LOCAL_MODELS_DIR, "/srv/lc/models");
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.UI_SERVE, "false");
  assert.equal(env.LOCAL_COGNITIVE_ENV_FILE, "none");
  assert.equal(env.LOCAL_INFERENCE, "auto");
  assert.equal(env.LOCAL_INFERENCE_FALLBACK, "CUDA is not used.");
  assert.equal(env.CUDA_CACHE_PATH, "/srv/lc/app/runtime/cuda-cache", "writable under ProtectSystem=strict");
  assert.deepEqual(overridden.sort(), ["APP_DATA_DIR", "HOST"]);
});

test("the CUDA build is used only when it is prepared for this release", t => {
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "lcs-release-"));
  t.after(() => fs.rmSync(release, { recursive: true, force: true }));
  const llama = path.join(release, "resources", "llama");
  const prepare = (id: string, runtime?: object) => {
    fs.mkdirSync(path.join(llama, id), { recursive: true });
    fs.writeFileSync(path.join(llama, id, "llama-server"), "");
    if (runtime) fs.writeFileSync(path.join(llama, id, "runtime.json"), JSON.stringify(runtime));
  };
  fs.mkdirSync(llama, { recursive: true });
  fs.writeFileSync(path.join(llama, "runtime-manifest.json"), JSON.stringify({ build: "b10809" }));
  prepare("linux-x64", { backend: "cpu", build: "b10809" });
  const select = (preference: "auto" | "cuda" | "cpu", nvidia = true) => selectInference(preference, { release, platform: "linux", arch: "x64", nvidiaDriverPresent: () => nvidia });

  assert.deepEqual({ ...select("auto", false) }, { preference: "auto", backend: "cpu", runtimeDir: path.join(llama, "linux-x64"), runtimeId: "linux-x64" },
    "a host without an NVIDIA driver needs no explanation");
  assert.match(select("auto").fallbackReason ?? "", /CUDA runtime is not installed/);
  assert.throws(() => select("cuda"), (error: { exitCode?: number }) => error.exitCode === 78);

  prepare("linux-x64-cuda12", { id: "linux-x64-cuda12", backend: "cuda", build: "b10000" });
  assert.match(select("auto", false).fallbackReason ?? "", /llama.cpp b10000, but this release uses b10809/, "a stale build is explained even without a driver");
  fs.writeFileSync(path.join(llama, "linux-x64-cuda12", "runtime.json"), JSON.stringify({ id: "linux-x64-cuda12", backend: "cuda", build: "b10809" }));
  assert.deepEqual({ ...select("auto") }, { preference: "auto", backend: "cuda", runtimeDir: path.join(llama, "linux-x64-cuda12"), runtimeId: "linux-x64-cuda12" });
  assert.equal(select("cpu").runtimeId, "linux-x64", "cpu never uses the CUDA build");

  const custom = path.join(release, "custom");
  fs.mkdirSync(custom);
  fs.writeFileSync(path.join(custom, "runtime.json"), JSON.stringify({ backend: "cuda" }));
  assert.equal(selectInference("auto", { release, override: custom }).backend, "cuda", "an override is labelled by its own runtime.json");
  assert.throws(() => selectInference("cpu", { release, override: custom }), (error: { exitCode?: number }) => error.exitCode === 78);
  assert.equal(selectInference("auto", { release, override: path.join(release, "none") }).backend, "cpu");
});

test("init → start → status → MCP bridge → drain, with a second start refused", { skip: !posix, timeout: 60_000 }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcs-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "d"), keyFile = path.join(base, "k", "vault.key");
  // Remote off: with a vault the server would otherwise register itself with the real Cloud.
  const env = { PATH: process.env.PATH ?? "", HOME: base, LOCAL_COGNITIVE_VAULT_KEY_FILE: keyFile, MEMORY_ADAPTER: "local-json", TELEGRAM_ENABLED: "false",
    LOCAL_COGNITIVE_REMOTE: "off", LOCAL_COGNITIVE_SENTRY: "off" };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });

  const init = run("init", "--data-dir", root, "--vault-key-file", keyFile, "--json");
  assert.equal(init.status, 0, init.stderr);
  assert.match(JSON.parse(init.stdout).vaultKeyId, /^[0-9a-f]{16}$/);

  const server = spawn(process.execPath, [cli, "start", "--data-dir", root, "--http-port", "0", "--inference", "cpu", "--llama-runtime-dir", path.join(base, "none")],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", chunk => { log += chunk; }); server.stderr.on("data", chunk => { log += chunk; });
  const exited = new Promise<number | null>(resolve => server.once("exit", resolve));
  t.after(() => { if (server.exitCode === null) server.kill("SIGKILL"); });

  let status: { running?: boolean; phase?: string; http?: { port: number }; ui?: boolean; scheduler?: boolean; vault?: { configured: boolean } } = {};
  for (let attempt = 0; attempt < 120 && !status.running; attempt++) {
    const result = run("status", "--data-dir", root, "--json");
    if (result.status === 0) status = JSON.parse(result.stdout);
    else await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(status.running, true, log);
  assert.equal(status.phase, "running");
  assert.equal(status.scheduler, true);
  assert.equal(status.ui, false);
  assert.equal(status.vault?.configured, true);
  const health = await fetch(`http://127.0.0.1:${status.http!.port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${status.http!.port}/`)).status, 404, "the server serves no UI");

  // Someone other than the server's user is refused by the system: the CLI says to use sudo.
  const runtimeDir = path.join(root, "app", "runtime");
  fs.chmodSync(runtimeDir, 0o000);
  try {
    const denied = run("status", "--data-dir", root);
    assert.equal(denied.status, 78, denied.stderr);
    assert.match(denied.stderr, /^Permission denied: the server's files belong to its user\. Run: sudo local-cognitive-server status$/m);
    assert.doesNotMatch(denied.stderr, /\bat \S+ \(/, "no stack trace");
  } finally { fs.chmodSync(runtimeDir, 0o700); }

  const second = run("start", "--data-dir", root, "--http-port", "0", "--inference", "cpu", "--llama-runtime-dir", path.join(base, "none"));
  assert.equal(second.status, 75, second.stderr);
  assert.match(second.stderr, /already used by server/);

  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp], cwd: base, stderr: "pipe",
    env: { ...env, APP_DATA_DIR: path.join(root, "app"), LOCAL_COGNITIVE_ENV_FILE: "none", MCP_ENABLED: "true" } });
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  await client.connect(transport, { timeout: 10_000 });
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes("local_ai_runtime_status"), tools.join(","));
  await client.close();

  const drain = run("drain", "--data-dir", root, "--json");
  assert.equal(drain.status, 0, drain.stderr);
  assert.equal(JSON.parse(drain.stdout).drained, true);
  assert.equal(await exited, 0, log);
  assert.equal(fs.existsSync(path.join(root, "app", "runtime", "data-root.owner.json")), false, "the lock is released");
  assert.equal(run("status", "--data-dir", root).status, 3);
});

test("folders: an admin shares, lists and stops sharing folders for connected computers", t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lc-folders-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "data"), keyFile = path.join(base, "key", "vault.key"), shared = path.join(base, "shared");
  fs.mkdirSync(shared);
  const env = { PATH: process.env.PATH ?? "", HOME: base, LOCAL_COGNITIVE_SENTRY: "off" };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, "--data-dir", root], { env, encoding: "utf8" });
  assert.equal(run("init", "--vault-key-file", keyFile).status, 0);
  assert.match(run("folders").stdout, /No folders are shared/);
  const added = run("folders", "add", shared, "--label", "Work", "--allow-create", "--json");
  assert.equal(added.status, 0, added.stderr);
  const folder = JSON.parse(added.stdout) as { id: string; path: string; label: string; allowCreate: boolean };
  assert.deepEqual([folder.path, folder.label, folder.allowCreate], [shared, "Work", true]);
  assert.match(run("folders", "list").stdout, new RegExp(`${folder.id}  Work  ${shared.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const refused = run("folders", "add", root);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /data directory/);
  assert.notEqual(run("folders", "add").status, 0, "a path is required");
  assert.equal(run("folders", "remove", folder.id).status, 0);
  assert.equal(run("folders", "remove", folder.id).status, 1);
});

test("data of a newer version stops the server with exit 78 (systemd does not restart it) and says what to do", { skip: !posix, timeout: 60_000 }, t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lcs-newer-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "data"), keyFile = path.join(base, "key", "vault.key");
  const env = { PATH: process.env.PATH ?? "", HOME: base, LOCAL_COGNITIVE_VAULT_KEY_FILE: keyFile, MEMORY_ADAPTER: "local-json", TELEGRAM_ENABLED: "false",
    LOCAL_COGNITIVE_REMOTE: "off", LOCAL_COGNITIVE_SENTRY: "off" };
  assert.equal(spawnSync(process.execPath, [cli, "init", "--data-dir", root, "--vault-key-file", keyFile], { env, encoding: "utf8" }).status, 0);
  // host.db as a later version left it.
  const runtime = path.join(root, "app", "runtime");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(path.join(runtime, "host.db"));
  db.exec("PRAGMA user_version = 99");
  db.close();
  const started = spawnSync(process.execPath, [cli, "start", "--data-dir", root, "--http-port", "0", "--inference", "cpu", "--llama-runtime-dir", path.join(base, "none")],
    { env, encoding: "utf8", timeout: 45_000 });
  assert.equal(started.status, 78, started.stderr);
  assert.match(started.stderr, /newer than this application[\s\S]*restore the backup made before updating/);
});
