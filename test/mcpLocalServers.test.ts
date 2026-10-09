import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { McpClientError } from "../src/mcp/client/errors";
import { launchEnvironment, OutputTail, resolveCommand } from "../src/mcp/client/launch";
import { McpClientManager } from "../src/mcp/client/McpClientManager";
import { SdkMcpConnector } from "../src/mcp/client/transports";
import type { McpConnector, McpServerDefinition } from "../src/mcp/client/types";

const fixture = path.join(__dirname, "fixtures", "mcpEditorLike.js");
const posix = process.platform !== "win32";
const server = (env: Record<string, string> = {}, extra: Partial<McpServerDefinition> = {}): McpServerDefinition =>
  ({ id: "editor", enabled: true, transport: "stdio", command: process.execPath, args: [fixture], env, connectTimeoutMs: 5_000, ...extra } as McpServerDefinition);
const options = (): Parameters<McpConnector["open"]>[2] => ({ signal: new AbortController().signal, timeoutMs: 5_000, onClose() {}, onError() {}, onToolsChanged() {} });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function eventually(check: () => boolean, message: string, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  while (!check()) { assert.ok(Date.now() < until, message); await delay(20); }
}
async function folder(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-mcp-local-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("a server starts with the variables Codex passes, a PATH that finds terminal tools, and its own variables last", () => {
  process.env.LCAI_UNRELATED_APP_VARIABLE = "not for servers";
  try {
    const env = launchEnvironment({ BLENDER_PORT: "9876" }, ["/from/login/shell", "/usr/bin"].join(path.delimiter));
    assert.equal(env.LCAI_UNRELATED_APP_VARIABLE, undefined, "the app's other variables stay with the app");
    assert.equal(env.BLENDER_PORT, "9876");
    const folders = env.PATH!.split(path.delimiter);
    assert.equal(folders[0], "/from/login/shell", "the login shell's PATH comes first");
    assert.equal(new Set(folders).size, folders.length, "each folder once");
    assert.equal(launchEnvironment({ PATH: "/only/this" }, "/from/login/shell").PATH, "/only/this", "a PATH the server sets is used as given");
  } finally { delete process.env.LCAI_UNRELATED_APP_VARIABLE; }
});

test("a command is found on PATH or from its folder, and a missing or non-executable one is not", { skip: !posix }, async t => {
  const root = await folder(t);
  const tool = path.join(root, "bin", "uvx");
  await fs.mkdir(path.dirname(tool));
  await fs.writeFile(tool, "#!/bin/sh\n", { mode: 0o755 });
  await fs.writeFile(path.join(root, "bin", "plain"), "", { mode: 0o644 });
  const env = { PATH: ["/nowhere", path.join(root, "bin")].join(":") };
  assert.equal(resolveCommand("uvx", env), tool);
  assert.equal(resolveCommand("./bin/uvx", env, root), tool);
  assert.equal(resolveCommand("missing-tool", env), undefined);
  assert.equal(resolveCommand("plain", env), undefined, "not executable");
});

test("a server's output keeps its last lines without colours or credentials", () => {
  const tail = new OutputTail(["sk-private-value-123"], 64);
  tail.append("old line that falls out of the window ".repeat(4));
  tail.append("\u001b[31mError\u001b[0m: key sk-private-value-123, Authorization: Bearer abc.def.ghi password=hunter22\n");
  const text = tail.read();
  assert.ok(text.length <= 64);
  assert.doesNotMatch(text, /sk-private|abc\.def|hunter22|\u001b/);
  assert.match(text, /‹hidden›/);
});

test("a missing command and a server that exits while starting say why, for the host only", async t => {
  const connector = new SdkMcpConnector();
  await assert.rejects(connector.open(server({}, { command: "lcai-no-such-mcp-command" } as Partial<McpServerDefinition>), { id: "editor", serverId: "editor", enabled: true }, options()),
    (error: unknown) => error instanceof McpClientError && error.code === "command_not_found" && /lcai-no-such-mcp-command/.test(error.detail ?? ""));
  const gate = path.join(await folder(t), "editor-running");
  await assert.rejects(connector.open(server({ MCP_GATE_FILE: gate }), { id: "editor", serverId: "editor", enabled: true }, options()), (error: unknown) => {
    assert.ok(error instanceof McpClientError);
    assert.equal(error.code, "server_exited");
    assert.match(error.detail ?? "", /exited with code 3/);
    assert.match(error.detail ?? "", /the editor is not running \(token=‹hidden›\)/);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /editor is not running|secret123456/, "the text devices could see carries no output");
    return true;
  });
});

test("stopping a server stops what it started too (a launcher's grandchild)", { skip: !posix, timeout: 20_000 }, async t => {
  const pidFile = path.join(await folder(t), "grandchild.pid");
  const connection = await new SdkMcpConnector().open(server({ MCP_GRANDCHILD_PID_FILE: pidFile }), { id: "editor", serverId: "editor", enabled: true }, options());
  const grandchild = Number(await fs.readFile(pidFile, "utf8"));
  assert.ok(alive(grandchild));
  await connection.close();
  await eventually(() => !alive(grandchild), "the grandchild is stopped");
});

test("a tool with an unusable schema is left out and the server's other tools work", { timeout: 20_000 }, async t => {
  const manager = new McpClientManager();
  t.after(() => manager.dispose());
  await manager.reconcile({ servers: { editor: server() }, bindings: { editor: { id: "editor", serverId: "editor", enabled: true } } });
  assert.equal(manager.status("editor").state, "connected");
  assert.deepEqual(manager.status("editor").skippedTools, ["bad_schema"]);
  assert.deepEqual(manager.tools("editor").map(tool => tool.definition.name).sort(), ["ok", "progress_op", "quiet_op"]);
  assert.equal((await manager.callTool({ bindingId: "editor", toolName: "ok" })).outcome, "success");
});

test("a long call that reports progress runs past the timeout; a silent one does not", { timeout: 20_000 }, async t => {
  const manager = new McpClientManager();
  t.after(() => manager.dispose());
  await manager.reconcile({ servers: { editor: server({}, { requestTimeoutMs: 400 }) }, bindings: { editor: { id: "editor", serverId: "editor", enabled: true } } });
  let progress = 0;
  const long = await manager.callTool({ bindingId: "editor", toolName: "progress_op", arguments: { steps: 6, intervalMs: 200 } }, { onProgress: () => { progress++; } });
  assert.equal(long.outcome, "success", "1.2 s of work with progress every 0.2 s");
  assert.equal(progress, 6);
  await assert.rejects(manager.callTool({ bindingId: "editor", toolName: "quiet_op", arguments: { delayMs: 1_200 } }),
    (error: unknown) => error instanceof McpClientError && error.code === "timeout");
});

test("an editor started after the app: its server failed, and is connected on next use", { timeout: 30_000 }, async t => {
  const gate = path.join(await folder(t), "editor-running");
  const manager = new McpClientManager({ reviveIntervalMs: 0 });
  t.after(() => manager.dispose());
  await manager.reconcile({ servers: { editor: server({ MCP_GATE_FILE: gate }, { reconnect: { maxAttempts: 0, initialDelayMs: 10, maxDelayMs: 10 } }) },
    bindings: { editor: { id: "editor", serverId: "editor", enabled: true } } });
  const failed = manager.status("editor");
  assert.equal(failed.state, "error");
  assert.equal(failed.error?.code, "server_exited");
  assert.match(failed.diagnostic ?? "", /the editor is not running/);
  await fs.writeFile(gate, "");
  await manager.revive(10_000);
  const revived = manager.status("editor");
  assert.equal(revived.state, "connected");
  assert.equal(revived.diagnostic, undefined);
  // Disconnected by the user: left alone.
  await manager.disconnect("editor");
  await manager.revive(1_000);
  assert.equal(manager.status("editor").state, "disconnected");
});
