import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AppConfig, config } from "../src/config/config";
import { startBackend } from "../src/index";
import type { RuntimeKind } from "../src/runtime/db/DataRootLock";
import { emptyMcpConfiguration } from "../src/mcp/client/configuration";
import { builtInHostOperations, createHostOperations } from "../src/remote/host/hostRuntime";
import { OPERATIONS } from "../src/runtime/operationCatalog";

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

test("a host answers every operation of the catalog, and no other", { timeout: 60_000 }, async t => {
  const { backend, root } = await startTestBackend(t, "server");
  const host = createHostOperations({ backend, dataRoot: root });
  t.after(host.stop);
  const offered = Object.keys({ ...builtInHostOperations({ hostName: "h", kind: "server", status: () => ({}) }), ...host.operations }).sort();
  assert.deepEqual(offered, Object.keys(OPERATIONS).sort());
  assert.ok(fs.existsSync(path.join(root, "projects")), "the folder devices manage is made");
});

test("a host says what it is: its name, version, platform and kind", async () => {
  for (const kind of ["server", "desktop"] as const) {
    const info = await builtInHostOperations({ hostName: "MacBook", kind, status: () => ({ phase: "running" }) })["host.info"]!(undefined, {} as never) as Record<string, unknown>;
    assert.deepEqual({ name: info.name, platform: info.platform, kind: info.kind }, { name: "MacBook", platform: process.platform, kind });
    assert.equal(typeof info.version, "string");
  }
});
