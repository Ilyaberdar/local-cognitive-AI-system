import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { AppConfig, config } from "../../src/config/config";
import { startBackend } from "../../src/index";
import { emptyMcpConfiguration } from "../../src/mcp/client/configuration";
import type { RuntimeKind } from "../../src/runtime/db/DataRootLock";

/** A backend on a data root of the test, with no HTTP, UI, providers, MCP or Telegram. */
export const startTestBackend = async (t: TestContext, runtimeKind: RuntimeKind) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lc-host-runtime-"));
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, value]) => [id, { ...value, enabled: false, apiKey: "" }])) as AppConfig["providers"];
  const options: AppConfig = {
    ...config, providers, compatibleProviders: {}, appDataDir: path.join(root, "app"), outputDir: path.join(root, "output"),
    sessions: { baseDir: path.join(root, "sessions") }, memory: { ...config.memory, adapter: "local-json", baseDir: path.join(root, "memory") },
    mcp: { client: emptyMcpConfiguration(), server: { ...config.mcp.server, enabled: false } },
    plugins: { dir: path.resolve(process.cwd(), "plugins"), overrides: {} }, telegram: { ...config.telegram, enabled: false, botToken: "" },
    server: { ...config.server, enabled: false }, ui: { ...config.ui, serve: false },
    localModels: { ...config.localModels!, runtimeDir: path.join(root, "runtime"), executablePath: undefined, modelsDir: path.join(root, "models"), contextSize: 4096 }
  };
  const backend = await startBackend(options, {}, { runtimeKind });
  t.after(async () => { await backend.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { backend, root };
};
