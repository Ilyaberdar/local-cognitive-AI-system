import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpClientManager } from "../src/mcp/client/McpClientManager";
import type { McpClientConfiguration, McpConnection, McpConnectionBinding, McpConnector, McpLifecycleEvent, McpOperationOptions, McpServerDefinition } from "../src/mcp/client/types";
import { createMcpHttpFixture } from "./fixtures/mcpHttp";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function eventually(check: () => boolean, message: string, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    assert.ok(Date.now() < until, message);
    await delay(10);
  }
}

const echoTool: Tool = { name: "echo", inputSchema: {
  type: "object", properties: { text: { type: "string", minLength: 1 } }, required: ["text"], additionalProperties: false
} };
const valueResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], structuredContent: { text } });
type OpenOptions = Parameters<McpConnector["open"]>[2];

class ControlledConnector implements McpConnector {
  opens: Array<{ binding: McpConnectionBinding; options: OpenOptions; connection: McpConnection; closed: number; tools: Tool[] }> = [];
  calls: Array<{ bindingId: string; name: string; args: Record<string, unknown>; options: McpOperationOptions }> = [];
  failures = 0;
  failure: unknown = new Error("transport unavailable");
  gate?: ReturnType<typeof deferred<void>>;
  invoke?: (name: string, args: Record<string, unknown>, options: McpOperationOptions) => Promise<CallToolResult>;

  async open(_server: McpServerDefinition, binding: McpConnectionBinding, options: OpenOptions): Promise<McpConnection> {
    const entry = { binding, options, closed: 0, tools: [echoTool], connection: undefined as unknown as McpConnection };
    entry.connection = {
      listTools: async () => ({ tools: entry.tools }),
      callTool: async (name, args, callOptions) => {
        this.calls.push({ bindingId: binding.id, name, args, options: callOptions });
        return this.invoke ? this.invoke(name, args, callOptions) : valueResult(String(args.text));
      },
      close: async () => { entry.closed++; }
    };
    this.opens.push(entry);
    if (this.failures-- > 0) throw this.failure;
    if (this.gate) await this.gate.promise;
    return entry.connection;
  }
}

function configuration(bindings = ["first"]): McpClientConfiguration {
  return {
    servers: { fixture: { id: "fixture", enabled: true, transport: "stdio", command: process.execPath,
      connectTimeoutMs: 1000, requestTimeoutMs: 1000, reconnect: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20 } } },
    bindings: Object.fromEntries(bindings.map(id => [id, { id, serverId: "fixture", enabled: true }]))
  };
}

function stdioConfiguration(): McpClientConfiguration {
  const settings = configuration();
  settings.servers.fixture = { ...settings.servers.fixture, transport: "stdio", command: process.execPath,
    args: [path.join(__dirname, "fixtures", "mcpStdio.js")], connectTimeoutMs: 3000, requestTimeoutMs: 2000 };
  return settings;
}

const codeIs = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

test("MCP duplicate connects share initialization; account bindings and config changes stay isolated", async t => {
  const connector = new ControlledConnector();
  connector.gate = deferred<void>();
  const manager = new McpClientManager({ connector });
  t.after(() => manager.dispose());
  const config = configuration();
  const reconciling = manager.reconcile(config);
  await eventually(() => connector.opens.length === 1, "connection starts");
  const duplicateA = manager.connect("first");
  const duplicateB = manager.connect("first");
  connector.gate.resolve();
  await Promise.all([reconciling, duplicateA, duplicateB]);
  assert.equal(connector.opens.length, 1);
  assert.equal(manager.status("first").state, "connected");
  await manager.reconcile(configuration(["first", "second"]));
  assert.equal(connector.opens.length, 2);
  assert.equal(new Set(manager.tools().map(tool => tool.id)).size, 2);
  const changed = configuration(["first", "second"]);
  changed.bindings.second.credentialRef = "account-two-v2";
  await manager.reconcile(changed);
  assert.equal(connector.opens.length, 3);
  assert.equal(connector.opens[0].closed, 0);
  assert.equal(connector.opens[1].closed, 1);
  assert.equal(manager.status("first").state, "connected");
  await manager.reconcile(structuredClone(changed));
  assert.equal(connector.opens.length, 3, "equivalent settings do not reconnect");
});

test("MCP validates before dispatch, preserves results, distinguishes tool errors, and emits redacted activity", async t => {
  const connector = new ControlledConnector();
  const manager = new McpClientManager({ connector });
  t.after(() => manager.dispose());
  const events: McpLifecycleEvent[] = [];
  manager.subscribe(event => events.push(event));
  await manager.reconcile(configuration());
  await assert.rejects(manager.callTool({ bindingId: "first", toolName: "echo", arguments: { text: 1 } }), codeIs("invalid_arguments"));
  await assert.rejects(manager.callTool({ bindingId: "first", toolName: "missing", arguments: {} }), codeIs("tool_not_found"));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(manager.callTool({ bindingId: "first", toolName: "echo", arguments: { text: "x" } }, { signal: cancelled.signal }), codeIs("cancelled"));
  assert.equal(connector.calls.length, 0);
  const result = await manager.callTool({ bindingId: "first", toolName: "echo", arguments: { text: "private argument" }, runId: "run-one", sessionId: "session-one" });
  assert.deepEqual(result.result, valueResult("private argument"));
  assert.equal(result.outcome, "success");
  const invocation = events.find(event => event.type === "invocation" && event.callId === result.callId);
  assert.ok(invocation?.type === "invocation");
  assert.equal(invocation.runId, "run-one");
  assert.equal(invocation.sessionId, "session-one");
  assert.ok(invocation.durationMs >= 0);
  assert.ok(invocation.toolId.includes("first"));
  assert.ok(!JSON.stringify(events).includes("private argument"));
  connector.invoke = async () => ({ content: [{ type: "text", text: "tool said no" }], isError: true });
  assert.equal((await manager.callTool({ bindingId: "first", toolName: "echo", arguments: { text: "x" } })).outcome, "tool-error");
  connector.invoke = async () => { throw new Error("Authorization Bearer test-secret-value"); };
  await assert.rejects(manager.callTool({ bindingId: "first", toolName: "echo", arguments: { text: "x" } }), error => {
    assert.ok(!String(error).includes("test-secret-value"));
    return true;
  });
  assert.ok(!JSON.stringify(events).includes("test-secret-value"));
});

test("MCP schema refresh removes old tools and does not mix schemas sharing remote $id", async t => {
  const connector = new ControlledConnector();
  const manager = new McpClientManager({ connector });
  t.after(() => manager.dispose());
  await manager.reconcile(configuration(["first", "second"]));
  connector.opens[0].tools = [{ name: "same", inputSchema: { $id: "https://fixture/schema", type: "object", properties: { value: { type: "number" } }, required: ["value"] } }];
  connector.opens[1].tools = [{ name: "same", inputSchema: { $id: "https://fixture/schema", type: "object", properties: { value: { type: "string" } }, required: ["value"] } }];
  await Promise.all([manager.discoverTools("first"), manager.discoverTools("second")]);
  await assert.rejects(manager.callTool({ bindingId: "first", toolName: "same", arguments: { value: "wrong" } }), codeIs("invalid_arguments"));
  await assert.rejects(manager.callTool({ bindingId: "second", toolName: "same", arguments: { value: 1 } }), codeIs("invalid_arguments"));
  await manager.callTool({ bindingId: "first", toolName: "same", arguments: { value: 1 } });
  await manager.callTool({ bindingId: "second", toolName: "same", arguments: { value: "right" } });
  connector.opens[0].tools = [echoTool];
  connector.opens[0].options.onToolsChanged();
  await eventually(() => manager.tools("first").some(tool => tool.definition.name === "echo"), "tool list notification refreshes");
  await assert.rejects(manager.callTool({ bindingId: "first", toolName: "same", arguments: { value: 1 } }), codeIs("tool_not_found"));
});

test("MCP a tool-list notification invalidates discovery already in flight", async t => {
  const connector = new ControlledConnector();
  const manager = new McpClientManager({ connector });
  t.after(() => manager.dispose());
  await manager.reconcile(configuration());
  const stale = deferred<{ tools: Tool[] }>();
  let listings = 0;
  connector.opens[0].connection.listTools = async () => {
    if (listings++ === 0) return stale.promise;
    return { tools: [{ name: "fresh", inputSchema: { type: "object" } }] };
  };
  const listing = manager.discoverTools("first");
  await eventually(() => listings === 1, "discovery starts");
  connector.opens[0].options.onToolsChanged();
  assert.deepEqual(manager.tools("first"), [], "a notification immediately hides stale availability");
  stale.resolve({ tools: [echoTool] });
  await listing;
  assert.deepEqual(manager.tools("first").map(tool => tool.definition.name), ["fresh"]);
  assert.equal(listings, 2, "the stale discovery snapshot is refreshed");
});

test("MCP discovery cannot publish a snapshot invalidated in its completion microtasks", async t => {
  const connector = new ControlledConnector();
  const manager = new McpClientManager({ connector });
  t.after(() => manager.dispose());
  await manager.reconcile(configuration());
  for (const microtasks of [2, 3, 4, 5, 6, 7, 8]) {
    let listings = 0;
    connector.opens[0].connection.listTools = async () => {
      if (listings++ === 0) {
        const notify = (remaining: number) => queueMicrotask(() => {
          if (remaining > 0) notify(remaining - 1);
          else connector.opens[0].options.onToolsChanged();
        });
        notify(microtasks);
        return { tools: [echoTool] };
      }
      return { tools: [{ name: "fresh", inputSchema: { type: "object" } }] };
    };
    await manager.discoverTools("first");
    await eventually(() => manager.tools("first").some(tool => tool.definition.name === "fresh"), "completion notification is not lost");
    assert.deepEqual(manager.tools("first").map(tool => tool.definition.name), ["fresh"]);
    assert.equal(listings, 2);
  }
});

test("MCP shutdown waits for an initializing stdio process to finish owned cleanup", { timeout: 10000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-startup-shutdown-"));
  const marker = path.join(root, "pid");
  const manager = new McpClientManager();
  let pid: number | undefined;
  t.after(async () => {
    await manager.dispose();
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } }
    await fs.rm(root, { recursive: true, force: true });
  });
  const config = configuration();
  config.servers.fixture = {
    id: "fixture", enabled: true, transport: "stdio", command: process.execPath, connectTimeoutMs: 5000,
    args: ["-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.stdin.resume(); process.stdin.on('end', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", marker],
    reconnect: { maxAttempts: 0, initialDelayMs: 10, maxDelayMs: 10 }
  };
  const connecting = manager.reconcile(config);
  await eventually(() => existsSync(marker), "owned child starts without initializing MCP");
  pid = Number(await fs.readFile(marker, "utf8"));
  await manager.dispose();
  await connecting;
  assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" }, "dispose must await process termination, including initialization failure");
});

test("MCP disconnect and disable win against a late connection; repeated disposal is safe", async () => {
  for (const action of ["disconnect", "disable", "dispose"] as const) {
    const connector = new ControlledConnector();
    connector.gate = deferred<void>();
    const manager = new McpClientManager({ connector });
    const config = configuration();
    const pending = manager.reconcile(config);
    await eventually(() => connector.opens.length === 1, "connect begins");
    const stopping = action === "disconnect" ? manager.disconnect("first") : action === "dispose" ? manager.dispose()
      : manager.reconcile({ ...config, bindings: { first: { ...config.bindings.first, enabled: false } } });
    connector.gate.resolve();
    await Promise.all([pending, stopping]);
    assert.equal(connector.opens[0].closed, 1, action);
    if (action !== "dispose") {
      assert.notEqual(manager.status("first").state, "connected", action);
      assert.deepEqual(manager.tools("first"), []);
    }
    await manager.dispose();
    await manager.dispose();
    assert.equal(connector.opens[0].closed, 1);
  }
});

test("MCP retries are bounded, disconnect stops backoff, and invocations are never replayed", async t => {
  const connector = new ControlledConnector();
  const manager = new McpClientManager({ connector });
  t.after(() => manager.dispose());
  await manager.reconcile(configuration());
  const interrupted = deferred<CallToolResult>();
  connector.invoke = () => interrupted.promise;
  const call = manager.callTool({ bindingId: "first", toolName: "echo", arguments: { text: "side effect" } });
  const rejected = assert.rejects(call);
  await eventually(() => connector.calls.length === 1, "tool invocation begins");
  connector.opens[0].options.onClose();
  await rejected;
  await eventually(() => connector.opens.length === 2 && manager.status("first").state === "connected", "automatic recovery reconnects");
  assert.equal(connector.calls.length, 1, "recovering a connection never replays a call");
  interrupted.resolve(valueResult("late result"));
  connector.failures = 100;
  connector.opens[1].options.onClose();
  await eventually(() => connector.opens.length === 4, "only the configured two retry attempts run");
  await delay(70);
  assert.equal(connector.opens.length, 4);
  assert.equal(manager.status("first").state, "error");
  connector.failures = 0;
  await manager.connect("first");
  connector.opens.at(-1)!.options.onClose();
  await manager.disconnect("first");
  const attempts = connector.opens.length;
  await delay(60);
  assert.equal(connector.opens.length, attempts);
  assert.equal(manager.status("first").state, "disconnected");
});

test("MCP cancelling a primary connect clears connecting state and permits a later explicit connect", async t => {
  const connector = new ControlledConnector();
  const manager = new McpClientManager({ connector });
  t.after(() => manager.dispose());
  await manager.reconcile(configuration());
  await manager.disconnect("first");
  connector.gate = deferred<void>();
  const aborter = new AbortController();
  const connecting = manager.connect("first", { signal: aborter.signal });
  const cancelled = assert.rejects(connecting, codeIs("cancelled"));
  await eventually(() => connector.opens.length === 2, "explicit connection starts");
  aborter.abort();
  await cancelled;
  assert.equal(manager.status("first").state, "disconnected");
  assert.deepEqual(manager.tools("first"), []);
  connector.gate.resolve();
  await eventually(() => connector.opens[1].closed === 1, "cancelled late connection is closed");
  const count = connector.opens.length;
  await delay(60);
  assert.equal(connector.opens.length, count, "cancellation does not schedule recovery");
  await manager.connect("first");
  assert.equal(manager.status("first").state, "connected");
});

test("MCP stdio completes paging, calls, cancellation, notifications, and owned-process cleanup", { timeout: 15000 }, async t => {
  const manager = new McpClientManager();
  t.after(() => manager.dispose());
  await manager.reconcile(stdioConfiguration());
  assert.equal(manager.status("first").state, "connected");
  const tools = manager.tools("first");
  assert.ok(tools.length >= 8, "all pages are discovered");
  assert.ok(tools.every(tool => tool.bindingId === "first" && tool.serverId === "fixture"));
  const request = { bindingId: "first", toolName: "sum", arguments: { a: 2, b: 3 } };
  const sum = await manager.callTool(request);
  assert.equal(sum.outcome, "success");
  assert.equal(sum.result.structuredContent?.sum, 5);
  await assert.rejects(manager.callTool({ ...request, arguments: { a: "2", b: 3 } }), codeIs("invalid_arguments"));
  assert.equal((await manager.callTool({ bindingId: "first", toolName: "tool_error", arguments: {} })).outcome, "tool-error");
  await assert.rejects(manager.callTool({ bindingId: "first", toolName: "protocol_error", arguments: {} }), codeIs("protocol_error"));
  const before = await manager.callTool({ bindingId: "first", toolName: "stats", arguments: {} });
  const beforeStats = before.result.structuredContent as { calls: unknown[]; cancellations: number; pid: number };
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(manager.callTool({ bindingId: "first", toolName: "slow", arguments: { delayMs: 500 } }, { signal: aborted.signal }), codeIs("cancelled"));
  const aborter = new AbortController();
  const slow = manager.callTool({ bindingId: "first", toolName: "slow", arguments: { delayMs: 1000 } }, { signal: aborter.signal });
  const wasCancelled = assert.rejects(slow, codeIs("cancelled"));
  await delay(40);
  aborter.abort();
  await wasCancelled;
  await assert.rejects(manager.callTool({ bindingId: "first", toolName: "slow", arguments: { delayMs: 1000 } }, { timeoutMs: 30 }), codeIs("timeout"));
  await delay(30);
  const stats = (await manager.callTool({ bindingId: "first", toolName: "stats", arguments: {} })).result.structuredContent as { calls: Array<{ name: string }>; cancellations: number; pid: number };
  assert.equal(stats.calls.filter(call => call.name === "sum").length, 1, "invalid arguments never dispatched");
  assert.equal(stats.calls.filter(call => call.name === "slow").length, 2, "pre-cancelled calls never dispatched");
  assert.ok(stats.cancellations >= beforeStats.cancellations + 2, "protocol cancellation reached server");
  await manager.callTool({ bindingId: "first", toolName: "change_tools", arguments: {} });
  await eventually(() => manager.tools("first").some(tool => tool.definition.name === "added"), "stdio notification refreshes tools");
  await manager.dispose();
  await eventually(() => { try { process.kill(stats.pid, 0); return false; } catch { return true; } }, "owned fixture process exits");
});

test("MCP HTTP negotiates separate authenticated sessions, refreshes tools, and terminates sessions", { timeout: 15000 }, async t => {
  const fixture = await createMcpHttpFixture({ accounts: { "Bearer first-secret": "alice", "Bearer second-secret": "bob" } });
  const resolved: string[] = [];
  const manager = new McpClientManager({ credentialProvider: { resolve: async ({ binding }) => {
    resolved.push(binding.id);
    return { headers: { Authorization: `Bearer ${binding.credentialRef}` } };
  } } });
  t.after(async () => { await manager.dispose(); await fixture.close(); });
  const events: McpLifecycleEvent[] = [];
  manager.subscribe(event => events.push(event));
  const config = configuration(["first", "second"]);
  config.servers.fixture = { id: "fixture", transport: "streamable-http", endpoint: fixture.endpoint, enabled: true,
    connectTimeoutMs: 2000, requestTimeoutMs: 2000, reconnect: { maxAttempts: 0, initialDelayMs: 10, maxDelayMs: 10 } };
  config.bindings.first.credentialRef = "first-secret";
  config.bindings.second.credentialRef = "second-secret";
  await manager.reconcile(config);
  assert.deepEqual(manager.list().map(status => status.state), ["connected", "connected"]);
  assert.equal(fixture.sessions.size, 2);
  assert.deepEqual(resolved.sort(), ["first", "second"]);
  const accounts = await Promise.all(["first", "second"].map(bindingId => manager.callTool({ bindingId, toolName: "echo", arguments: { text: "hello" } })));
  assert.deepEqual(accounts.map(result => result.result.structuredContent?.account), ["alice", "bob"]);
  assert.ok(fixture.fixtures.every(server => server.state.listRequests.length > 1), "real paginated discovery");
  await manager.callTool({ bindingId: "first", toolName: "change_tools", arguments: {} });
  await eventually(() => manager.tools("first").some(tool => tool.definition.name === "added"), "HTTP SSE tool notification refreshes");
  assert.ok(!manager.tools("second").some(tool => tool.definition.name === "added"));
  assert.ok(!JSON.stringify(events).includes("secret"));
  const count = fixture.fixtures.reduce((total, item) => total + item.state.calls.length, 0);
  await assert.rejects(manager.callTool({ bindingId: "first", toolName: "sum", arguments: { a: false, b: 2 } }), codeIs("invalid_arguments"));
  assert.equal(fixture.fixtures.reduce((total, item) => total + item.state.calls.length, 0), count);
  await manager.dispose();
  assert.equal(fixture.deletedSessions, 2);
  assert.equal(fixture.sessions.size, 0);
});

test("MCP HTTP auth challenges clear availability; failed startup and unreachable endpoint stay errors", { timeout: 15000 }, async t => {
  const fixture = await createMcpHttpFixture({ accounts: { "Bearer allowed": "account" } });
  const manager = new McpClientManager();
  t.after(async () => { await manager.dispose(); await fixture.close(); });
  const config = configuration();
  config.servers.fixture = { id: "fixture", transport: "streamable-http", endpoint: fixture.endpoint, enabled: true,
    connectTimeoutMs: 300, reconnect: { maxAttempts: 0, initialDelayMs: 10, maxDelayMs: 10 } };
  await manager.reconcile(config);
  assert.equal(manager.status("first").state, "authentication-required");
  assert.deepEqual(manager.tools("first"), []);
  assert.equal(fixture.sessions.size, 0);
  const endpoint = fixture.endpoint;
  await fixture.close();
  config.servers.fixture = { ...config.servers.fixture, endpoint: `${endpoint}?closed=1` };
  await manager.reconcile(config);
  assert.equal(manager.status("first").state, "error");
  config.servers.fixture = { id: "fixture", enabled: true, transport: "stdio", command: "/nonexistent/local-cognitive-mcp-fixture",
    connectTimeoutMs: 300, reconnect: { maxAttempts: 0, initialDelayMs: 10, maxDelayMs: 10 } };
  await manager.reconcile(config);
  assert.equal(manager.status("first").state, "error");
});

test("MCP real stdio crash reconnects with a new process and never replays the failed invocation", { timeout: 15000 }, async t => {
  const manager = new McpClientManager();
  t.after(() => manager.dispose());
  await manager.reconcile(stdioConfiguration());
  const oldPid = (await manager.callTool({ bindingId: "first", toolName: "stats", arguments: {} })).result.structuredContent?.pid as number;
  await assert.rejects(manager.callTool({ bindingId: "first", toolName: "crash", arguments: {} }));
  await eventually(() => manager.status("first").state === "connected", "real stdio recovers after crash");
  const current = (await manager.callTool({ bindingId: "first", toolName: "stats", arguments: {} })).result.structuredContent as { pid: number; calls: Array<{ name: string }> };
  assert.notEqual(current.pid, oldPid);
  assert.equal(current.calls.filter(call => call.name === "crash").length, 0);
  await eventually(() => { try { process.kill(oldPid, 0); return false; } catch { return true; } }, "crashed fixture is reaped");
});

test("MCP real HTTP session loss reconnects without replaying the ambiguous call", { timeout: 15000 }, async t => {
  const fixture = await createMcpHttpFixture();
  const manager = new McpClientManager();
  t.after(async () => { await manager.dispose(); await fixture.close(); });
  const config = configuration();
  config.servers.fixture = { id: "fixture", transport: "streamable-http", endpoint: fixture.endpoint, enabled: true,
    connectTimeoutMs: 2000, requestTimeoutMs: 1000, reconnect: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20 } };
  await manager.reconcile(config);
  assert.equal(manager.status("first").state, "connected");
  await assert.rejects(manager.callTool({ bindingId: "first", toolName: "crash", arguments: {} }));
  await eventually(() => fixture.fixtures.length === 2 && manager.status("first").state === "connected", "HTTP recreates the lost session");
  const result = await manager.callTool({ bindingId: "first", toolName: "sum", arguments: { a: 3, b: 4 } });
  assert.equal(result.result.structuredContent?.sum, 7);
  assert.equal(fixture.fixtures.reduce((count, item) => count + item.state.calls.filter(call => call.name === "crash").length, 0), 1);
});

test("MCP loss of HTTP authorization clears tools until explicit credentials reconnect", { timeout: 15000 }, async t => {
  const accounts: Record<string, string> = { "Bearer allowed": "alice" };
  const fixture = await createMcpHttpFixture({ accounts });
  const manager = new McpClientManager({ credentialProvider: { resolve: async () => ({ headers: { Authorization: "Bearer allowed" } }) } });
  t.after(async () => { await manager.dispose(); await fixture.close(); });
  const config = configuration();
  config.servers.fixture = { id: "fixture", transport: "streamable-http", endpoint: fixture.endpoint, enabled: true,
    connectTimeoutMs: 2000, requestTimeoutMs: 1000, reconnect: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20 } };
  config.bindings.first.credentialRef = "test-account";
  await manager.reconcile(config);
  assert.equal(manager.status("first").state, "connected");
  delete accounts["Bearer allowed"];
  await assert.rejects(manager.callTool({ bindingId: "first", toolName: "echo", arguments: { text: "denied" } }), codeIs("authentication_required"));
  assert.equal(manager.status("first").state, "authentication-required");
  assert.deepEqual(manager.tools("first"), []);
  await delay(80);
  assert.equal(fixture.fixtures.length, 1, "authentication failures do not loop through reconnect attempts");
  accounts["Bearer allowed"] = "alice";
  await manager.connect("first");
  assert.equal(manager.status("first").state, "connected");
  assert.equal((await manager.callTool({ bindingId: "first", toolName: "echo", arguments: { text: "again" } })).result.structuredContent?.account, "alice");
});
