import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import { AppConfig, config } from "../src/config/config";
import { applyMcpConfigurationPatch, emptyMcpConfiguration, parseMcpConfiguration } from "../src/mcp/client/configuration";
import { McpClientError } from "../src/mcp/client/errors";
import { McpClientConfiguration } from "../src/mcp/client/types";

const configuration = (): McpClientConfiguration => ({
  servers: {
    local: { id: "local", enabled: true, transport: "stdio", command: process.execPath,
      args: ["fixture.js"], cwd: os.tmpdir(), env: { NODE_ENV: "test", TOKENIZERS_PARALLELISM: "false" },
      connectTimeoutMs: 1000, requestTimeoutMs: 2000, reconnect: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 100 } },
    remote: { id: "remote", enabled: true, transport: "streamable-http", endpoint: "http://127.0.0.1:12345/mcp" }
  },
  bindings: {
    local: { id: "local", serverId: "local", enabled: true },
    first: { id: "first", serverId: "remote", enabled: true, accountId: "first-account", credentialRef: "keychain://mcp/first" },
    second: { id: "second", serverId: "remote", enabled: true, accountId: "second-account", credentialRef: "keychain://mcp/second" }
  }
});

function invalid(error: unknown): boolean {
  return error instanceof McpClientError && error.code === "invalid_configuration";
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options: AppConfig = {
    ...config, appDataDir: root,
    providers: Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => [id, { ...provider, apiKey: "", enabled: false }])) as AppConfig["providers"],
    telegram: { ...config.telegram, enabled: false, botToken: "" },
    notion: { ...config.notion, apiKey: "" },
    mcp: { server: { enabled: false, transport: "stdio", defaultSessionId: "preserved-inbound-session" } }
  };
  const store = new AppSettingsStore(root, options);
  return { root, options, store, file: path.join(root, "settings.json") };
}

test("MCP configuration keeps independent account identities and returns detached configuration", () => {
  assert.deepEqual(parseMcpConfiguration(undefined), emptyMcpConfiguration());
  const source = configuration();
  const parsed = parseMcpConfiguration(source);
  assert.deepEqual(parsed, source);
  parsed.bindings.first.enabled = false;
  if (parsed.servers.local.transport === "stdio") parsed.servers.local.args!.push("mutated");
  assert.equal(source.bindings.first.enabled, true);
  assert.equal(source.bindings.second.serverId, source.bindings.first.serverId);
  assert.equal(source.servers.local.transport === "stdio" && source.servers.local.args!.length, 1);
});

test("MCP configuration rejects malformed, secret-bearing, and live-state values without reflecting them", () => {
  const invalidConfigurations: unknown[] = [
    null, [], { servers: null }, { bindings: null }, { connected: true },
    { servers: { local: { ...configuration().servers.local, id: "different" } } },
    { servers: { constructor: { id: "constructor", enabled: true, transport: "stdio", command: "node" } } },
    { bindings: { orphan: { id: "orphan", serverId: "missing", enabled: true } } },
    { servers: { local: { ...configuration().servers.local, enabled: "yes" } } },
    { servers: { local: { ...configuration().servers.local, connectTimeoutMs: 0 } } },
    { servers: { local: { ...configuration().servers.local, requestTimeoutMs: 3600001 } } },
    { servers: { local: { ...configuration().servers.local, reconnect: { maxAttempts: 11, initialDelayMs: 1, maxDelayMs: 5 } } } },
    { servers: { local: { ...configuration().servers.local, reconnect: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 5 } } } },
    { servers: { local: { ...configuration().servers.local, env: { API_KEY: "do-not-echo-this-secret" } } } },
    { servers: { local: { ...configuration().servers.local, env: { NOTE: "Bearer do-not-echo-this-secret" } } } },
    { servers: { local: { ...configuration().servers.local, endpoint: "https://example.test" } } },
    { servers: { remote: { ...configuration().servers.remote, command: "node" } } },
    { servers: { remote: { ...configuration().servers.remote, endpoint: "file:///tmp/mcp" } } },
    { servers: { remote: { ...configuration().servers.remote, endpoint: "https://user:do-not-echo-this-secret@example.test/mcp" } } },
    { servers: { remote: { ...configuration().servers.remote, endpoint: "https://example.test/mcp?accessToken=do-not-echo-this-secret" } } },
    { servers: { remote: { ...configuration().servers.remote, endpoint: "https://example.test/mcp?api_key=do-not-echo-this-secret" } } },
    { servers: configuration().servers, bindings: { first: { ...configuration().bindings.first, token: "do-not-echo-this-secret" } } },
    { servers: configuration().servers, bindings: { first: { ...configuration().bindings.first, state: "connected" } } }
  ];
  for (const candidate of invalidConfigurations) {
    assert.throws(() => parseMcpConfiguration(candidate), error => {
      assert.ok(invalid(error));
      assert.doesNotMatch(String(error), /do-not-echo-this-secret/);
      return true;
    });
  }
});

test("MCP patches preserve other entries, support disable and transport changes, and cascade server deletion", () => {
  const original = configuration();
  const updated = applyMcpConfigurationPatch(original, {
    servers: { local: { requestTimeoutMs: 5000 } }, bindings: { first: { enabled: false } }
  });
  assert.equal(updated.servers.local.requestTimeoutMs, 5000);
  assert.deepEqual(updated.servers.remote, original.servers.remote);
  assert.deepEqual(updated.bindings.second, original.bindings.second);
  assert.equal(updated.bindings.first.enabled, false);
  assert.equal(original.bindings.first.enabled, true);
  const switched = applyMcpConfigurationPatch(updated, { servers: { local: { transport: "streamable-http", endpoint: "http://localhost/mcp" } } });
  assert.equal(switched.servers.local.transport, "streamable-http");
  assert.equal("command" in switched.servers.local, false);
  const removed = applyMcpConfigurationPatch(switched, { servers: { remote: null } });
  assert.deepEqual(Object.keys(removed.servers), ["local"]);
  assert.deepEqual(Object.keys(removed.bindings), ["local"]);
  assert.throws(() => applyMcpConfigurationPatch(original, { bindings: { first: { id: "renamed" } } }), invalid);
});

test("outbound settings survive restart while inbound and unrelated forward-compatible settings remain intact", async t => {
  const { store, options, root, file } = await fixture(t);
  const original = await store.get();
  assert.deepEqual(original.mcp.client, emptyMcpConfiguration());
  const forwardCompatible = {
    ...original, futureFeature: { choice: "keep" },
    llm: { ...original.llm, futureRouting: "keep" },
    mcp: { ...original.mcp, server: { ...original.mcp.server, futureInbound: "keep" } },
    plugins: { ...original.plugins, futurePlugin: { enabled: true, futureProperty: "keep", values: { value: "preserved" } } }
  };
  await fs.writeFile(file, JSON.stringify(forwardCompatible));
  await store.update({ mcp: { client: configuration() } });
  const saved = await store.update({ mcp: { client: { bindings: { first: { enabled: false } } } }, llm: { defaultProvider: "openai" } });
  const restarted = await new AppSettingsStore(root, options).get();
  assert.deepEqual(restarted.mcp.client, saved.mcp.client);
  assert.deepEqual(restarted.mcp.server, forwardCompatible.mcp.server);
  assert.deepEqual(restarted.providers, original.providers);
  const disk = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(disk.futureFeature, { choice: "keep" });
  assert.equal(disk.llm.futureRouting, "keep");
  assert.equal(disk.plugins.futurePlugin.futureProperty, "keep");
  assert.equal(restarted.mcp.client!.bindings.first.credentialRef, "keychain://mcp/first");
  await store.update({ mcp: { client: { servers: { remote: null } } } });
  assert.deepEqual(Object.keys((await store.get()).mcp.client!.bindings), ["local"]);
});

test("multiple settings stores serialize initialization and concurrent isolated patches", async t => {
  const { root, options, store } = await fixture(t);
  const other = new AppSettingsStore(root, options);
  const [first, second] = await Promise.all([store.get(), other.get()]);
  assert.equal(first.memory.localProfileId, second.memory.localProfileId);
  await Promise.all(Array.from({ length: 12 }, (_, index) => {
    const id = `server-${index}`;
    return (index % 2 ? store : other).update({
      mcp: { client: { servers: { [id]: { enabled: false, transport: "stdio", command: process.execPath } },
        bindings: { [id]: { serverId: id, enabled: false } } } },
      plugins: { [id]: { enabled: false, values: { retained: index } } }
    });
  }));
  const settings = await store.get();
  assert.equal(Object.keys(settings.mcp.client!.servers).length, 12);
  assert.equal(Object.keys(settings.mcp.client!.bindings).length, 12);
  for (let index = 0; index < 12; index++) assert.equal(settings.plugins[`server-${index}`].values.retained, index);
});

test("settings transaction commits only after apply and preserves a concurrent store update", async t => {
  const { root, options, store, file } = await fixture(t);
  await store.get();
  let entered!: () => void;
  let release!: () => void;
  const applying = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const transaction = store.transaction({ mcp: { client: configuration() } }, async (settings, previous) => {
    assert.deepEqual(previous.mcp.client, emptyMcpConfiguration());
    assert.equal(Object.keys(settings.mcp.client!.servers).length, 2);
    entered();
    await released;
    return "applied";
  });
  await applying;
  const concurrent = new AppSettingsStore(root, options).update({ llm: { defaultProvider: "openai" } });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).mcp.client, emptyMcpConfiguration());
  release();
  assert.equal((await transaction).value, "applied");
  await concurrent;
  const final = await store.get();
  assert.equal(final.llm.defaultProvider, "openai");
  assert.deepEqual(final.mcp.client, configuration());
});

test("failed callback or atomic settings save rejects and keeps the prior persisted file", async t => {
  const { store, file, root } = await fixture(t);
  await store.get();
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(store.transaction({ mcp: { client: configuration() } }, async () => { throw new Error("apply failed"); }), /apply failed/);
  assert.equal(await fs.readFile(file, "utf8"), before);
  const rename = fs.rename.bind(fs);
  const mocked = t.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (destination === file) throw Object.assign(new Error("save denied"), { code: "EACCES" });
    await rename(source, destination);
  });
  await assert.rejects(store.transaction({ mcp: { client: configuration() } }, async () => "not committed"), /save denied/);
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith(".tmp")), []);
  mocked.mock.restore();
  assert.deepEqual((await store.update({ mcp: { client: configuration() } })).mcp.client, configuration());
});

test("invalid patches and persisted MCP definitions reject without overwriting existing settings", async t => {
  const { store, file } = await fixture(t);
  await store.get();
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(store.update({ mcp: { client: { bindings: { orphan: { serverId: "missing", enabled: true } } } } }), invalid);
  assert.equal(await fs.readFile(file, "utf8"), before);
  const corrupt = JSON.stringify({ ...JSON.parse(before), mcp: { server: config.mcp.server, client: { token: "do-not-echo-this-secret" } } });
  await fs.writeFile(file, corrupt);
  await assert.rejects(store.get(), invalid);
  assert.equal(await fs.readFile(file, "utf8"), corrupt);
  await fs.writeFile(file, "{invalid json");
  await assert.rejects(store.get(), SyntaxError);
  assert.equal(await fs.readFile(file, "utf8"), "{invalid json");
});

test("legacy settings receive empty outbound defaults through a serialized migration", async t => {
  const { store, root, options, file } = await fixture(t);
  const legacy: any = await store.get();
  delete legacy.schemaVersion;
  delete legacy.memory.localProfileId;
  delete legacy.mcp.client;
  await fs.writeFile(file, JSON.stringify(legacy));
  const [first, second] = await Promise.all([store.get(), new AppSettingsStore(root, options).get()]);
  assert.deepEqual(first.mcp.client, emptyMcpConfiguration());
  assert.deepEqual(first.mcp.server, legacy.mcp.server);
  assert.equal(first.memory.localProfileId, second.memory.localProfileId);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "settings.pre-llamacpp.json"), "utf8")), JSON.parse(JSON.stringify(legacy)));
});
