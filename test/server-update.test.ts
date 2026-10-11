import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { keyIdOf, MANIFEST_SIGNATURE_CONTEXT, type ReleaseKey } from "../src/update/manifest";
import { adoptRelease, fetchBytes, linkedRelease, pointLink, releasesDir, updateServer, UpdateError, type ReleaseRunner, type ServiceControl } from "../src/update/serverUpdate";

const posix = process.platform !== "win32";
const dataBackup = path.resolve(__dirname, "..", "src", "update", "dataBackup.js");

/** A release whose CLI answers version, backup and restore; BROKEN makes it fail to start, and
 * noRestore makes its restore fail. */
const releaseTree = (dir: string, version: string, options: { broken?: boolean; link?: boolean; noRestore?: boolean } = {}) => {
  fs.mkdirSync(path.join(dir, "node", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node", "bin", "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, "dist", "src", "server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "src", "server", "cli.js"), `
const path = require("path"), backup = require(${JSON.stringify(dataBackup)});
const [command, ...rest] = process.argv.slice(2), option = name => rest[rest.indexOf(name) + 1];
if (command === "version") { console.log(${JSON.stringify(version)}); process.exit(0); }
if (command === "backup") { console.log(JSON.stringify(backup.backupDataRoot(option("--data-dir"), { label: option("--label") }))); process.exit(0); }
if (command === "restore") { ${options.noRestore ? "process.exit(70);" : ""} console.log(JSON.stringify(backup.restoreDataRoot(option("--data-dir"), path.join(option("--data-dir"), "backups", rest[0])))); process.exit(0); }
process.exit(64);`);
  if (options.broken) fs.writeFileSync(path.join(dir, "BROKEN"), "");
  if (options.link) fs.symlinkSync("/etc/hosts", path.join(dir, "hosts"));
};

const runner: ReleaseRunner = {
  run: (release, args) => new Promise(resolve => {
    const child = spawn(path.join(release, "node", "bin", "node"), [path.join(release, "dist", "src", "server", "cli.js"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => resolve({ status: status ?? 1, stdout, stderr }));
  })
};

async function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lc-update-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const prefix = path.join(base, "opt"), dataDir = path.join(base, "data");
  fs.mkdirSync(path.join(dataDir, "app"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "app", "settings.json"), '{"schema":"0.1.0"}', { mode: 0o600 });
  // The running release, adopted: releases/0.1.0 and current.
  releaseTree(path.join(releasesDir(prefix), "0.1.0"), "0.1.0");
  pointLink(prefix, "current", "0.1.0");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const keys: ReleaseKey[] = [{ id: keyIdOf(raw), publicKey: raw.toString("base64url") }];
  const files = new Map<string, Buffer>();
  const publish = (version: string, options: { broken?: boolean; link?: boolean; tamper?: boolean; noRestore?: boolean } = {}) => {
    const tree = path.join(base, `tree-${version}`);
    releaseTree(tree, version, options);
    const tarball = path.join(base, `server-${version}.tar.gz`);
    execFileSync("tar", ["-czf", tarball, "-C", tree, "."]);
    const bytes = fs.readFileSync(tarball);
    const url = `https://releases.example/server-${version}.tar.gz`;
    // A changed byte (same size): only the digest can tell.
    files.set(url, options.tamper ? Buffer.concat([bytes.subarray(0, -1), Buffer.from([bytes.at(-1)! ^ 0xff])]) : bytes);
    const manifest = Buffer.from(JSON.stringify({ schema: 1, product: "local-cognitive-server", version, channel: "stable", releasedAt: "2026-10-10T00:00:00Z",
      protocol: { min: 1, max: 1 }, hostDbSchema: 3, node: "22.23.3", notes: `Release ${version}.`,
      artifacts: [{ platform: process.platform, arch: process.arch, url, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] }));
    files.set("https://releases.example/server-manifest.json", manifest);
    files.set("https://releases.example/server-manifest.json.sig", Buffer.from(JSON.stringify({ keyId: keys[0]!.id,
      signature: sign(null, Buffer.concat([Buffer.from(MANIFEST_SIGNATURE_CONTEXT), Buffer.from([0]), manifest]), privateKey).toString("base64url") })));
  };
  const fetchImpl = (async (url: string) => files.has(url) ? new Response(new Uint8Array(files.get(url)!)) : new Response("missing", { status: 404 })) as typeof fetch;
  // The service: starting a release "migrates" the data to its version; a broken one exits.
  const service = { running: true, version: "0.1.0", busy: 0, stops: 0, units: [] as string[] };
  const control: ServiceControl = {
    stop: async () => { service.running = false; service.stops++; },
    start: async () => {
      const version = linkedRelease(prefix, "current")!;
      fs.writeFileSync(path.join(dataDir, "app", `started-${version}`), "");
      if (fs.existsSync(path.join(releasesDir(prefix), version, "BROKEN"))) { fs.writeFileSync(path.join(dataDir, "app", "settings.json"), `{"schema":"${version}"}`); service.running = false; return; }
      fs.writeFileSync(path.join(dataDir, "app", "settings.json"), `{"schema":"${version}"}`);
      service.running = true; service.version = version;
    },
    activeWork: async () => service.busy,
    healthy: async version => service.running && service.version === version ? { ok: true } : { ok: false, reason: "it exited" },
    // The unit of the release the service starts next, while it is stopped.
    useUnitOf: async release => { assert.equal(service.running, false); service.units.push(path.basename(release)); return false; }
  };
  const options = (currentVersion: string, extra: Record<string, unknown> = {}) => ({ prefix, dataDir, manifestUrl: "https://releases.example/server-manifest.json", keys,
    currentVersion, service: control, runner, fetchImpl, healthTimeoutMs: 1000, ...extra });
  return { prefix, dataDir, publish, service, options, settings: () => fs.readFileSync(path.join(dataDir, "app", "settings.json"), "utf8") };
}

test("an update installs the newer release beside the old one, backs the data up, switches and keeps the old one as previous", { skip: !posix }, async t => {
  const f = await fixture(t);
  f.publish("0.1.0");
  assert.deepEqual(await updateServer(f.options("0.1.0")), { updated: false }, "the same version is no update");
  f.publish("0.2.0");
  const result = await updateServer(f.options("0.1.0"));
  assert.equal(result.updated, true);
  assert.equal(linkedRelease(f.prefix, "current"), "0.2.0");
  assert.equal(linkedRelease(f.prefix, "previous"), "0.1.0");
  assert.equal(f.settings(), '{"schema":"0.2.0"}');
  const backup = (result as { backup: string }).backup;
  assert.equal(fs.readFileSync(path.join(backup, "app", "settings.json"), "utf8"), '{"schema":"0.1.0"}', "the backup holds the data from before");
  assert.equal(fs.existsSync(path.join(backup, "models")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.prefix, "update.json"), "utf8")).state, "done");
  assert.deepEqual(f.service.units, ["0.2.0"], "the new release starts with its own unit");
});

test("a release that does not start is rolled back: the old code and the data from before the update", { skip: !posix }, async t => {
  const f = await fixture(t);
  f.publish("0.2.0", { broken: true });
  await assert.rejects(updateServer(f.options("0.1.0")), (error: unknown) => error instanceof UpdateError && error.code === "rolled_back");
  assert.equal(linkedRelease(f.prefix, "current"), "0.1.0");
  assert.equal(f.settings(), '{"schema":"0.1.0"}', "the migrated data was put back");
  assert.equal(f.service.running && f.service.version, "0.1.0");
  const journal = JSON.parse(fs.readFileSync(path.join(f.prefix, "update.json"), "utf8"));
  assert.equal(journal.state, "rolled_back");
  assert.ok(fs.readdirSync(path.join(f.dataDir, "backups")).some(name => name.endsWith("-replaced")), "the failed state is kept aside");
  assert.deepEqual(f.service.units, ["0.2.0", "0.1.0"], "the old release starts with its own unit again");
});

test("when the failed release cannot even restore the data, the previous release restores it", { skip: !posix }, async t => {
  const f = await fixture(t);
  f.publish("0.2.0", { broken: true, noRestore: true });
  await assert.rejects(updateServer(f.options("0.1.0")), (error: unknown) => error instanceof UpdateError && error.code === "rolled_back");
  assert.equal(linkedRelease(f.prefix, "current"), "0.1.0");
  assert.equal(fs.existsSync(path.join(f.dataDir, "app", "started-0.2.0")), false, "the state the failed release left is put aside");
  assert.ok(fs.readdirSync(path.join(f.dataDir, "backups")).some(name => name.endsWith("-replaced")));
});

test("adopt makes an install in place the first release, once, and refuses an app folder with its own Node", { skip: !posix }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lc-adopt-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const prefix = path.join(base, "opt"), app = path.join(prefix, "app"), node = path.join(prefix, "node");
  fs.mkdirSync(path.join(app, "dist"), { recursive: true });
  fs.mkdirSync(path.join(node, "bin"), { recursive: true });
  fs.writeFileSync(path.join(node, "bin", "node"), "", { mode: 0o755 });
  assert.throws(() => adoptRelease({ prefix, fromApp: app, fromNode: node }), /release version/);
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "local-cognitive-ai-system", version: "0.1.0" }));
  fs.mkdirSync(path.join(app, "node"));
  assert.throws(() => adoptRelease({ prefix, fromApp: app, fromNode: node }), /node folder/);
  fs.rmdirSync(path.join(app, "node"));
  assert.equal(adoptRelease({ prefix, fromApp: app, fromNode: node }), "0.1.0");
  assert.equal(linkedRelease(prefix, "current"), "0.1.0");
  assert.ok(fs.existsSync(path.join(releasesDir(prefix), "0.1.0", "node", "bin", "node")));
  assert.equal(fs.existsSync(path.join(releasesDir(prefix), "0.1.0", "node", "node")), false);
  assert.ok(fs.existsSync(path.join(app, "package.json")), "the old folders are left");
  assert.throws(() => adoptRelease({ prefix, fromApp: app, fromNode: node }), /already points/);
});

test("nothing is stopped for a changed download, a link in the release, a wrong signature or a busy server", { skip: !posix }, async t => {
  const f = await fixture(t);
  f.publish("0.2.0", { tamper: true });
  await assert.rejects(updateServer(f.options("0.1.0")), (error: unknown) => error instanceof UpdateError && error.code === "checksum_mismatch");
  f.publish("0.2.1", { link: true });
  await assert.rejects(updateServer(f.options("0.1.0")), (error: unknown) => error instanceof UpdateError && error.code === "unsafe_archive");
  f.publish("0.2.2");
  const otherKey = generateKeyPairSync("ed25519").publicKey;
  const raw = Buffer.from(otherKey.export({ format: "jwk" }).x!, "base64url");
  await assert.rejects(updateServer({ ...f.options("0.1.0"), keys: [{ id: keyIdOf(raw), publicKey: raw.toString("base64url") }] }), /does not trust/);
  f.service.busy = 2;
  await assert.rejects(updateServer(f.options("0.1.0")), (error: unknown) => error instanceof UpdateError && error.code === "busy");
  assert.equal(f.service.stops, 0, "the server was never stopped");
  assert.equal(linkedRelease(f.prefix, "current"), "0.1.0");
  assert.equal(f.settings(), '{"schema":"0.1.0"}');
});

test("update from the command line: --check only looks; installing needs root; a foreign signature is refused; nothing published is no update", { skip: !posix || process.getuid?.() === 0, timeout: 60_000 }, async t => {
  const { parseServerArgs } = await import("../src/server/args");
  const parsed = parseServerArgs(["update", "--check", "--data-dir", "/srv/lc", "--manifest-url", "https://example/m.json"], {});
  assert.deepEqual({ ...parsed.update }, { check: true, wait: false, manifestUrl: "https://example/m.json", prefix: "/opt/local-cognitive", unit: "local-cognitive", user: "local-cognitive" });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lc-update-cli-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "data"), keyFile = path.join(base, "key", "vault.key");
  const cli = path.resolve(__dirname, "..", "src", "server", "cli.js");
  const env = { PATH: process.env.PATH ?? "", HOME: base, LOCAL_COGNITIVE_SENTRY: "off" };
  const run = (...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [cli, ...args, "--data-dir", root], { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
  assert.equal((await run("init", "--vault-key-file", keyFile)).status, 0);
  for (const command of ["update", "rollback", "adopt"]) {
    const refused = await run(command, "--yes");
    assert.equal(refused.status, 78, command);
    assert.match(refused.stderr, /as root/);
  }
  // A manifest on loopback that this build's release key did not sign; then nothing published at all.
  const http = await import("node:http");
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith("/none/")) { response.statusCode = 404; response.end(); return; }
    response.end(JSON.stringify({ schema: 1 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const check = await run("update", "--check", "--manifest-url", `http://127.0.0.1:${port}/server-manifest.json`);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /does not trust/);
  const none = await run("update", "--check", "--manifest-url", `http://127.0.0.1:${port}/none/server-manifest.json`);
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stderr, /No server release is published yet\./);
  assert.equal((await run("update", "--check", "--manifest-url", "http://releases.example/m.json")).status, 64, "only https away from loopback");
});

test("a slow download takes as long as it needs; one that stops sending is given up", async () => {
  // Like fetch: the body arrives in pieces, and aborting the request errors the body with the reason.
  const serve = (pieces: number, gapMs: number, stopAfter = Infinity) => (async (_url: string, init?: RequestInit) => {
    const signal = init!.signal!;
    let cancelled = false;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        void (async () => {
          for (let index = 0; index < Math.min(pieces, stopAfter); index++) {
            await new Promise(resolve => setTimeout(resolve, gapMs));
            if (signal.aborted || cancelled) return;
            controller.enqueue(new Uint8Array([index]));
          }
          if (stopAfter >= pieces) controller.close();
        })();
      },
      cancel() { cancelled = true; }
    }));
  }) as typeof fetch;
  // Ten pieces 50 ms apart: half a second in all, longer than the 400 ms without data that ends a download.
  assert.deepEqual([...await fetchBytes(serve(10, 50), "https://releases.example/slow", 1024, 400)], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const stopped = (error: unknown) => error instanceof UpdateError && error.code === "download_failed" && /nothing arrived/.test(error.message);
  await assert.rejects(fetchBytes(serve(10, 50, 2), "https://releases.example/stalls", 1024, 400), stopped);
  const silent = (async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) =>
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }))) as typeof fetch;
  await assert.rejects(fetchBytes(silent, "https://releases.example/silent", 1024, 400), stopped);
  await assert.rejects(fetchBytes(serve(10, 1), "https://releases.example/large", 3, 400), /larger than expected/);
});

// A CUDA runtime prepared on this host lives only in the release it was prepared for: updates carry it.
const cudaRuntime = (release: string, links: Record<string, string>) => {
  const runtime = path.join(release, "resources", "llama", "linux-x64-cuda12");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "libllama-common.so.0.4.0"), "common");
  fs.writeFileSync(path.join(runtime, "libggml.so.0.23.0"), "ggml");
  fs.writeFileSync(path.join(runtime, "llama-server"), "#!/bin/sh\n", { mode: 0o755 });
  for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(runtime, name));
  return runtime;
};

test("an update carries the CUDA runtime with its relative library links, so pruning the old release keeps it loading", { skip: !posix }, async t => {
  const f = await fixture(t);
  cudaRuntime(path.join(releasesDir(f.prefix), "0.1.0"), { "libllama-common.so.0": "libllama-common.so.0.4.0", "libllama-common.so": "libllama-common.so.0", "libggml.so.0": "libggml.so.0.23.0" });
  f.publish("0.2.0");
  assert.equal((await updateServer(f.options("0.1.0"))).updated, true);
  const carried = path.join(releasesDir(f.prefix), "0.2.0", "resources", "llama", "linux-x64-cuda12");
  assert.equal(fs.readlinkSync(path.join(carried, "libllama-common.so.0")), "libllama-common.so.0.4.0");
  assert.equal(fs.readlinkSync(path.join(carried, "libllama-common.so")), "libllama-common.so.0");
  fs.rmSync(path.join(releasesDir(f.prefix), "0.1.0"), { recursive: true });
  assert.equal(fs.readFileSync(path.join(carried, "libllama-common.so"), "utf8"), "common", "the old release is gone and the libraries still load");
});

test("an update repairs library links an older update wrote as absolute paths into a release that is gone", { skip: !posix }, async t => {
  const f = await fixture(t);
  const gone = path.join(releasesDir(f.prefix), "0.0.9", "resources", "llama", "linux-x64-cuda12");
  cudaRuntime(path.join(releasesDir(f.prefix), "0.1.0"), { "libllama-common.so.0": path.join(gone, "libllama-common.so.0.4.0"), "libggml.so.0": path.join(gone, "libggml.so.0.23.0") });
  const lines: string[] = [];
  f.publish("0.2.0");
  assert.equal((await updateServer(f.options("0.1.0", { log: (line: string) => lines.push(line) }))).updated, true);
  const carried = path.join(releasesDir(f.prefix), "0.2.0", "resources", "llama", "linux-x64-cuda12");
  assert.equal(fs.readlinkSync(path.join(carried, "libllama-common.so.0")), "libllama-common.so.0.4.0");
  assert.equal(fs.readFileSync(path.join(carried, "libggml.so.0"), "utf8"), "ggml");
  assert.ok(lines.some(line => line.includes("Repaired 2 library links of the linux-x64-cuda12 runtime")), lines.join("\n"));
});

test("a runtime whose links cannot be repaired is left behind with a reason, instead of failing every chat", { skip: !posix }, async t => {
  const f = await fixture(t);
  cudaRuntime(path.join(releasesDir(f.prefix), "0.1.0"), { "libmtmd.so.0": "/opt/elsewhere/libmtmd.so.0.4.0" });
  const lines: string[] = [];
  f.publish("0.2.0");
  assert.equal((await updateServer(f.options("0.1.0", { log: (line: string) => lines.push(line) }))).updated, true);
  assert.equal(fs.existsSync(path.join(releasesDir(f.prefix), "0.2.0", "resources", "llama", "linux-x64-cuda12")), false);
  assert.ok(lines.some(line => line.includes("libmtmd.so.0 point nowhere") && line.includes("local-cognitive-server cuda")), lines.join("\n"));
});
