import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { OPERATIONS } from "../src/runtime/operationCatalog";
import { createDiagnosticsOperations } from "../src/runtime/diagnosticsOperations";
import { collectRuntimeDiagnostics, runtimeDiagnosticsSchema } from "../src/diagnostics/snapshot";

const CANARY = "canary-SECRET";
/** A runtime whose every readable part carries a name, a path or a key that must not leave. */
const runtimeManager = {
  getRuntime: () => ({
    localModelService: { snapshot: () => ({ runtime: { status: "ready", backend: "cuda", runtimeId: "linux-x64-cuda12", placement: { kind: "single-gpu" },
      loadedModelIds: [`/home/${CANARY}/models/my-private.gguf`], modelsDir: `/home/${CANARY}/models`, error: `failed at /home/${CANARY}`, fallbackReason: undefined,
      gpus: [{ id: "GPU-1", index: 0, name: "NVIDIA GeForce RTX 4090", totalBytes: 24 * 1024 ** 3, freeBytes: 1 }, { id: "GPU-2", index: 1, name: `<script>${CANARY}`, totalBytes: 1, freeBytes: 1 }] } }) },
    mcpClients: { list: () => [{ bindingId: CANARY, serverId: CANARY, enabled: true, state: "error", reconnectAttempt: 1, error: { code: "command_not_found", message: CANARY }, diagnostic: `/Users/${CANARY}/bin` },
      { bindingId: "b", serverId: "blender", enabled: true, state: "connected", reconnectAttempt: 0 }] }
  }),
  getSettings: async () => ({ providers: { openai: { enabled: true, apiKey: `sk-${CANARY}`, baseUrl: `https://${CANARY}.example` }, ollama: { enabled: false } } })
} as never;
const log = { tail: () => [
  { at: "2026-10-10T01:00:00.000Z", event: "app.started" as const, fields: {}, n: 1 },
  { at: "2026-10-10T02:00:00.000Z", event: "provider.call_failed" as const, fields: { provider: "openai" }, n: 3 },
  { at: "2026-10-10T03:00:00.000Z", event: "provider.call_failed" as const, fields: { provider: "openai" }, n: 2 },
  { at: "2026-10-10T02:30:00.000Z", event: "mcp.connection_failed" as const, fields: {}, n: 1 }] };

test("diagnostics are versions, system, states and counts; names, paths, model files and keys have no place", async () => {
  const snapshot = await collectRuntimeDiagnostics({ runtimeManager, diagnosticLog: log, runtimeKind: "desktop" });
  assert.equal(runtimeDiagnosticsSchema.safeParse(snapshot).success, true);
  assert.equal(JSON.stringify(snapshot).includes(CANARY), false);
  assert.equal(JSON.stringify(snapshot).includes(os.hostname()), false, "not the computer's name");
  assert.deepEqual(snapshot.localRuntime, { status: "ready", backend: "cuda", runtimeId: "linux-x64-cuda12", placement: "single-gpu", loadedModels: 1, hasError: true, cpuFallback: false });
  assert.deepEqual(snapshot.hardware.gpus, [{ name: "NVIDIA GeForce RTX 4090", vramGb: 24 }]);
  assert.deepEqual(snapshot.providers, [{ id: "openai", enabled: true, hasKey: true }, { id: "ollama", enabled: false, hasKey: false }]);
  assert.deepEqual(snapshot.mcp, { servers: 2, states: { error: 1, connected: 1 }, errors: { command_not_found: 1 } });
  assert.deepEqual(snapshot.recentErrors, [{ event: "provider.call_failed", n: 5, last: "2026-10-10T03:00:00.000Z" }, { event: "mcp.connection_failed", n: 1, last: "2026-10-10T02:30:00.000Z" }]);
});

test("a server's diagnostics are its owner's, with its log only when asked", async () => {
  assert.equal(OPERATIONS["diagnostics.collect"]?.kind, "request");
  const owner = "owner-1";
  const collect = createDiagnosticsOperations({ runtimeManager, diagnosticLog: log, owner: () => owner,
    status: () => ({ phase: "running", activeWork: { chatRuns: 1, inferenceBusy: true, note: CANARY } }) })["diagnostics.collect"]!;
  const context = (accountId: string) => ({ accountId, deviceId: "d", signal: new AbortController().signal });
  const plain = await collect({}, context(owner)) as any;
  assert.equal(plain.snapshot.runtimeKind, "server");
  assert.deepEqual(plain.server, { phase: "running", activeWork: { chatRuns: 1, inferenceBusy: true } });
  assert.equal("log" in plain, false);
  const withLog = await collect({ includeLog: true }, context(owner)) as any;
  assert.equal(withLog.log.length, 4);
  assert.equal(JSON.stringify(withLog).includes(CANARY), false);
  await assert.rejects(Promise.resolve(collect({}, context("someone-else"))), /owner/);
  await assert.rejects(Promise.resolve(collect({ includeLog: "yes" }, context(owner))), /not valid/);
});
