import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createApiToken, createLocalApiAuth, sourceRunApiToken, writeApiTokenFile } from "../src/api/localApiAuth";
import { AppConfig, config } from "../src/config/config";
import { startBackend } from "../src/index";
import { emptyMcpConfiguration } from "../src/mcp/client/configuration";

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }
const request = (port: number, method: string, target: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const outgoing = http.request({ host: "127.0.0.1", port, method, path: target, headers }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });

/** The whole backend as the app and `npm start` run it, with its UI served from a folder of the test. */
async function backend(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lc-api-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const publicDir = path.join(root, "public");
  fs.mkdirSync(path.join(publicDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(publicDir, "index.html"), "<!doctype html><title>Local Cognitive</title>");
  fs.writeFileSync(path.join(publicDir, "assets", "app.js"), "export {};\n");
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, value]) => [id, { ...value, enabled: false, apiKey: "" }])) as AppConfig["providers"];
  const options: AppConfig = {
    ...config, providers, compatibleProviders: {}, appDataDir: path.join(root, "app"), outputDir: path.join(root, "output"),
    sessions: { baseDir: path.join(root, "sessions") }, memory: { ...config.memory, adapter: "local-json", baseDir: path.join(root, "memory") },
    mcp: { client: emptyMcpConfiguration(), server: { ...config.mcp.server, enabled: false } },
    plugins: { dir: path.resolve(process.cwd(), "plugins"), overrides: {} }, telegram: { ...config.telegram, enabled: false, botToken: "" },
    server: { enabled: true, host: "127.0.0.1", port: 0 }, ui: { publicDir, serve: true },
    localModels: { ...config.localModels!, runtimeDir: path.join(root, "runtime"), executablePath: undefined, modelsDir: path.join(root, "models"), contextSize: 4096 }
  };
  const token = createApiToken(), tokenFile = path.join(root, "app", "runtime", "api-token");
  const handle = await startBackend(options, {}, { runtimeKind: "test", apiToken: token, apiTokenFile: tokenFile });
  let disposed = false;
  const dispose = async () => { if (!disposed) { disposed = true; await handle.dispose(); } };
  t.after(dispose);
  return { token, tokenFile, port: handle.status().http!.port, status: handle.status, dispose };
}

test("this computer's API answers only requests with the launch's key, static files and unknown paths included", { timeout: 60_000 }, async t => {
  const { token, tokenFile, port, status, dispose } = await backend(t);
  const replies: Reply[] = [];
  const call = async (method: string, target: string, headers: Record<string, string> = {}, body?: string) => {
    const reply = await request(port, method, target, headers, body); replies.push(reply); return reply;
  };
  const bearer = { Authorization: `Bearer ${token}` };
  const refused = (reply: Reply, label: string) => {
    assert.equal(reply.status, 401, label);
    assert.deepEqual(JSON.parse(reply.body), { error: "This computer's API needs the app's key.", code: "api_token_required" }, label);
    assert.equal(reply.headers["www-authenticate"], 'Bearer realm="Local Cognitive"', label);
    assert.equal(reply.headers["cache-control"], "no-store", label);
    assert.equal(reply.headers["set-cookie"], undefined, label);
  };
  const wrong = createApiToken();
  for (const [method, target] of [["GET", "/app/settings"], ["GET", "/dashboard/bootstrap"], ["GET", "/"], ["GET", "/index.html"], ["GET", "/assets/app.js"],
    ["GET", "/no-such-page"], ["OPTIONS", "/app/settings"], ["POST", "/health"]] as const) {
    refused(await call(method, target), `${method} ${target} without a key`);
    refused(await call(method, target, { Authorization: `Bearer ${wrong}` }), `${method} ${target} with another key`);
  }
  assert.equal((await call("HEAD", "/assets/app.js")).status, 401);
  const write = { "Content-Type": "application/json", "X-Local-Cognitive": "1" };
  refused(await call("POST", "/sessions", write, JSON.stringify({ title: "x" })), "a write without a key");
  refused(await call("PUT", "/app/settings", { ...write, Authorization: `Bearer ${wrong}` }, "{}"), "a write with another key");
  // Keys of any length, or none, are refused without an error (the comparison is of their digests).
  for (const candidate of ["", "a", token.slice(0, -1), `${token}x`, "x".repeat(255), "x".repeat(4096), `${token} ${token}`]) {
    refused(await call("GET", "/app/settings", { Authorization: `Bearer ${candidate}` }), `a key of ${candidate.length} characters`);
    refused(await call("GET", "/app/settings", { Cookie: `lc_api_${port}=${candidate}` }), `a cookie of ${candidate.length} characters`);
  }
  refused(await call("GET", "/app/settings", { Authorization: token }), "the key without Bearer");
  refused(await call("GET", "/app/settings", { Cookie: `lc_api_${port + 1}=${token}` }), "another port's cookie");
  refused(await call("GET", "/app/settings", { "X-Api-Token": token }), "the key in another header");

  // The key: the API, the UI and its files; unknown paths are then the router's 404.
  assert.equal((await call("GET", "/app/settings", bearer)).status, 200);
  assert.equal((await call("GET", "/app/settings", { Authorization: `bearer ${token}` })).status, 200, "the scheme in any letter case");
  assert.equal((await call("GET", "/", bearer)).status, 200);
  assert.equal((await call("GET", "/assets/app.js", bearer)).status, 200);
  assert.equal((await call("GET", "/no-such-page", bearer)).status, 404);
  assert.equal((await call("GET", "/app/settings", { Cookie: `theme=dark; lc_api_${port}=${token}; other=1` })).status, 200, "the cookie among others");
  assert.equal((await call("GET", "/app/settings", { Cookie: `lc_api_${port}=${token}`, Authorization: `Bearer ${wrong}` })).status, 200, "either one");
  const created = await call("POST", "/sessions", { ...write, ...bearer }, JSON.stringify({ title: "With the key" }));
  assert.ok(created.status < 300, created.body);

  // /health needs none and says nothing else.
  for (const method of ["GET", "HEAD"]) {
    const health = await call(method, "/health");
    assert.equal(health.status, 200, method);
    if (method === "GET") assert.deepEqual(JSON.parse(health.body), { ok: true });
  }

  // The browser's link sets the cookie and leaves the key out of the address.
  const bootstrap = await call("GET", `/?token=${encodeURIComponent(token)}`);
  assert.equal(bootstrap.status, 303);
  assert.equal(bootstrap.headers.location, "/");
  assert.equal(bootstrap.headers["cache-control"], "no-store");
  assert.deepEqual(bootstrap.headers["set-cookie"], [`lc_api_${port}=${token}; HttpOnly; SameSite=Strict; Path=/`]);
  assert.equal(bootstrap.body.includes(token), false);
  for (const target of [`/?token=${wrong}`, "/?token=", `/?token=${token}&token=${token}`, `/?token=${token.slice(1)}`, `/?token[a]=${token}`]) {
    refused(await call("GET", target), `the link ${target.replace(token, "<key>")}`);
  }
  refused(await call("GET", `/app/settings?token=${token}`), "the key in another address's query");
  assert.equal((await call("GET", "/", { Cookie: `lc_api_${port}=${token}` })).status, 200, "the page the link leads to");

  // Pages of another site or another port of this computer are refused even with the key.
  assert.equal((await call("GET", "/app/settings", { ...bearer, "Sec-Fetch-Site": "same-site" })).status, 403);
  assert.equal((await call("GET", "/app/settings", { ...bearer, "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await call("GET", "/app/settings", { ...bearer, "Sec-Fetch-Site": "same-origin" })).status, 200);
  assert.equal((await call("GET", "/app/settings", { ...bearer, "Sec-Fetch-Site": "none" })).status, 200);

  // The key is in no answer but the cookie the link sets, nor in the status.
  for (const reply of replies) {
    const { "set-cookie": _cookie, ...headers } = reply.headers;
    assert.equal(JSON.stringify(headers).includes(token), false);
    assert.equal(reply.body.includes(token), false);
  }
  assert.equal(JSON.stringify(status()).includes(token), false);

  // Its file: the key alone, readable only by this user; gone when the backend stops.
  assert.equal(fs.readFileSync(tokenFile, "utf8"), `${token}\n`);
  if (process.platform !== "win32") assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(tokenFile)).filter(name => name.includes("api-token")), ["api-token"], "no temporary copy");
  await dispose();
  assert.equal(fs.existsSync(tokenFile), false);
});

test("a key that could not be a cookie's value is refused at start", () => {
  for (const token of ["", "short", "x".repeat(257), `${"a".repeat(40)};Path=/`, `${"a".repeat(40)} b`]) assert.throws(() => createLocalApiAuth({ token }), /32 to 256 base64url/);
  assert.doesNotThrow(() => createLocalApiAuth({ token: createApiToken() }));
  assert.notEqual(createApiToken(), createApiToken());
  assert.match(createApiToken(), /^[A-Za-z0-9_-]{43}$/);
});

test("a run from source keeps its key in a file only its owner reads; on Windows a new key at every start and no file", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-source-token-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "runtime", "api-token");
  const first = sourceRunApiToken(file, "darwin");
  assert.equal(first.write, true, "none yet: a new key to write");
  writeApiTokenFile(file, first.token);
  const again = sourceRunApiToken(file, "linux");
  assert.deepEqual([again.token, again.write], [first.token, false], "the same key across restarts");
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o644);
    assert.notEqual(sourceRunApiToken(file, "darwin").token, first.token, "a file others can read is not reused");
    fs.chmodSync(file, 0o600);
  }
  const windows = sourceRunApiToken(file, "win32");
  assert.equal(windows.write, false); assert.equal(windows.file, undefined);
  assert.notEqual(windows.token, first.token, "Windows: a new key");
  assert.equal(fs.existsSync(file), false, "the file an earlier version left is removed");
  assert.notEqual(sourceRunApiToken(file, "win32").token, windows.token, "and another at the next start");
});
