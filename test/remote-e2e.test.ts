import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { CredentialVault } from "../src/plugins/contracts";
import { RemoteClient, type RemoteStatus } from "../src/remote/client/RemoteClient";

// The whole chain on one machine: the Cloud (in-process, real Postgres), the server daemon
// (child process) and a device client. Needs CLOUD_TEST_DATABASE_URL and the built Cloud.
const repo = path.resolve(__dirname, "..", "..");
const cloudDist = path.join(repo, "apps", "cloud", "dist", "src");
const databaseUrl = process.env.CLOUD_TEST_DATABASE_URL;
const skip = process.platform === "win32" ? "POSIX only" : !databaseUrl ? "set CLOUD_TEST_DATABASE_URL" : !fs.existsSync(path.join(cloudDist, "app.js")) ? "build apps/cloud first" : false;
const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
const cloudModule = (name: string) => importModule(pathToFileURL(path.join(cloudDist, name)).href);
const cli = path.resolve(__dirname, "..", "src", "server", "cli.js");

const memoryVault = (): CredentialVault => {
  const values = new Map<string, string>();
  return { available: () => true, read: async key => values.get(key), write: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } };
};
const until = async <T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

test("a device pairs with a server through the Cloud relay, reconnects without the key and loses access when revoked", { skip, timeout: 120_000 }, async t => {
  const pg = (await importModule("pg")).default;
  const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await importModule("jose");
  const { createApp } = await cloudModule("app.js");
  const { migrate } = await cloudModule("db/migrate.js");
  const { MIGRATIONS_DIR } = await cloudModule("paths.js");
  const { Relay } = await cloudModule("remote/relay.js");
  const { createRemoteRepository } = await cloudModule("remote/remoteRepository.js");
  const { PROFILE_CLAIM_NAMESPACE: ns } = await cloudModule("auth/profileClaims.js");

  const name = `lc_e2e_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl!); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  pool.on("error", () => undefined);
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
  await migrate(pool, MIGRATIONS_DIR);

  const issuer = "https://tenant.example.auth0.com/", audience = "https://api.test";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
  const token = (subject: string) => new SignJWT({ [`${ns}email`]: `${subject}@example.test`, [`${ns}email_verified`]: true })
    .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("10m").sign(privateKey);
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const remoteRepository = createRemoteRepository(pool);
  const relay = new Relay({ repo: remoteRepository, origin });
  server.on("request", createApp({ pool, auth: { issuer, audience, keys }, remote: { repo: remoteRepository, relay } }));
  server.on("upgrade", relay.handleUpgrade);
  t.after(() => new Promise<void>(resolve => { relay.close(); server.closeAllConnections(); server.close(() => resolve()); }));

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lc-e2e-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "d"), keyFile = path.join(base, "k", "vault.key");
  const env = { PATH: process.env.PATH ?? "", HOME: base, LOCAL_COGNITIVE_VAULT_KEY_FILE: keyFile, LOCAL_COGNITIVE_CLOUD_URL: origin, MEMORY_ADAPTER: "local-json", TELEGRAM_ENABLED: "false" };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, "--data-dir", root], { env, encoding: "utf8" });
  assert.equal(run("init", "--vault-key-file", keyFile).status, 0);
  const daemon = spawn(process.execPath, [cli, "start", "--data-dir", root, "--http-port", "0", "--inference", "cpu", "--llama-runtime-dir", path.join(base, "none")],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  daemon.stdout.on("data", chunk => { log += chunk; }); daemon.stderr.on("data", chunk => { log += chunk; });
  t.after(() => { if (daemon.exitCode === null) daemon.kill("SIGKILL"); });
  const remoteState = () => { const result = run("status", "--json"); return result.status === 0 ? JSON.parse(result.stdout).remote?.state : undefined; };
  await until(remoteState, state => state === "online").catch(error => { throw new Error(`${error.message}\n${log}`); });

  const issued = run("connect-key", "--json");
  assert.equal(issued.status, 0, issued.stderr);
  const { key, claimed } = JSON.parse(issued.stdout);
  assert.equal(claimed, false);
  assert.equal(log.includes(key), false, "the key never reaches the service log");

  const account = async (subject: string) => {
    const accessToken = await token(subject);
    const me = await (await fetch(`${origin}/v1/me`, { headers: { authorization: `Bearer ${accessToken}` } })).json() as { accountId: string };
    return { accountId: me.accountId, accessToken };
  };
  const alice = await account("auth0|alice");
  const mac = new RemoteClient({ cloudUrl: origin, vault: memoryVault(), account: async () => alice, deviceName: "Alice's Mac", platform: "macos", backoff: { baseMs: 50, maxMs: 200 } });
  t.after(() => mac.dispose());
  const paired = await mac.pair(key);
  assert.equal(paired.state, "online", JSON.stringify(paired));
  assert.equal((await mac.request<{ version: string }>("host.info")).version.length > 0, true);
  const status = await mac.request<{ phase: string; inference: { backend: string } }>("host.status");
  assert.equal(status.phase, "running");
  assert.equal(JSON.stringify(status).includes(root), false, "no server paths reach the device");

  const devices = JSON.parse(run("devices", "--json").stdout).devices;
  assert.deepEqual(devices.map((device: { deviceName: string; status: string }) => [device.deviceName, device.status]), [["Alice's Mac", "active"]]);
  await until(async () => (await mac.hosts())[0], host => Boolean(host?.paired));

  mac.disconnect();
  const again = await mac.connect(paired.hostId!);
  assert.equal(again.state, "online", JSON.stringify(again));

  const reused = await new RemoteClient({ cloudUrl: origin, vault: memoryVault(), account: async () => alice, deviceName: "Second", platform: "linux" }).pair(key);
  assert.equal(reused.error?.code, "invitation_used");
  const bob = await account("auth0|bob");
  const bobsKey = JSON.parse(run("connect-key", "--json").stdout).key;
  const stranger = await new RemoteClient({ cloudUrl: origin, vault: memoryVault(), account: async () => bob, deviceName: "Bob", platform: "linux" }).pair(bobsKey);
  assert.equal(stranger.error?.code, "host_owned_by_other");

  const revoked = new Promise<RemoteStatus>(resolve => mac.on("change", (next: RemoteStatus) => { if (next.state === "revoked") resolve(next); }));
  await mac.revokeDevice(paired.hostId!, devices[0].deviceId);
  assert.equal((await revoked).state, "revoked");
  assert.equal((await mac.connect(paired.hostId!)).state, "revoked");
  await until(() => JSON.parse(run("devices", "--json").stdout).devices[0].status, value => value === "revoked");

  assert.equal(run("drain", "--json").status, 0);
});
