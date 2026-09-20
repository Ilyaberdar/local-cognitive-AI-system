// Real, offline acceptance test. Imports a copy into a temporary library;
// never opens the source model's library manifests or session settings.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { LocalModelService } = require("../dist/src/local/LocalModelService.js");
const { Logger } = require("../dist/src/utils/Logger.js");

const projectDir = path.resolve(__dirname, "..");
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const record = data => console.log(JSON.stringify(data));

async function main() {
  const files = process.argv.slice(2).map(file => path.resolve(file));
  if (!files.length) throw new Error('Usage: npm run test:mcp-model -- "/absolute/path/model.gguf" [additional shards]');
  await Promise.all(files.map(file => fs.access(file)));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-native-smoke-"));
  const runtimeDir = path.resolve(process.env.LLAMA_RUNTIME_DIR || path.join(projectDir, "resources", "llama", `${process.platform}-${process.arch}`));
  const options = {
    enabled: true, dataDir: path.join(root, "app", "local-models"), modelsDir: path.join(root, "models"),
    runtimeDir, executablePath: process.env.LLAMA_SERVER_PATH,
    contextSize: 4096, gpuLayers: process.platform === "darwin" ? 99 : 0,
    loadTimeoutMs: 120000, generationTimeoutMs: 120000, memoryLimitPercent: 75
  };
  const service = new LocalModelService(options, new Logger());
  let client;
  let stderr = "";
  try {
    await service.init();
    assert.ok(service.available, service.snapshot().runtime.error);
    const model = await service.importModel(files);
    await service.dispose(); // Release ownership before starting the real MCP process.
    record({ check: "import-copy", modelId: model.id, sizeBytes: model.sizeBytes, source: files.map(file => path.basename(file)) });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(projectDir, "dist", "src", "mcp.js")], cwd: root, stderr: "pipe",
      env: {
        APP_DATA_DIR: path.join(root, "app"), LOCAL_MODELS_DIR: options.modelsDir,
        SESSION_DIR: path.join(root, "sessions"), MEMORY_DIR: path.join(root, "memory"), MEMORY_ADAPTER: "local-json",
        OUTPUT_DIR: path.join(root, "output"), PLUGINS_DIR: path.join(projectDir, "plugins"),
        LOCAL_COGNITIVE_CONFIG: path.join(root, "absent-config.json"),
        LLAMA_RUNTIME_DIR: runtimeDir, ...(options.executablePath ? { LLAMA_SERVER_PATH: options.executablePath } : {}),
        LLAMA_CONTEXT_SIZE: "4096", LLAMA_LOAD_TIMEOUT_MS: "120000", LLAMA_GENERATION_TIMEOUT_MS: "120000",
        DEFAULT_PROVIDER: "llamacpp", LLAMA_MODEL: "", MCP_ENABLED: "true", MCP_DEFAULT_SESSION_ID: "native-smoke",
        TELEGRAM_ENABLED: "false", OPENMEMORY_ENABLED: "false", LOG_LEVEL: "warn"
      }
    });
    transport.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
    client = new Client({ name: "native-model-acceptance", version: "1.0.0" });
    await client.connect(transport, { timeout: 10000 });
    const pid = transport.pid;
    let progressEvents = 0;
    const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, {
      timeout: 150000, onprogress: () => { progressEvents++; }
    });
    const ok = async (name, args) => {
      const response = await call(name, args);
      assert.ok(!response.isError, JSON.stringify(response));
      return response.structuredContent.result;
    };
    const initial = await ok("local_ai_local_model_status");
    assert.ok(initial.models.some(item => item.id === model.id && !item.loaded));
    const missing = await call("local_ai_chat", { input: "Say hello briefly.", mode: "general" });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.result.error.code, "model_not_selected");
    record({ check: "missing-selection", error: missing.structuredContent.result.error.code });

    const started = Date.now();
    const loaded = await ok("local_ai_load_model", { modelId: model.id, selectForSession: true });
    assert.equal(loaded.selectedForSession, true);
    const ready = await ok("local_ai_local_model_status");
    assert.equal(ready.runtime.status, "ready");
    assert.equal(ready.runtime.modelId, model.id);
    record({ check: "explicit-load", status: ready.runtime.status, backend: ready.runtime.backend, build: ready.runtime.version, durationMs: Date.now() - started });

    const chat = await ok("local_ai_chat", { input: "Reply briefly in English: say hello.", mode: "general" });
    assert.equal(chat.providerId, "llamacpp");
    assert.equal(chat.result.model, model.id);
    assert.ok(chat.result.response.trim());
    record({ check: "native-chat", answer: chat.result.response });

    const unloaded = await ok("local_ai_unload_model", { modelId: model.id });
    assert.equal(unloaded.runtime.status, "stopped");
    assert.ok(unloaded.models.every(item => !item.loaded));
    record({ check: "unload", status: unloaded.runtime.status });
    const reloaded = await ok("local_ai_chat", { input: "Say goodbye briefly in English.", mode: "general" });
    assert.ok(reloaded.result.response.trim());
    assert.equal((await ok("local_ai_local_model_status")).runtime.status, "ready");
    record({ check: "native-chat-autoload", answer: reloaded.result.response });

    const unknown = await call("local_ai_load_model", { modelId: "missing-test-model" });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.structuredContent.result.error.code, "model_not_installed");
    record({ check: "unknown-model", error: unknown.structuredContent.result.error.code });
    await ok("local_ai_unload_model", { modelId: model.id });
    await client.close();
    const deadline = Date.now() + 5000;
    while (pid && alive(pid) && Date.now() < deadline) await delay(20);
    assert.ok(!pid || !alive(pid), "MCP child must exit on close");
    record({ check: "complete", progressEvents, subprocessExited: true });
  } catch (error) {
    if (stderr) process.stderr.write(stderr);
    throw error;
  } finally {
    try { await client?.close(); }
    finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
