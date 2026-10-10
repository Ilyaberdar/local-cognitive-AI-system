import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { keyIdOf, MANIFEST_SIGNATURE_CONTEXT, type ReleaseKey } from "../src/update/manifest";
import { linkedRelease, pointLink, releasesDir, updateServer, UpdateError, type ReleaseRunner, type ServiceControl } from "../src/update/serverUpdate";

const posix = process.platform !== "win32";
const dataBackup = path.resolve(__dirname, "..", "src", "update", "dataBackup.js");

/** A release whose CLI answers version, backup and restore; BROKEN makes it fail to start. */
const releaseTree = (dir: string, version: string, options: { broken?: boolean; link?: boolean } = {}) => {
  fs.mkdirSync(path.join(dir, "node", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node", "bin", "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, "dist", "src", "server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "src", "server", "cli.js"), `
const path = require("path"), backup = require(${JSON.stringify(dataBackup)});
const [command, ...rest] = process.argv.slice(2), option = name => rest[rest.indexOf(name) + 1];
if (command === "version") { console.log(${JSON.stringify(version)}); process.exit(0); }
if (command === "backup") { console.log(JSON.stringify(backup.backupDataRoot(option("--data-dir"), { label: option("--label") }))); process.exit(0); }
if (command === "restore") { console.log(JSON.stringify(backup.restoreDataRoot(option("--data-dir"), path.join(option("--data-dir"), "backups", rest[0])))); process.exit(0); }
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
  const publish = (version: string, options: { broken?: boolean; link?: boolean; tamper?: boolean } = {}) => {
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
  const service = { running: true, version: "0.1.0", busy: 0, stops: 0 };
  const control: ServiceControl = {
    stop: async () => { service.running = false; service.stops++; },
    start: async () => {
      const version = linkedRelease(prefix, "current")!;
      if (fs.existsSync(path.join(releasesDir(prefix), version, "BROKEN"))) { fs.writeFileSync(path.join(dataDir, "app", "settings.json"), `{"schema":"${version}"}`); service.running = false; return; }
      fs.writeFileSync(path.join(dataDir, "app", "settings.json"), `{"schema":"${version}"}`);
      service.running = true; service.version = version;
    },
    activeWork: async () => service.busy,
    healthy: async version => service.running && service.version === version ? { ok: true } : { ok: false, reason: "it exited" }
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

test("update from the command line: --check only looks; installing needs root; no trusted key, no update", { skip: !posix || process.getuid?.() === 0, timeout: 60_000 }, async t => {
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
  // A manifest on loopback: this build trusts no release key yet.
  const http = await import("node:http");
  const server = http.createServer((_request, response) => { response.end(JSON.stringify({ schema: 1 })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const check = await run("update", "--check", "--manifest-url", `http://127.0.0.1:${port}/server-manifest.json`);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /no release key/);
  assert.equal((await run("update", "--check", "--manifest-url", "http://releases.example/m.json")).status, 64, "only https away from loopback");
});
