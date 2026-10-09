import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import { createMcpRouter } from "../src/api/mcpControllers";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import { RuntimeManager } from "../src/app/RuntimeManager";
import { AppConfig, config } from "../src/config/config";
import { applyMcpConfigurationPatch, parseMcpConfiguration } from "../src/mcp/client/configuration";
import { VaultMcpCredentialProvider } from "../src/mcp/client/credentials";
import { McpClientError } from "../src/mcp/client/errors";
import type { McpServerDefinition } from "../src/mcp/client/types";
import type { CredentialVault } from "../src/plugins/contracts";
import { Logger } from "../src/utils/Logger";

const memoryVault = () => {
  const values = new Map<string, string>();
  const vault: CredentialVault = { available: () => true, read: async key => values.get(key), write: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } };
  return { vault, values };
};

test("secrets reach a server from the vault: env for a process, headers and a bearer token only for the address they were saved for", async () => {
  const { vault } = memoryVault();
  const provider = new VaultMcpCredentialProvider(vault);
  const stdio: McpServerDefinition = { id: "blender", enabled: true, transport: "stdio", command: "uvx", secretEnv: ["SKETCHFAB_API_KEY"] };
  const binding = { id: "blender", serverId: "blender", enabled: true, credentialRef: "mcp:ref-1" };
  const signal = new AbortController().signal;
  await assert.rejects(provider.resolve({ server: stdio, binding, signal }),
    (error: unknown) => error instanceof McpClientError && error.code === "authentication_required" && /SKETCHFAB_API_KEY is not set/.test(error.detail ?? ""));
  await provider.write("ref-1", stdio, "env", "SKETCHFAB_API_KEY", "sk-live-123456");
  assert.deepEqual(await provider.resolve({ server: stdio, binding, signal }), { env: { SKETCHFAB_API_KEY: "sk-live-123456" } });

  const http: McpServerDefinition = { id: "unreal", enabled: true, transport: "streamable-http", endpoint: "https://agent.example.com/mcp", secretHeaders: ["X-Api-Key"], bearerToken: true };
  const httpBinding = { ...binding, id: "unreal", serverId: "unreal", credentialRef: "mcp:ref-2" };
  await provider.write("ref-2", http, "header", "X-Api-Key", "key-abcdef");
  await provider.write("ref-2", http, "bearer", "Authorization", "tok-abcdef");
  assert.deepEqual(await provider.resolve({ server: http, binding: httpBinding, signal }), { headers: { "X-Api-Key": "key-abcdef", Authorization: "Bearer tok-abcdef" } });
  const moved = { ...http, endpoint: "https://elsewhere.example.net/mcp" };
  await assert.rejects(provider.resolve({ server: moved, binding: httpBinding, signal }), (error: unknown) => error instanceof McpClientError && /another address/.test(error.detail ?? ""));
  assert.equal(await provider.resolve({ server: stdio, binding: { ...binding, credentialRef: undefined }, signal }), undefined, "a server without secrets");
});

test("settings name secrets but never hold them; plain headers refuse credentials", () => {
  const server = (extra: object) => ({ servers: { s: { id: "s", enabled: true, transport: "stdio", command: "uvx", ...extra } }, bindings: {} });
  assert.deepEqual(parseMcpConfiguration(server({ secretEnv: ["OPENAI_API_KEY"] })).servers.s, { id: "s", enabled: true, transport: "stdio", command: "uvx", secretEnv: ["OPENAI_API_KEY"] });
  assert.throws(() => parseMcpConfiguration(server({ env: { OPENAI_API_KEY: "x" } })), "a secret name in plain env");
  assert.throws(() => parseMcpConfiguration(server({ env: { A: "1" }, secretEnv: ["A"] })), "a name in both");
  const http = (extra: object) => ({ servers: { h: { id: "h", enabled: true, transport: "streamable-http", endpoint: "https://example.com/mcp", ...extra } }, bindings: {} });
  assert.deepEqual(parseMcpConfiguration(http({ headers: { "X-Region": "eu" }, secretHeaders: ["X-Api-Key"], bearerToken: true })).servers.h,
    { id: "h", enabled: true, transport: "streamable-http", endpoint: "https://example.com/mcp", headers: { "X-Region": "eu" }, secretHeaders: ["X-Api-Key"], bearerToken: true });
  for (const headers of [{ Authorization: "Bearer abc" }, { "X-Api-Key": "abc" }, { "X-Note": "a\r\nb" }]) assert.throws(() => parseMcpConfiguration(http({ headers })), JSON.stringify(headers));
  assert.throws(() => parseMcpConfiguration(http({ secretHeaders: ["Authorization"], bearerToken: true })), "two Authorization headers");
  const switched = applyMcpConfigurationPatch(parseMcpConfiguration(http({ headers: { "X-Region": "eu" }, bearerToken: true })), { servers: { h: { transport: "stdio", command: "uvx" } } });
  assert.deepEqual(switched.servers.h, { id: "h", enabled: true, transport: "stdio", command: "uvx" }, "a switched transport drops the other's fields");
});

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-secrets-"));
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, value]) => [id, { ...value, enabled: false, apiKey: "" }])) as AppConfig["providers"];
  const options: AppConfig = {
    ...config, providers, appDataDir: path.join(root, "app"), mcp: { ...config.mcp, client: { servers: {}, bindings: {} } },
    sessions: { baseDir: path.join(root, "sessions") }, memory: { ...config.memory, adapter: "local-json", baseDir: path.join(root, "memory") },
    outputDir: path.join(root, "output"), plugins: { dir: path.resolve(process.cwd(), "plugins"), overrides: {} },
    telegram: { ...config.telegram, enabled: false, botToken: "" },
    localModels: { ...config.localModels!, runtimeDir: path.join(root, "runtime"), executablePath: undefined, modelsDir: path.join(root, "models"), contextSize: 4096 }
  };
  const { vault, values } = memoryVault();
  const manager = new RuntimeManager(options, new AppSettingsStore(options.appDataDir, options), new Logger(), {}, { vault });
  await manager.init();
  const app = express();
  app.use(express.json());
  app.use("/mcp/clients", createMcpRouter(manager));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await manager.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/clients/servers/fixture/secrets`;
  const call = async (method: string, url = base, body?: unknown) => {
    const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  await manager.updateSettings({ mcp: { client: { servers: { fixture: { id: "fixture", enabled: true, transport: "stdio", command: process.execPath,
    args: [path.join(__dirname, "fixtures", "mcpStdio.js")], connectTimeoutMs: 5000, reconnect: { maxAttempts: 0, initialDelayMs: 10, maxDelayMs: 10 } } },
    bindings: { fixture: { id: "fixture", serverId: "fixture", enabled: true } } } } });
  const account = async () => {
    const clients = manager.getRuntime().mcpClients;
    for (let index = 0; index < 300 && clients.status("fixture").state !== "connected"; index++) await delay(20);
    return (await clients.callTool({ bindingId: "fixture", toolName: "echo", arguments: { text: "who" } })).result.structuredContent?.account;
  };
  return { root, manager, values, call, account, base, settingsFile: path.join(options.appDataDir, "settings.json") };
}

test("Settings set, replace and remove a server's secret: the server gets the value, settings.json only the name", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call("GET")).body, { available: true, secrets: [] });
  assert.equal(await f.account(), "anonymous");
  const set = await f.call("PUT", undefined, { kind: "env", name: "FIXTURE_ACCOUNT", value: "acct-secret-123456" });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.secrets, [{ kind: "env", name: "FIXTURE_ACCOUNT", set: true }]);
  assert.equal(JSON.stringify(set.body).includes("acct-secret"), false, "the value never comes back");
  assert.equal(await f.account(), "acct-secret-123456");
  const stored = await fs.readFile(f.settingsFile, "utf8");
  assert.equal(stored.includes("acct-secret"), false, "settings.json holds no value");
  assert.match(stored, /FIXTURE_ACCOUNT/);
  await f.call("PUT", undefined, { kind: "env", name: "FIXTURE_ACCOUNT", value: "acct-rotated-654321" });
  for (let index = 0; index < 50 && await f.account().catch(() => "") !== "acct-rotated-654321"; index++) await delay(50);
  assert.equal(await f.account(), "acct-rotated-654321", "a new value restarts the server");
  assert.equal((await f.call("PUT", undefined, { kind: "header", name: "X-Key", value: "v" })).status, 400, "headers are for servers reached by URL");
  // Removed: the server starts without it, and its value leaves the vault.
  const removed = await f.call("DELETE", `${f.base}/env/FIXTURE_ACCOUNT`);
  assert.deepEqual(removed.body.secrets, []);
  assert.equal([...f.values.keys()].length, 0);
  for (let index = 0; index < 50 && await f.account().catch(() => "") !== "anonymous"; index++) await delay(50);
  assert.equal(await f.account(), "anonymous");
  // A removed server takes its secrets with it.
  await f.call("PUT", undefined, { kind: "env", name: "FIXTURE_ACCOUNT", value: "acct-secret-123456" });
  assert.equal(f.values.size, 1);
  await f.manager.updateSettings({ mcp: { client: { servers: { fixture: null } } } } as never);
  assert.equal(f.values.size, 0);
});

test("an import preview shows secrets by name only; importing stores them in the vault and adds the servers once", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const importUrl = f.base.replace(/servers\/fixture\/secrets$/, "import");
  // Disabled, so the test starts no process.
  const snippet = JSON.stringify({ mcpServers: { blender: { command: "uvx", args: ["blender-mcp"], disabled: true, env: { BLENDER_PORT: "9876", SKETCHFAB_API_KEY: "sk-sketch-abcdef123" } } } });
  const preview = await f.call("POST", `${importUrl}/preview`, { source: "text", text: snippet });
  assert.equal(preview.status, 200);
  assert.equal(JSON.stringify(preview.body).includes("sk-sketch"), false, "no value in the preview");
  assert.deepEqual(preview.body.servers[0].secrets, [{ kind: "env", name: "SKETCHFAB_API_KEY", found: true }]);
  assert.equal((await f.call("POST", `${importUrl}/preview`, { source: "../../etc/passwd" })).status, 400, "no path from a request");
  const applied = await f.call("POST", `${importUrl}/apply`, { token: preview.body.token, keys: ["blender"] });
  assert.deepEqual(applied.body, { added: ["blender"], missing: [] });
  const settings = await fs.readFile(f.settingsFile, "utf8");
  assert.equal(settings.includes("sk-sketch"), false);
  assert.match(settings, /SKETCHFAB_API_KEY/);
  assert.deepEqual([...f.values.values()], ["sk-sketch-abcdef123"]);
  assert.equal((await f.call("POST", `${importUrl}/apply`, { token: preview.body.token, keys: ["blender"] })).status, 409, "a preview is used once");
  const again = await f.call("POST", `${importUrl}/preview`, { source: "text", text: snippet });
  assert.equal(again.body.servers[0].alreadyAdded, "blender");
  await f.manager.updateSettings({ mcp: { client: { servers: { blender: null } } } } as never);
});
