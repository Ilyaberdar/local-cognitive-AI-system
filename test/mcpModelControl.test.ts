import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LocalModelService } from "../src/local/LocalModelService";
import { LocalModelOptions, LocalModelSnapshot } from "../src/local/types";
import { SessionSettings } from "../src/types";
import { Logger } from "../src/utils/Logger";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
type ModelStatus = LocalModelSnapshot & { providerId: string; available: boolean };
type ModelLoaded = ModelStatus & { modelId: string; selectedForSession: boolean; sessionId?: string };
type NativeProcess = { pid: number; port: number; model: string };

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const eventually = async (check: () => boolean | Promise<boolean>, message: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await delay(20);
  }
};

const success = <T>(response: ToolResult): T => {
  assert.ok(!response.isError, JSON.stringify(response.content));
  assert.ok(response.structuredContent, "MCP tools must return structured results");
  return (response.structuredContent as { result: T }).result;
};

const failure = (response: ToolResult, code?: string): { code: string; message: string } => {
  assert.equal(response.isError, true, "A failed operation must be an MCP tool error");
  const { error } = (response.structuredContent as { result: { error: { code: string; message: string } } }).result;
  assert.ok(error.code);
  assert.ok(error.message);
  if (code) assert.equal(error.code, code);
  return error;
};

// Valid metadata for the application's importer; inference is supplied by the fixture process.
const minimalGguf = (): Buffer => {
  const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
  const u64 = (value: number) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
  const string = (value: string) => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
  const entries = { "general.architecture": "llama", "general.name": "MCP lifecycle fixture", "tokenizer.chat_template": "{{ messages }}" };
  return Buffer.concat([
    Buffer.from("GGUF"), u32(3), u64(0), u64(Object.keys(entries).length),
    ...Object.entries(entries).map(([key, value]) => Buffer.concat([string(key), u32(8), string(value)])),
    Buffer.alloc(128)
  ]);
};

async function fixture(t: TestContext, options: { missingRuntime?: boolean; emptyLibrary?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-model-control-"));
  const executable = path.join(root, "fake-llama-server");
  const processRecord = path.join(root, "native-process.json");
  const requestRecord = path.join(root, "native-requests.jsonl");
  const controlFile = path.join(root, "native-control.json");
  await fs.writeFile(controlFile, "{}");
  await fs.writeFile(executable, `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
const control = () => JSON.parse(fs.readFileSync(path.join(root, 'native-control.json'), 'utf8'));
const server = http.createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/health') {
    const ready = control().healthReady !== false;
    response.statusCode = ready ? 200 : 503;
    response.end(JSON.stringify({ status: ready ? 'ok' : 'loading model' }));
    return;
  }
  if (request.headers.authorization !== 'Bearer ' + process.env.LLAMA_API_KEY) {
    response.statusCode = 401; response.end('{}'); return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body || '{}');
  fs.appendFileSync(path.join(root, 'native-requests.jsonl'), JSON.stringify({ model: payload.model, url: request.url }) + '\\n');
  if (control().holdResponses) return;
  response.end(JSON.stringify({ status: 'completed', output_text: 'The answer is 5.' }));
});
server.listen(Number(arg('--port')), '127.0.0.1', () => {
  fs.writeFileSync(path.join(root, 'native-process.json'), JSON.stringify({ pid: process.pid, port: server.address().port, model: arg('--alias') }));
});
`, { mode: 0o755 });
  const modelOptions: LocalModelOptions = {
    enabled: true, dataDir: path.join(root, "app", "local-models"), modelsDir: path.join(root, "models"),
    runtimeDir: root, executablePath: executable, contextSize: 512, gpuLayers: 0,
    loadTimeoutMs: 10000, generationTimeoutMs: 10000, memoryLimitPercent: 75
  };
  const service = new LocalModelService(modelOptions, new Logger());
  let modelId = "";
  try {
    await service.init();
    if (!options.emptyLibrary) {
      const modelPath = path.join(root, "fixture-Q4_K_M.gguf");
      await fs.writeFile(modelPath, minimalGguf());
      modelId = (await service.importModel([modelPath])).id;
    }
  } finally { await service.dispose(); }
  await fs.mkdir(path.join(root, "plugins"));
  const client = new Client({ name: "mcp-model-control-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.resolve(__dirname, "../src/mcp.js")], cwd: root, stderr: "pipe",
    env: {
      APP_DATA_DIR: path.join(root, "app"), LOCAL_MODELS_DIR: modelOptions.modelsDir,
      SESSION_DIR: path.join(root, "sessions"), MEMORY_DIR: path.join(root, "memory"), MEMORY_ADAPTER: "local-json",
      OUTPUT_DIR: path.join(root, "output"), PLUGINS_DIR: path.join(root, "plugins"),
      LLAMA_RUNTIME_DIR: root, LLAMA_SERVER_PATH: options.missingRuntime ? path.join(root, "missing-llama-server") : executable,
      LLAMA_MODEL: "", LLAMA_CONTEXT_SIZE: "512", LLAMA_GPU_LAYERS: "0",
      LLAMA_LOAD_TIMEOUT_MS: "10000", LLAMA_GENERATION_TIMEOUT_MS: "10000",
      DEFAULT_PROVIDER: "llamacpp", LOCAL_COGNITIVE_CONFIG: path.join(root, "absent-config.json"),
      MCP_ENABLED: "true", MCP_DEFAULT_SESSION_ID: "mcp-model-test", TELEGRAM_ENABLED: "false"
    }
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-5000); });
  const nativeProcess = async (): Promise<NativeProcess | undefined> => {
    try { return JSON.parse(await fs.readFile(processRecord, "utf8")) as NativeProcess; }
    catch { return undefined; }
  };
  t.after(async () => {
    await client.close();
    const native = await nativeProcess();
    if (native) await eventually(() => !isAlive(native.pid), "Closing MCP must stop its native model process");
    if (transport.pid) await eventually(() => !isAlive(transport.pid!), "Closing MCP must stop its server process");
    await fs.rm(root, { recursive: true, force: true });
  });
  try { await client.connect(transport, { timeout: 5000 }); }
  catch (error) { throw new Error(`MCP fixture did not connect: ${String(error)}\n${stderr}`); }
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 12000 });
  const status = async () => success<ModelStatus>(await call("local_ai_local_model_status"));
  const session = async (sessionId?: string) => success<{ sessionId: string; settings: SessionSettings }>(
    await call("local_ai_get_session_settings", sessionId ? { sessionId } : {})
  );
  const control = (value: Record<string, unknown>) => fs.writeFile(controlFile, JSON.stringify(value));
  const requestCount = async (): Promise<number> => {
    try { return (await fs.readFile(requestRecord, "utf8")).trim().split("\n").filter(Boolean).length; }
    catch { return 0; }
  };
  return { client, transport, modelId, call, status, session, nativeProcess, control, requestCount };
}

const nativeFixtureOptions = { timeout: 25000, skip: process.platform === "win32" };

test("inbound MCP loads a model, selects one session, chats, unloads, and automatically reloads", nativeFixtureOptions, async t => {
  const { client, transport, modelId, call, status, session, nativeProcess, requestCount } = await fixture(t);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ["local_ai_local_model_status", "local_ai_load_model", "local_ai_unload_model"]) assert.ok(names.includes(name));
  const before = await status();
  assert.equal(before.providerId, "llamacpp");
  assert.equal(before.available, true);
  assert.equal(before.runtime.status, "stopped");
  assert.deepEqual(before.models.map(model => [model.id, model.loaded]), [[modelId, false]]);
  const listed = success<{ models: Array<{ id: string }>; managedModels: Array<{ id: string }> }>(
    await call("local_ai_list_models", { providerId: "llamacpp", includeManagedModels: true })
  );
  assert.ok(listed.models.some(model => model.id === modelId));
  assert.ok(listed.managedModels.some(model => model.id === modelId));

  const untouched = await session("untouched");
  const loaded = success<ModelLoaded>(await call("local_ai_load_model", { modelId, sessionId: "untouched" }));
  assert.equal(loaded.modelId, modelId);
  assert.equal(loaded.selectedForSession, false);
  assert.equal(loaded.runtime.status, "ready");
  assert.equal(loaded.models[0].loaded, true);
  assert.deepEqual(await session("untouched"), untouched, "Loading must not implicitly change the session's target");
  const firstNative = (await nativeProcess())!;
  assert.ok(isAlive(firstNative.pid));
  const unauthorized = await fetch(`http://127.0.0.1:${firstNative.port}/v1/responses`);
  assert.equal(unauthorized.status, 401);

  success(await call("local_ai_update_session_settings", { sessionId: "selected", patch: { language: "en", mode: "general" } }));
  const selected = success<ModelLoaded>(await call("local_ai_load_model", { modelId, sessionId: "selected", selectForSession: true }));
  assert.equal(selected.selectedForSession, true);
  assert.equal(selected.sessionId, "selected");
  assert.equal((await nativeProcess())!.pid, firstNative.pid, "Loading an already loaded model must reuse its process");
  const selectedSettings = (await session("selected")).settings;
  assert.deepEqual(selectedSettings.defaultTarget, { providerId: "llamacpp", model: modelId });
  assert.equal(selectedSettings.language, "en");
  assert.deepEqual(await session("untouched"), untouched, "Selecting one session must not change other sessions");

  const chat = success<{ providerId: string; sessionId: string; result: { response: string; error?: string } }>(
    await call("local_ai_chat", { input: "What is two plus three?", sessionId: "selected", mode: "general" })
  );
  assert.equal(chat.providerId, "llamacpp");
  assert.equal(chat.sessionId, "selected");
  assert.equal(chat.result.error, undefined);
  assert.equal(chat.result.response, "The answer is 5.");
  assert.ok(await requestCount() > 0, "The chat must reach the native fixture over HTTP");

  const unloaded = success<ModelStatus>(await call("local_ai_unload_model", { modelId }));
  assert.equal(unloaded.runtime.status, "stopped");
  assert.equal(unloaded.models[0].loaded, false);
  await eventually(() => !isAlive(firstNative.pid), "Explicit unload must release the model process");
  assert.deepEqual((await session("selected")).settings.defaultTarget, selectedSettings.defaultTarget);
  const reloaded = success<{ result: { response: string; error?: string } }>(
    await call("local_ai_chat", { input: "What is two plus three?", sessionId: "selected", mode: "general" })
  );
  assert.equal(reloaded.result.error, undefined);
  assert.equal(reloaded.result.response, "The answer is 5.");
  assert.equal((await status()).runtime.status, "ready");
  const secondNative = (await nativeProcess())!;
  assert.notEqual(secondNative.pid, firstNative.pid);
  const mcpPid = transport.pid!;
  await client.close();
  await eventually(() => !isAlive(mcpPid) && !isAlive(secondNative.pid), "MCP disconnect must clean up both processes");
});

test("inbound MCP returns actionable missing and unknown model errors without changing session selection", nativeFixtureOptions, async t => {
  const { call, session, status, nativeProcess } = await fixture(t, { emptyLibrary: true });
  assert.deepEqual((await status()).models, []);
  const missing = failure(await call("local_ai_chat", { input: "Hello", mode: "general", providerId: "llamacpp" }), "model_not_selected");
  assert.match(missing.message, /model|GGUF/i);
  const before = await session();
  failure(await call("local_ai_load_model", { modelId: "not-installed", selectForSession: true }), "model_not_installed");
  assert.deepEqual(await session(), before);
  failure(await call("local_ai_unload_model", { modelId: "not-installed" }), "model_not_installed");
  failure(await call("local_ai_chat", { input: "Hello", mode: "general", providerId: "llamacpp", model: "not-installed" }), "model_not_installed");
  assert.equal((await status()).runtime.status, "stopped");
  assert.equal(await nativeProcess(), undefined, "Invalid model requests must not start inference");
});

test("inbound MCP reports an unavailable native runtime and preserves selection after failed load", nativeFixtureOptions, async t => {
  const { modelId, call, status, session, nativeProcess } = await fixture(t, { missingRuntime: true });
  const snapshot = await status();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.runtime.status, "unavailable");
  const before = await session();
  const loadError = failure(await call("local_ai_load_model", { modelId, selectForSession: true }));
  assert.match(loadError.message, /runtime|llama|missing|unavailable/i);
  assert.deepEqual(await session(), before, "A failed load must not select the model for subsequent chats");
  failure(await call("local_ai_chat", { input: "Hello", mode: "general", providerId: "llamacpp", model: modelId }), "local_runtime_unavailable");
  assert.equal(await nativeProcess(), undefined);
});

test("inbound MCP cancellation removes queued loads and stops active loading before session selection", nativeFixtureOptions, async t => {
  const { client, modelId, call, status, session, nativeProcess, control } = await fixture(t);
  await control({ healthReady: false });
  const before = await session();
  const activeController = new AbortController();
  const active = client.callTool({ name: "local_ai_load_model", arguments: { modelId, selectForSession: true } }, undefined,
    { signal: activeController.signal, timeout: 12000 });
  const activeRejected = assert.rejects(active, /abort|cancel/i);
  await eventually(async () => Boolean(await nativeProcess()), "The active load must reach native startup");
  const native = (await nativeProcess())!;
  assert.equal((await status()).runtime.status, "loading");

  const queuedController = new AbortController();
  const queued = client.callTool({ name: "local_ai_load_model", arguments: { modelId, sessionId: "queued", selectForSession: true } }, undefined,
    { signal: queuedController.signal, timeout: 12000 });
  const queuedRejected = assert.rejects(queued, /abort|cancel/i);
  await eventually(async () => (await status()).runtime.queueLength > 0, "The second load must join the queue");
  queuedController.abort();
  await queuedRejected;
  await eventually(async () => (await status()).runtime.queueLength === 0, "Cancelling a queued load must remove it");
  assert.ok(isAlive(native.pid), "Cancelling queued work must not interrupt the active load");

  activeController.abort();
  await activeRejected;
  await eventually(async () => !(await status()).runtime.busy && !isAlive(native.pid), "Cancelling active loading must stop the native process");
  assert.deepEqual(await session(), before);
  assert.equal((await session("queued")).settings.defaultTarget.model, before.settings.defaultTarget.model);
  assert.equal((await status()).models[0].loaded, false);
  await control({});
  assert.equal(success<ModelLoaded>(await call("local_ai_load_model", { modelId })).runtime.status, "ready", "Cancelled loading must be retryable");
});

test("inbound MCP rejects unloading during inference and cancellation releases the model for later requests", nativeFixtureOptions, async t => {
  const { client, modelId, call, status, nativeProcess, control, requestCount } = await fixture(t);
  success(await call("local_ai_load_model", { modelId, selectForSession: true }));
  const native = (await nativeProcess())!;
  await control({ holdResponses: true });
  const controller = new AbortController();
  const running = client.callTool({ name: "local_ai_chat", arguments: { input: "Hello", mode: "general" } }, undefined,
    { signal: controller.signal, timeout: 12000 });
  const rejected = assert.rejects(running, /abort|cancel/i);
  await eventually(async () => await requestCount() > 0, "The chat must reach native inference");
  failure(await call("local_ai_unload_model", { modelId }), "model_busy");
  assert.ok(isAlive(native.pid));
  controller.abort();
  await rejected;
  await eventually(async () => !(await status()).runtime.busy && !isAlive(native.pid), "Chat cancellation must free inference and stop decoding");
  await control({});
  const next = success<{ result: { response: string; error?: string } }>(await call("local_ai_chat", { input: "Hello again", mode: "general" }));
  assert.equal(next.result.error, undefined);
  assert.equal(next.result.response, "The answer is 5.");
});
