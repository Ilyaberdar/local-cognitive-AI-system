import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { CredentialVault } from "../../src/plugins/contracts";

// Cloud (in-process, real Postgres), server daemon (child process) and device clients on one
// machine. Needs CLOUD_TEST_DATABASE_URL and the built Cloud (apps/cloud/dist).
const repo = path.resolve(__dirname, "..", "..", "..");
const cloudDist = path.join(repo, "apps", "cloud", "dist", "src");
const databaseUrl = process.env.CLOUD_TEST_DATABASE_URL;
export const remoteStackSkip = process.platform === "win32" ? "POSIX only" : !databaseUrl ? "set CLOUD_TEST_DATABASE_URL"
  : !fs.existsSync(path.join(cloudDist, "app.js")) ? "build apps/cloud first" : false;
const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
const cloudModule = (name: string) => importModule(pathToFileURL(path.join(cloudDist, name)).href);
const cli = path.resolve(__dirname, "..", "..", "src", "server", "cli.js");

export const memoryVault = (): CredentialVault => {
  const values = new Map<string, string>();
  return { available: () => true, read: async key => values.get(key), write: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } };
};
export const until = async <T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

export async function startCloud(t: TestContext) {
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
  const token = (subject: string): Promise<string> => new SignJWT({ [`${ns}email`]: `${subject}@example.test`, [`${ns}email_verified`]: true })
    .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("10m").sign(privateKey);
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const repository = createRemoteRepository(pool);
  const relay = new Relay({ repo: repository, origin });
  server.on("request", createApp({ pool, auth: { issuer, audience, keys }, remote: { repo: repository, relay } }));
  server.on("upgrade", relay.handleUpgrade);
  t.after(() => new Promise<void>(resolve => { relay.close(); server.closeAllConnections(); server.close(() => resolve()); }));
  const account = async (subject: string) => {
    const accessToken = await token(subject);
    const me = await (await fetch(`${origin}/v1/me`, { headers: { authorization: `Bearer ${accessToken}` } })).json() as { accountId: string };
    return { accountId: me.accountId, accessToken };
  };
  return { origin, account };
}

/** A daemon on its own data directory; `restart` kills it (optionally with SIGKILL) and starts it again. */
export async function startDaemon(t: TestContext, origin: string, extraEnv: Record<string, string> = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lc-e2e-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "d"), keyFile = path.join(base, "k", "vault.key");
  const env = { PATH: process.env.PATH ?? "", HOME: base, LOCAL_COGNITIVE_VAULT_KEY_FILE: keyFile, LOCAL_COGNITIVE_CLOUD_URL: origin, MEMORY_ADAPTER: "local-json",
    TELEGRAM_ENABLED: "false", ...extraEnv };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, "--data-dir", root], { env, encoding: "utf8" });
  assert.equal(run("init", "--vault-key-file", keyFile).status, 0);
  let daemon: ChildProcess | undefined, log = "";
  const launch = async () => {
    daemon = spawn(process.execPath, [cli, "start", "--data-dir", root, "--http-port", "0", "--inference", "cpu", "--llama-runtime-dir", path.join(base, "none")],
      { env, stdio: ["ignore", "pipe", "pipe"] });
    daemon.stdout!.on("data", chunk => { log += chunk; }); daemon.stderr!.on("data", chunk => { log += chunk; });
    await until(remoteState, state => state === "online").catch(error => { throw new Error(`${error.message}\n${log}`); });
  };
  const remoteState = () => { const result = run("status", "--json"); return result.status === 0 ? JSON.parse(result.stdout).remote?.state : undefined; };
  t.after(() => { if (daemon && daemon.exitCode === null) daemon.kill("SIGKILL"); });
  await launch();
  return {
    root, run, log: () => log,
    connectKey: (): string => { const issued = run("connect-key", "--json"); assert.equal(issued.status, 0, issued.stderr); return JSON.parse(issued.stdout).key; },
    async restart(signal: NodeJS.Signals = "SIGTERM") {
      const exited = new Promise(resolve => daemon!.once("exit", resolve));
      daemon!.kill(signal);
      await exited;
      await launch();
    }
  };
}

/** An OpenAI-compatible model whose answers (`state.answer`) wait for `release()` while `held` is true. */
export async function startStubModel(t: TestContext, answer = "Paris is the capital of France.") {
  const state = { held: false, requests: 0, aborted: 0, waiting: [] as Array<() => void>, authorizations: [] as string[], bodies: [] as string[], answer };
  const server = http.createServer((request, response) => {
    if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      state.requests++;
      state.authorizations.push(String(request.headers.authorization ?? ""));
      state.bodies.push(body);
      let answered = false;
      const reply = () => {
        if (answered || response.destroyed) return;
        answered = true;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: `resp-${state.requests}`, choices: [{ message: { role: "assistant", content: state.answer }, finish_reason: "stop" }],
          output_text: state.answer, usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, input_tokens: 5, output_tokens: 7 } }));
      };
      response.once("close", () => { if (!answered) state.aborted++; });
      if (state.held) state.waiting.push(reply); else reply();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return {
    state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    hold() { state.held = true; },
    release() { state.held = false; for (const reply of state.waiting.splice(0)) reply(); }
  };
}
