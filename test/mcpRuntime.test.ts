import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RuntimeManager } from "../src/app/RuntimeManager";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import { AppConfig, config } from "../src/config/config";
import type { McpClientConfiguration } from "../src/mcp/client/types";
import { Logger } from "../src/utils/Logger";

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function eventually(check: () => boolean, message: string) {
  const until = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < until, message); await delay(10); }
}

async function runtimeFixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-"));
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, value]) => [id, { ...value, enabled: false, apiKey: "" }])) as AppConfig["providers"];
  const options: AppConfig = {
    ...config, providers, appDataDir: path.join(root, "app"),
    mcp: { ...config.mcp, client: { servers: {}, bindings: {} } },
    sessions: { baseDir: path.join(root, "sessions") },
    memory: { ...config.memory, adapter: "local-json", baseDir: path.join(root, "memory") },
    outputDir: path.join(root, "output"),
    plugins: { dir: path.resolve(process.cwd(), "plugins"), overrides: {} },
    telegram: { ...config.telegram, enabled: false, botToken: "" },
    localModels: { ...config.localModels!, runtimeDir: path.join(root, "runtime"), executablePath: undefined,
      modelsDir: path.join(root, "models"), contextSize: 4096 }
  };
  const store = new AppSettingsStore(options.appDataDir, options);
  const manager = new RuntimeManager(options, store, new Logger());
  await manager.init();
  t.after(async () => { await manager.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const outbound: McpClientConfiguration = {
    servers: { fixture: { id: "fixture", enabled: true, transport: "stdio", command: process.execPath,
      args: [path.join(__dirname, "fixtures", "mcpStdio.js")], connectTimeoutMs: 3000, requestTimeoutMs: 2000,
      reconnect: { maxAttempts: 0, initialDelayMs: 10, maxDelayMs: 10 } } },
    bindings: { first: { id: "first", serverId: "fixture", enabled: true }, second: { id: "second", serverId: "fixture", enabled: true } }
  };
  return { root, options, store, manager, outbound };
}

test("runtime retains MCP owner and active calls across unrelated settings; disabling one binding isolates cleanup", { timeout: 15000 }, async t => {
  const { manager, outbound } = await runtimeFixture(t);
  await manager.updateSettings({ mcp: { client: outbound } });
  const originalRuntime = manager.getRuntime();
  const clients = originalRuntime.mcpClients;
  assert.deepEqual(clients.list().map(status => status.state), ["connected", "connected"]);
  const identity = async (bindingId: string) => (await clients.callTool({ bindingId, toolName: "echo", arguments: { text: "identity" } })).result.structuredContent as { pid: number };
  const firstPid = (await identity("first")).pid;
  const secondPid = (await identity("second")).pid;
  assert.notEqual(firstPid, secondPid);
  const pending = clients.callTool({ bindingId: "first", toolName: "slow", arguments: { delayMs: 350, text: "survived settings" } });
  await delay(30);
  const before = await manager.getSettings();
  await manager.updateSettings({ memory: { topK: before.memory.topK + 1 } });
  assert.notEqual(manager.getRuntime(), originalRuntime);
  assert.equal(manager.getRuntime().mcpClients, clients);
  assert.equal((await pending).result.structuredContent?.text, "survived settings");
  assert.equal((await identity("first")).pid, firstPid);
  const interrupted = clients.callTool({ bindingId: "first", toolName: "slow", arguments: { delayMs: 1000 } });
  const rejection = assert.rejects(interrupted);
  await delay(20);
  await manager.updateSettings({ mcp: { client: { bindings: { first: { enabled: false } } } } });
  await rejection;
  assert.equal(clients.status("first").enabled, false);
  assert.deepEqual(clients.tools("first"), []);
  await eventually(() => !isAlive(firstPid), "disabled binding child is cleaned up");
  assert.equal((await identity("second")).pid, secondPid);
  assert.ok(manager.getRuntime().tools.some(tool => tool.name === "file"));
  assert.ok(manager.getRuntime().tools.some(tool => tool.name === "command"));
  await manager.dispose();
  await eventually(() => !isAlive(secondPid), "runtime shutdown cleans remaining child");
});

test("runtime restores persisted MCP configuration on restart with fresh live connections", { timeout: 15000 }, async t => {
  const { manager, outbound, options } = await runtimeFixture(t);
  await manager.updateSettings({ mcp: { client: outbound } });
  const first = manager.getRuntime().mcpClients;
  const oldPid = (await first.callTool({ bindingId: "first", toolName: "echo", arguments: { text: "before" } })).result.structuredContent?.pid as number;
  const saved = await manager.getSettings();
  assert.equal(saved.mcp.server.defaultSessionId, options.mcp.server.defaultSessionId);
  assert.ok(!JSON.stringify(saved.mcp.client).includes('"state"'));
  await manager.dispose();
  const restarted = new RuntimeManager(options, new AppSettingsStore(options.appDataDir, options), new Logger());
  t.after(() => restarted.dispose());
  const runtime = await restarted.init();
  assert.notEqual(runtime.mcpClients, first);
  assert.equal(runtime.mcpClients.status("first").state, "connected");
  const next = await runtime.mcpClients.callTool({ bindingId: "first", toolName: "sum", arguments: { a: 7, b: 8 } });
  assert.equal(next.result.structuredContent?.sum, 15);
  assert.notEqual(next.result.structuredContent?.pid, oldPid);
  assert.equal(isAlive(oldPid), false);
});

test("inbound MCP entrypoint initializes, lists runtime and model controls, and persists session updates", { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-inbound-"));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(__dirname, "../src/mcp.js")], cwd: root, stderr: "pipe", env: {
      APP_DATA_DIR: path.join(root, "app"), SESSION_DIR: path.join(root, "sessions"),
      MEMORY_DIR: path.join(root, "memory"), MEMORY_ADAPTER: "local-json", OUTPUT_DIR: path.join(root, "output"),
      PLUGINS_DIR: path.resolve(process.cwd(), "plugins"), LLAMA_RUNTIME_DIR: path.join(root, "runtime"),
      LOCAL_MODELS_DIR: path.join(root, "models"), LOCAL_COGNITIVE_CONFIG: path.join(root, "absent-config.json"),
      MCP_ENABLED: "true", MCP_DEFAULT_SESSION_ID: "inbound-fixture", TELEGRAM_ENABLED: "false"
    } });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "inbound-regression-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  await client.connect(transport, { timeout: 3000 });
  const pid = transport.pid!;
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [
    "local_ai_chat", "local_ai_code", "local_ai_get_session_settings", "local_ai_hypothesis", "local_ai_list_models", "local_ai_load_model", "local_ai_local_model_status", "local_ai_runtime_status", "local_ai_unload_model", "local_ai_update_session_settings"
  ]);
  const status = await client.callTool({ name: "local_ai_runtime_status", arguments: {} });
  const content = status.content as Array<{ type: string; text?: string }>;
  const runtime = JSON.parse(content.find(item => item.type === "text")!.text!);
  assert.equal(runtime.defaultSessionId, "inbound-fixture");
  assert.ok(runtime.tools.some((tool: { name: string }) => tool.name === "file"));
  assert.ok(runtime.tools.some((tool: { name: string }) => tool.name === "command"));
  const updated = await client.callTool({ name: "local_ai_update_session_settings", arguments: { patch: { language: "en", mode: "general" } } });
  assert.ok(!updated.isError);
  const session = await client.callTool({ name: "local_ai_get_session_settings", arguments: {} });
  const payload = session.structuredContent as { result: { sessionId: string; settings: { language: string; mode: string } } };
  assert.equal(payload.result.sessionId, "inbound-fixture");
  assert.equal(payload.result.settings.language, "en");
  assert.equal(payload.result.settings.mode, "general");
  await client.close();
  await eventually(() => !isAlive(pid), "inbound server exits after transport cleanup");
});
