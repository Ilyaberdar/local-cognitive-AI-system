import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import type { RuntimeManager } from "../src/app/RuntimeManager";
import { LocalModelService } from "../src/local/LocalModelService";
import { RemoteOperationError, type OperationContext } from "../src/remote/host/RemoteHost";
import { createModelOperations } from "../src/runtime/modelOperations";
import { OPERATIONS } from "../src/runtime/operationCatalog";
import { Logger } from "../src/utils/Logger";
import { startStubHuggingFace, writeFakeLlamaServer } from "./fixtures/stubHuggingFace";

const until = async <T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last ${JSON.stringify(value).slice(0, 300)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const context = (): OperationContext & { abort: () => void } => {
  const controller = new AbortController();
  return { accountId: "a", deviceId: "d", signal: controller.signal, abort: () => controller.abort() };
};

async function setup(t: TestContext) {
  const hub = await startStubHuggingFace(t);
  const previous = process.env.LOCAL_COGNITIVE_HF_ORIGIN;
  process.env.LOCAL_COGNITIVE_HF_ORIGIN = hub.origin;
  t.after(() => { if (previous === undefined) delete process.env.LOCAL_COGNITIVE_HF_ORIGIN; else process.env.LOCAL_COGNITIVE_HF_ORIGIN = previous; });
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "model-ops-")));
  const executable = await writeFakeLlamaServer(root);
  const service = new LocalModelService({ enabled: true, dataDir: path.join(root, "data"), modelsDir: path.join(root, "models"), runtimeDir: root, executablePath: executable,
    contextSize: 2048, gpuLayers: 0, loadTimeoutMs: 5000, generationTimeoutMs: 5000, memoryLimitPercent: 75 }, new Logger());
  await service.init();
  t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const updates: unknown[] = [];
  const runtimeManager = {
    getRuntime: () => ({ localModelService: service,
      localModelManager: { loadModel: (_provider: string, id: string) => service.loadModel(id), unloadModel: (_provider: string, id: string) => service.unloadModel(id) } }),
    getSettings: async () => ({ llm: { defaultProvider: "llamacpp" }, providers: { llamacpp: { model: "", apiKey: "secret-key" } },
      localModels: { modelsDir: path.join(root, "models"), contextSize: 2048, gpuLayers: 0, loadTimeoutMs: 5000, generationTimeoutMs: 5000, memoryLimitPercent: 75 } }),
    updateSettings: async (patch: unknown) => { updates.push(patch); return {}; }
  } as unknown as RuntimeManager;
  const ops = createModelOperations({ runtimeManager, loadWaitMs: 4000, coalesceMs: 50 });
  const call = <T = any>(op: string, payload?: unknown, ctx = context()) => Promise.resolve(ops[op]!(payload, ctx)) as Promise<T>;
  return { hub, root, service, ops, call, updates };
}

test("every model operation is in the catalog the desktop bridge allows", () => {
  const ops = createModelOperations({ runtimeManager: {} as RuntimeManager });
  for (const name of Object.keys(ops)) assert.ok(OPERATIONS[name], `${name} is missing from the operation catalog`);
});

test("a device browses the catalog and downloads, pauses, resumes and installs a model on the host", async t => {
  const f = await setup(t);
  const page = await f.call("models.catalog.search", { query: "tiny", source: "search" });
  assert.deepEqual(page.items.map((item: { repoId: string }) => item.repoId), [f.hub.repoId]);
  const details = await f.call("models.catalog.get", { repoId: f.hub.repoId, revision: f.hub.revision });
  const variant = details.variants[0];
  assert.equal(variant.files[0].path, f.hub.file);

  f.hub.state.chunkDelayMs = 40;
  const first = await f.call("models.local.watch", {});
  assert.ok(first.epoch && first.snapshot, "a device without a cursor gets the state at once");
  const job = await f.call("models.downloads.start", { repoId: f.hub.repoId, revision: f.hub.revision, variantId: variant.id, commandId: "cmd-1" });
  assert.equal(job.libraryId.length > 0, true);
  const again = await f.call("models.downloads.start", { repoId: f.hub.repoId, revision: f.hub.revision, variantId: variant.id, commandId: "cmd-1" });
  assert.equal(again.id, job.id, "a resent start is the same download");

  const progressed = await f.call("models.local.watch", { epoch: first.epoch, after: first.sequence, waitMs: 5000 });
  assert.ok(progressed.sequence > first.sequence && progressed.snapshot);
  // Progress counts a chunk as it passes, a moment before it is on disk: past the first 16 KiB
  // chunk, that one is written, so the resume has a partial file to continue from.
  await until(() => f.call("models.downloads.list"), (jobs: any[]) => jobs[0]?.downloadedBytes > 16 * 1024);
  const paused = await f.call("models.downloads.pause", { downloadId: job.id });
  assert.equal(paused.state, "paused");
  f.hub.state.chunkDelayMs = 0;
  await f.call("models.downloads.resume", { downloadId: job.id });
  await until(() => f.call("models.downloads.list"), (jobs: any[]) => jobs[0]?.state === "completed");
  assert.ok(f.hub.state.ranges.some(range => /^bytes=\d+-$/.test(range)), "the resume continued from the partial file");

  const snapshot = await f.call("models.local.snapshot");
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0].files[0].path, f.hub.file);
  const exposed = JSON.stringify([snapshot, await f.call("models.downloads.list"), await f.call("models.settings.get")]);
  assert.equal(exposed.includes(f.root), false, "no host directory reaches the device");
  assert.equal(exposed.includes("secret-key"), false, "no provider secret reaches the device");
});

test("load, unload and delete run on the host; errors are short and coded", async t => {
  const f = await setup(t);
  const details = await f.call("models.catalog.get", { repoId: f.hub.repoId, revision: f.hub.revision });
  const job = await f.call("models.downloads.start", { repoId: f.hub.repoId, revision: f.hub.revision, variantId: details.variants[0].id });
  await until(() => f.call("models.downloads.list"), (jobs: any[]) => jobs[0]?.state === "completed");
  const modelId = job.libraryId;
  assert.deepEqual(await f.call("models.load", { modelId }), { modelId, status: "ready" });
  assert.equal((await f.call("models.local.snapshot")).models[0].state, "ready");
  assert.deepEqual(await f.call("models.unload", { modelId }), { modelId, status: "unloaded" });
  assert.deepEqual(await f.call("models.local.delete", { modelId }), { modelId, deleted: true });
  assert.equal((await f.call("models.local.snapshot")).models.length, 0);
  await assert.rejects(f.call("models.load", { modelId: "missing" }), (error: unknown) => error instanceof RemoteOperationError && error.message.length <= 300 && !error.message.includes(f.root));
  await assert.rejects(f.call("models.load", { modelId: "x", extra: true }), (error: unknown) => (error as RemoteOperationError).code === "invalid_request");
});

test("runtime settings: only the allowed fields, and the default model; the watch ends on disconnect", async t => {
  const f = await setup(t);
  await assert.rejects(f.call("models.settings.update", { localModels: { modelsDir: "/tmp/elsewhere" } }), (error: unknown) => (error as RemoteOperationError).code === "invalid_request");
  const view = await f.call("models.settings.update", { localModels: { contextSize: 4096, gpuLayers: "auto" } });
  assert.deepEqual(f.updates, [{ localModels: { contextSize: 4096, gpuLayers: "auto" } }]);
  assert.equal(view.localModels.modelsDir, undefined);
  await f.call("models.setDefault", { modelId: "lib-1" });
  assert.deepEqual(f.updates[1], { llm: { defaultProvider: "llamacpp" }, providers: { llamacpp: { model: "lib-1", enabled: true } } });

  const first = await f.call("models.local.watch", {});
  const ctx = context();
  const started = Date.now();
  const waiting = f.call("models.local.watch", { epoch: first.epoch, after: first.sequence, waitMs: 20_000 }, ctx);
  setTimeout(() => ctx.abort(), 100);
  const result = await waiting;
  assert.ok(Date.now() - started < 5_000, "a disconnected device does not hold the host");
  assert.equal(result.snapshot, undefined);
  const metrics = await f.call("system.metrics");
  assert.ok(metrics.memoryTotalBytes > 0);
});
