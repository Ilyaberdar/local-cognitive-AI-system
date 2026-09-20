import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SdkMcpConnector } from "../src/mcp/client/transports";
import { McpClientError } from "../src/mcp/client/errors";
import { McpConnectionBinding, McpConnector, McpServerDefinition } from "../src/mcp/client/types";

const fixturePath = path.join(__dirname, "fixtures", "mcpStdio.js");
const definition = (): McpServerDefinition => ({
  id: "fixture", enabled: true, transport: "stdio", command: process.execPath, args: [fixturePath],
  connectTimeoutMs: 2_000, requestTimeoutMs: 2_000
});
const binding: McpConnectionBinding = { id: "account-a", serverId: "fixture", enabled: true };
const openOptions = (overrides: Partial<Parameters<McpConnector["open"]>[2]> = {}): Parameters<McpConnector["open"]>[2] => ({
  signal: new AbortController().signal, timeoutMs: 2_000,
  onClose() {}, onError() {}, onToolsChanged() {}, ...overrides
});
const errorCode = (code: string) => (error: unknown) => error instanceof McpClientError && error.code === code;
async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail("Fixture condition was not reached");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("SDK stdio adapter initializes, paginates, preserves results and cleans its owned process", async t => {
  let closed = 0;
  let changed = 0;
  const connection = await new SdkMcpConnector().open(definition(), { ...binding, credentialRef: "fixture-key" }, openOptions({
    credentialProvider: { resolve: async () => ({ env: { FIXTURE_ACCOUNT: "account-a" } }) },
    onClose() { closed++; }, onToolsChanged() { changed++; }
  }));
  t.after(() => connection.close());
  const first = await connection.listTools(undefined, {});
  const second = await connection.listTools(first.nextCursor, {});
  assert.deepEqual(first.tools.map(tool => tool.name), ["echo", "sum"]);
  assert.deepEqual(second.tools.map(tool => tool.name), ["tool_error", "protocol_error"]);
  const result = await connection.callTool("echo", { text: "hello stdio" }, {});
  assert.deepEqual(result.content, [{ type: "text", text: "hello stdio" }]);
  assert.equal(result.structuredContent?.account, "account-a");
  const pid = result.structuredContent?.pid as number;
  assert.ok(Number.isSafeInteger(pid) && pid !== process.pid);
  await connection.callTool("change_tools", {}, {});
  await eventually(() => changed === 1);
  await Promise.all([connection.close(), connection.close()]);
  await eventually(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  assert.equal(closed, 1);
  await assert.rejects(connection.callTool("echo", { text: "late" }, {}), errorCode("disconnected"));
});

test("SDK adapter sends cancellation and rejects an already cancelled call before dispatch", async t => {
  const connection = await new SdkMcpConnector().open(definition(), binding, openOptions());
  t.after(() => connection.close());
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(connection.callTool("echo", { text: "must not dispatch" }, { signal: cancelled.signal }), errorCode("cancelled"));
  const controller = new AbortController();
  const pending = connection.callTool("slow", { delayMs: 10_000 }, { signal: controller.signal });
  const outcome = assert.rejects(pending, errorCode("cancelled"));
  await new Promise(resolve => setTimeout(resolve, 40));
  controller.abort();
  await outcome;
  const stats = await connection.callTool("stats", {}, {});
  const calls = stats.structuredContent?.calls as Array<{ name: string }>;
  assert.equal(calls.filter(call => call.name === "echo").length, 0);
  assert.equal(calls.filter(call => call.name === "slow").length, 1);
  assert.equal(stats.structuredContent?.cancellations, 1);
  await assert.rejects(connection.callTool("slow", { delayMs: 10_000 }, { timeoutMs: 30 }), errorCode("timeout"));
});

test("SDK adapter classifies startup failure, protocol failure and missing credentials without private diagnostics", async t => {
  const connector = new SdkMcpConnector();
  await assert.rejects(connector.open({ ...definition(), transport: "stdio", command: path.join(os.tmpdir(), "missing-mcp-executable-private"), args: [] }, binding, openOptions()), errorCode("transport_error"));
  await assert.rejects(connector.open(definition(), { ...binding, credentialRef: "private-secret-reference" }, openOptions()), errorCode("authentication_required"));
  const connection = await connector.open(definition(), binding, openOptions());
  t.after(() => connection.close());
  const toolResult = await connection.callTool("tool_error", {}, {});
  assert.equal(toolResult.isError, true);
  await assert.rejects(connection.callTool("protocol_error", {}, {}), error => {
    assert.ok(error instanceof McpClientError);
    assert.equal(error.code, "protocol_error");
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
});

test("a provider ignoring cancellation is bounded and cannot launch a late subprocess", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-provider-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "late-process");
  let resolveCredentials!: (value: { env: Record<string, string> }) => void;
  let providerSignal: AbortSignal | undefined;
  const blocked = new Promise<{ env: Record<string, string> }>(resolve => { resolveCredentials = resolve; });
  const pending = new SdkMcpConnector().open({
    ...definition(), transport: "stdio", command: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'unexpected')", marker]
  }, { ...binding, credentialRef: "fixture-ref" }, openOptions({
    timeoutMs: 25,
    credentialProvider: { resolve: async context => { providerSignal = context.signal; return blocked; } }
  }));
  await assert.rejects(pending, errorCode("timeout"));
  assert.equal(providerSignal?.aborted, true);
  resolveCredentials({ env: {} });
  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
});

test("SDK HTTP authentication challenges are redacted and unreachable endpoints fail", async t => {
  const server = http.createServer((_request, response) => {
    response.writeHead(401, { "www-authenticate": 'Bearer realm="fixture"', "content-type": "text/plain" });
    response.end("fixture-private-token");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const remote: McpServerDefinition = { id: "fixture", enabled: true, transport: "streamable-http", endpoint: `http://127.0.0.1:${address.port}/mcp` };
  const errors: unknown[] = [];
  const order: string[] = [];
  await assert.rejects(new SdkMcpConnector().open(remote, binding, openOptions({
    onError: error => { errors.push(error); order.push("authentication-error"); },
    onClose: () => { order.push("close"); }
  })), error => { order.push("rejection"); return errorCode("authentication_required")(error); });
  assert.deepEqual(order, ["authentication-error", "close", "rejection"]);
  assert.ok(errors.length > 0);
  assert.doesNotMatch(JSON.stringify(errors), /fixture-private-token/);
  await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  await assert.rejects(new SdkMcpConnector().open(remote, binding, openOptions({ timeoutMs: 500 })), errorCode("transport_error"));
});

test("SDK HTTP late replies after interruption preserve concurrent calls", { timeout: 10_000 }, async t => {
  // A server can finish a request before it observes cancellation. Keep responses
  // under test control so a cancelled request's reply precedes a live request's reply.
  const pending = new Map<string, { response: http.ServerResponse; id: number }>();
  const calls: string[] = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(request.method === "GET" ? 405 : 200);
      response.end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.method === "initialize") {
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "late-reply-fixture" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: "late-reply-fixture", version: "1.0.0" }
      } }));
    } else if (message.method === "tools/call") {
      calls.push(message.params.name);
      pending.set(message.params.name, { response, id: message.id });
    } else {
      response.writeHead(202);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const errors: unknown[] = [];
  const connection = await new SdkMcpConnector().open({
    id: "fixture", enabled: true, transport: "streamable-http", endpoint: `http://127.0.0.1:${address.port}/mcp`
  }, binding, openOptions({ onError: error => { errors.push(error); } }));
  t.after(() => connection.close());
  const reply = (name: string) => {
    const request = pending.get(name);
    assert.ok(request);
    pending.delete(name);
    request.response.writeHead(200, { "content-type": "application/json" });
    request.response.end(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      result: { content: [{ type: "text", text: name }] } }));
  };

  for (const interruption of ["timeout", "cancelled"] as const) {
    const liveName = `live-${interruption}`;
    const lateName = `late-${interruption}`;
    const controller = new AbortController();
    const live = connection.callTool(liveName, {}, {});
    const interrupted = connection.callTool(lateName, {}, {
      signal: controller.signal, timeoutMs: interruption === "timeout" ? 100 : 2_000
    });
    const rejected = assert.rejects(interrupted, errorCode(interruption));
    await eventually(() => pending.has(liveName) && pending.has(lateName));
    if (interruption === "cancelled") controller.abort();
    await rejected;
    reply(lateName);
    // Let the client consume the late reply while the concurrent request remains active.
    await new Promise(resolve => setTimeout(resolve, 50));
    reply(liveName);
    assert.deepEqual((await live).content, [{ type: "text", text: liveName }]);
    assert.deepEqual(errors, [], "late replies are protocol diagnostics, not transport failures");
  }
  assert.deepEqual(calls, ["live-timeout", "late-timeout", "live-cancelled", "late-cancelled"]);
  await connection.close();
});
