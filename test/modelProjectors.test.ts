import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { HuggingFaceCatalog, collectProjectors, groupVariants } from "../src/local/HuggingFaceCatalog";
import { LocalModelService } from "../src/local/LocalModelService";
import { ModelLibraryStore } from "../src/local/ModelLibraryStore";
import { ModelDownloadService } from "../src/local/ModelDownloadService";
import { LocalInferenceScheduler } from "../src/local/LocalInferenceScheduler";
import { LlamaCppRuntime } from "../src/local/LlamaCppRuntime";
import { LlamaCppProvider } from "../src/llm/LlamaCppProvider";
import { CatalogModel, LibraryModel, LocalModelOptions, ModelArtifact } from "../src/local/types";
import { Logger } from "../src/utils/Logger";

const gguf = (architecture = "qwen2vl", vision = false, padding = 32768): Buffer => {
  const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
  const u64 = (value: number) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
  const string = (value: string) => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
  const entries: Record<string, string | boolean> = { "general.architecture": architecture, "general.name": "Vision fixture", "tokenizer.chat_template": "{{ messages }}" };
  if (architecture === "clip") entries["clip.has_vision_encoder"] = vision;
  return Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(Object.keys(entries).length), ...Object.entries(entries).map(([key, value]) => Buffer.concat([
    string(key), typeof value === "string" ? Buffer.concat([u32(8), string(value)]) : Buffer.concat([u32(7), Buffer.from([Number(value)])])
  ])), Buffer.alloc(padding, vision ? 12 : 4)]);
};
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const artifact = (filename: string, bytes: Buffer): ModelArtifact => ({ path: filename, sizeBytes: bytes.length, sha256: hash(bytes) });
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) assert.fail("Timed out waiting for projector download"); await delay(10); }
};
const setupService = async (t: TestContext) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vision-library-"));
  const options: LocalModelOptions = { enabled: true, dataDir: path.join(root, "metadata"), modelsDir: path.join(root, "models"),
    runtimeDir: root, executablePath: process.execPath, contextSize: 4096, gpuLayers: 0, loadTimeoutMs: 1000, generationTimeoutMs: 1000, memoryLimitPercent: 75 };
  const service = new LocalModelService(options, new Logger());
  t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await service.init();
  const main = path.join(root, "vision-Q4_K_M.gguf"); await fs.writeFile(main, gguf());
  const projector = path.join(root, "mmproj-F16.gguf"); await fs.writeFile(projector, gguf("clip", true));
  return { root, options, service, main, projector };
};

test("vision repositories expose verified pinned projectors separately and refresh older cached details", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vision-catalog-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = artifact("vision-Q4_K_M.gguf", gguf()); const projector = artifact("vision/mmproj-F16.gguf", gguf("clip", true));
  const siblings = [main, projector].map(file => ({ rfilename: file.path, lfs: { size: file.sizeBytes, sha256: file.sha256 } }));
  siblings.push({ rfilename: "mmproj-00001-of-00002.gguf", lfs: { size: 100, sha256: "a".repeat(64) } });
  assert.equal(groupVariants(siblings).length, 1); assert.deepEqual(collectProjectors(siblings), [projector]);
  const record = { id: "author/vision-GGUF", sha: "a".repeat(40), pipeline_tag: "image-text-to-text", cardData: { license: "MIT" }, siblings };
  const oldCached: CatalogModel = { id: record.id, repoId: record.id, revision: record.sha, name: "Vision", author: "author", license: "MIT", gated: false, variants: groupVariants(siblings) };
  await fs.writeFile(path.join(root, "catalog-cache.json"), JSON.stringify([oldCached]));
  const requests: string[] = [];
  const catalog = new HuggingFaceCatalog(root, async input => { requests.push(String(input)); return Response.json(String(input).includes("/api/models?") ? [record] : record); });
  await catalog.init();
  assert.equal((await catalog.list("vision", undefined, "search")).items[0].repoId, record.id);
  const result = await catalog.getModel(record.id, record.sha);
  assert.deepEqual(result.projectors, [projector]); assert.equal(result.variants.length, 1);
  assert.ok(requests.some(url => url.includes(`/revision/${record.sha}`)));
  const count = requests.length; await catalog.getModel(record.id, record.sha); assert.equal(requests.length, count);
});

test("one import stores main weights and a vision adapter; loading, moving and deletion keep ownership", async t => {
  const { root, options, service, main, projector } = await setupService(t);
  const model = await service.importModel([projector, main]);
  assert.equal(model.files.length, 1); assert.equal(model.projector?.path, path.basename(projector)); assert.equal(model.vision, true);
  assert.equal(model.sizeBytes, gguf().length + gguf("clip", true).length);
  const provider = new LlamaCppProvider(service, { model: model.id });
  assert.equal(provider.getDescriptor().capabilities?.vision, true); assert.equal((await provider.listModels())[0].vision, true);
  const internal = service as unknown as { runtime: LlamaCppRuntime };
  const loads: unknown[][] = [];
  t.mock.method(internal.runtime, "load", async (...args: unknown[]) => { loads.push(args); });
  await service.loadModel(model.id);
  assert.equal(loads[0][3], path.join(options.modelsDir, model.id, model.projector!.path));
  const moved = { ...options, modelsDir: path.join(root, "moved-models") }; await service.reconfigure(moved);
  assert.equal(hash(await fs.readFile(path.join(moved.modelsDir, model.id, model.projector!.path))), model.projector!.sha256);
  assert.equal(hash(await fs.readFile(path.join(options.modelsDir, model.id, model.projector!.path))), model.projector!.sha256);
  await service.deleteModel(model.id);
  await assert.rejects(fs.access(path.join(moved.modelsDir, model.id)), /ENOENT/);
  assert.deepEqual(await fs.readFile(main), gguf()); assert.deepEqual(await fs.readFile(projector), gguf("clip", true));
});

test("text-only models reject images; replacing their adapter preserves the model and rolls back failed saves", async t => {
  const { root, options, service, main, projector } = await setupService(t);
  const model = await service.importModel([main]);
  assert.equal(model.vision, false);
  const request = { model: model.id, prompt: "Describe this image", images: [{ dataUrl: "data:image/png;base64,AA==" }] };
  await assert.rejects(service.generateText(request), /no vision adapter/);
  const attached = await service.attachProjector(model.id, projector);
  assert.equal(attached.id, model.id); assert.deepEqual(attached.files, model.files); assert.equal(attached.vision, true);
  assert.ok(attached.compatibility!.estimatedMemoryBytes > model.compatibility!.estimatedMemoryBytes);
  const persisted = JSON.parse(await fs.readFile(path.join(options.dataDir, "library.json"), "utf8"));
  assert.equal(persisted.items[0].projector.sha256, hash(gguf("clip", true)));
  await assert.rejects(service.attachProjector(model.id, main), /vision mmproj/);
  const audio = path.join(root, "audio-projector.gguf"); await fs.writeFile(audio, gguf("clip", false));
  await assert.rejects(service.attachProjector(model.id, audio), /audio-only/);
  const replacement = path.join(root, "mmproj-Q8_0.gguf"); const replacementBytes = gguf("clip", true, 49152); await fs.writeFile(replacement, replacementBytes);
  const internal = service as unknown as { store: ModelLibraryStore; runtime: LlamaCppRuntime; scheduler: LocalInferenceScheduler };
  const originalPut = internal.store.putModel.bind(internal.store);
  const save = t.mock.method(internal.store, "putModel", async (next: LibraryModel) => {
    await originalPut(next);
    if (next.projector?.sha256 === hash(replacementBytes)) throw new Error("simulated save failure");
  });
  await assert.rejects(service.attachProjector(model.id, replacement), /simulated save failure/);
  assert.equal(service.snapshot().models[0].projector?.sha256, attached.projector!.sha256);
  assert.equal(JSON.parse(await fs.readFile(path.join(options.dataDir, "library.json"), "utf8")).items[0].projector.sha256, attached.projector!.sha256);
  assert.deepEqual(await fs.readFile(path.join(options.modelsDir, model.id, attached.projector!.path)), gguf("clip", true));
  save.mock.restore();
  let stops = 0;
  t.mock.getter(internal.runtime, "currentModelId", () => model.id);
  t.mock.method(internal.runtime, "stop", async () => { stops++; });
  const changed = await service.attachProjector(model.id, replacement);
  assert.equal(stops, 1); assert.equal(changed.projector?.sha256, hash(replacementBytes)); assert.equal(changed.state, "unloaded");
  await assert.rejects(fs.access(path.join(options.modelsDir, model.id, attached.projector!.path)), /ENOENT/);
  assert.deepEqual(await fs.readFile(replacement), replacementBytes);
  let release!: () => void;
  const busy = internal.scheduler.run(model.id, () => new Promise<void>(resolve => { release = resolve; }));
  await delay(0);
  await assert.rejects(service.attachProjector(model.id, projector), /in use or queued/);
  release(); await busy;
});

test("imports reject standalone, multiple and audio-only projectors without publishing a model", async t => {
  const { root, service, main, projector } = await setupService(t);
  await assert.rejects(service.importModel([projector]), /one main GGUF/);
  const second = path.join(root, "mmproj-Q8_0.gguf"); await fs.writeFile(second, gguf("clip", true));
  await assert.rejects(service.importModel([main, projector, second]), /at most one/);
  const audio = path.join(root, "mmproj-audio.gguf"); await fs.writeFile(audio, gguf("clip", false));
  await assert.rejects(service.importModel([main, audio]), /audio-only/);
  assert.equal(service.snapshot().models.length, 0);
});

test("projector downloads pause and resume across restart, verify both files and reject conflicting selections", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vision-download-"));
  const dataDir = path.join(root, "metadata"), modelsDir = path.join(root, "models");
  const store = new ModelLibraryStore(dataDir, modelsDir); await store.init();
  const mainBytes = gguf(); const projectorBytes = gguf("clip", true, 65536);
  const main = artifact("vision-Q4_K_M.gguf", mainBytes), projector = artifact("mmproj-F16.gguf", projectorBytes);
  const variant = { id: main.path, name: "Q4_K_M", quantization: "Q4_K_M", sizeBytes: main.sizeBytes, files: [main] };
  const model: CatalogModel = { id: "author/vision", repoId: "author/vision", revision: "a".repeat(40), name: "Vision", author: "author", license: "MIT", gated: false, variants: [variant], projectors: [projector] };
  const ranges: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const isProjector = String(input).endsWith(projector.path);
    const bytes = isProjector ? projectorBytes : mainBytes;
    const range = new Headers(init?.headers).get("range") ?? "";
    if (isProjector) ranges.push(range);
    let offset = range ? Number(range.match(/\d+/)![0]) : 0; const start = offset;
    return new Response(new ReadableStream({ async pull(controller) {
      await delay(isProjector ? 12 : 0);
      if (init?.signal?.aborted) { controller.error(new Error("cancelled")); return; }
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + 1024); controller.enqueue(bytes.subarray(offset, end)); offset = end;
    } }), { status: start ? 206 : 200, headers: { "content-length": String(bytes.length - start), ...(start ? { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}) } });
  };
  const downloads = new ModelDownloadService(store, undefined, fetcher);
  let recoveredStore: ModelLibraryStore | undefined, recovered: ModelDownloadService | undefined;
  t.after(async () => { await recovered?.dispose(); await recoveredStore?.dispose(); await downloads.dispose().catch(() => {}); await store.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await assert.rejects(downloads.start(model, variant, "not-pinned.gguf"), /pinned repository/);
  const job = await downloads.start(model, variant, projector.path);
  assert.equal(job.totalBytes, mainBytes.length + projectorBytes.length);
  await assert.rejects(downloads.start(model, variant), /different vision adapter/);
  await until(() => downloads.list()[0].downloadedBytes > mainBytes.length + 2048);
  await downloads.pause(job.id);
  const saved = (await fs.stat(path.join(store.stagingDirectory(job.id), `${projector.path}.part`))).size;
  assert.equal(store.listModels().length, 0);
  await downloads.dispose(); await store.dispose();
  recoveredStore = new ModelLibraryStore(dataDir, modelsDir); await recoveredStore.init();
  recovered = new ModelDownloadService(recoveredStore, undefined, fetcher);
  await recovered.resume(job.id); await until(() => recovered!.list()[0].state === "completed");
  assert.ok(ranges.includes(`bytes=${saved}-`));
  const installed = recoveredStore.listModels()[0]; assert.equal(installed.vision, true); assert.equal(installed.files.length, 1);
  assert.equal(installed.projector?.sha256, projector.sha256); assert.equal(installed.sizeBytes, job.totalBytes);
  assert.equal(hash(await fs.readFile((await recoveredStore.verifiedProjectorPath(installed))!)), projector.sha256);
});

test("an invalid or corrupt downloaded projector never publishes a ready model", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vision-download-invalid-"));
  const store = new ModelLibraryStore(path.join(root, "metadata"), path.join(root, "models")); await store.init();
  const main = artifact("vision-Q4_K_M.gguf", gguf()); const audio = gguf("clip", false);
  const projector = artifact("mmproj-F16.gguf", audio);
  const variant = { id: main.path, name: "Q4_K_M", quantization: "Q4_K_M", sizeBytes: main.sizeBytes, files: [main] };
  const model: CatalogModel = { id: "author/vision", repoId: "author/vision", revision: "a".repeat(40), name: "Vision", author: "author", license: "MIT", gated: false, variants: [variant], projectors: [projector] };
  const downloads = new ModelDownloadService(store, undefined, async input => new Response(new Uint8Array(String(input).endsWith(projector.path) ? audio : gguf())));
  t.after(async () => { await downloads.dispose(); await store.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const invalid = await downloads.start(model, variant, projector.path); await until(() => store.getJob(invalid.id).state === "failed");
  assert.match(store.getJob(invalid.id).error!, /audio-only/); assert.equal(store.listModels().length, 0);
  await downloads.cancel(invalid.id);
  const corruptModel = { ...model, projectors: [{ ...projector, sha256: "0".repeat(64) }] };
  const corrupt = await downloads.start(corruptModel, variant, projector.path); await until(() => store.getJob(corrupt.id).state === "failed");
  assert.match(store.getJob(corrupt.id).error!, /SHA-256/); assert.equal(store.listModels().length, 0);
});
