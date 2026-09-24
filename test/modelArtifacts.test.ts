import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { HuggingFaceCatalog, collectProjectors, groupVariants } from "../src/local/HuggingFaceCatalog";
import { evaluateCompatibility, GGUF_INSPECTION_VERSION } from "../src/local/ModelCompatibility";
import { LocalModelService } from "../src/local/LocalModelService";
import { ModelDownloadService } from "../src/local/ModelDownloadService";
import { ModelLibraryStore } from "../src/local/ModelLibraryStore";
import { LlamaCppRuntime } from "../src/local/LlamaCppRuntime";
import { CatalogModel, CatalogVariant, LocalModelOptions, ModelArtifact } from "../src/local/types";
import { Logger } from "../src/utils/Logger";

const gguf = (architecture: string): Buffer => {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const string = (text: string) => Buffer.concat([u64(Buffer.byteLength(text)), Buffer.from(text)]);
  const entries = { "general.architecture": architecture, "general.type": "model", "general.name": "Bonsai fixture" };
  return Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(Object.keys(entries).length),
    ...Object.entries(entries).map(([key, value]) => Buffer.concat([string(key), u32(8), string(value)])), Buffer.alloc(1024)]);
};
const artifact = (name: string, bytes = gguf("qwen35")): ModelArtifact => ({ path: name, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
const variant = (file: ModelArtifact): CatalogVariant => ({ id: file.path, name: "BF16", quantization: "BF16", sizeBytes: file.sizeBytes, files: [file] });
const model = (variants: CatalogVariant[]): CatalogModel => ({ id: "fixture/Bonsai-GGUF", repoId: "fixture/Bonsai-GGUF", name: "Bonsai", author: "fixture", revision: "b".repeat(40), license: "MIT", gated: false, variants, projectors: [] });
const setup = async (t: TestContext) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "model-artifacts-"));
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => { try { for (const close of cleanup.reverse()) await close(); } finally { await fs.rm(root, { recursive: true, force: true }); } });
  const options: LocalModelOptions = { enabled: true, dataDir: path.join(root, "metadata"), modelsDir: path.join(root, "models"), runtimeDir: root,
    executablePath: process.execPath, contextSize: 4096, gpuLayers: 0, loadTimeoutMs: 1000, generationTimeoutMs: 1000, memoryLimitPercent: 75 };
  return { root, options, cleanup };
};
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) assert.fail("Download did not settle"); await delay(10); }
};

test("catalog separates DSpark drafters from main weights and vision projectors", async t => {
  const { root } = await setup(t);
  const files = [artifact("Bonsai-27B-Q1_0.gguf"), artifact("Bonsai-27B-dspark-bf16.gguf", gguf("dspark")),
    artifact("Bonsai-27B-DSpark-Q4_1.gguf", gguf("dspark")), artifact("DSpark/drafter-bf16.gguf", gguf("dspark")),
    artifact("Bonsai-27B-bf16-00001-of-00002.gguf"), artifact("Bonsai-27B-bf16-00002-of-00002.gguf"), artifact("mmproj-BF16.gguf", gguf("clip"))];
  const siblings = files.map(file => ({ rfilename: file.path, lfs: { size: file.sizeBytes, sha256: file.sha256 } }));
  const variants = groupVariants(siblings);
  assert.deepEqual(variants.map(v => v.id), ["Bonsai-27B-Q1_0.gguf", "Bonsai-27B-bf16.gguf"]);
  assert.equal(variants[1].files.length, 2);
  assert.deepEqual(collectProjectors(siblings), [files.at(-1)]);
  const catalog = new HuggingFaceCatalog(root, async () => Response.json({ id: "fixture/Bonsai-GGUF", sha: "b".repeat(40), siblings }));
  await catalog.init();
  assert.deepEqual((await catalog.getModel("fixture/Bonsai-GGUF")).variants, variants);
});

test("old pinned catalog caches filter DSpark even when offline", async t => {
  const { root } = await setup(t);
  const cached = model([variant(artifact("Bonsai-27B-Q1_0.gguf")), variant(artifact("Bonsai-27B-dspark-bf16.gguf", gguf("dspark")))]);
  await fs.writeFile(path.join(root, "catalog-cache.json"), JSON.stringify([cached]));
  let requests = 0;
  const catalog = new HuggingFaceCatalog(root, async () => { requests++; throw new Error("offline"); });
  await catalog.init();
  const pinned = await catalog.getModel(cached.repoId, cached.revision);
  assert.deepEqual(pinned.variants.map(v => v.id), ["Bonsai-27B-Q1_0.gguf"]);
  assert.equal(requests, 0, "Filtering old cache entries must work without another network lookup");
  const fallback = await catalog.list("fixture/Bonsai", undefined, "search");
  assert.equal(fallback.cached, true);
  assert.deepEqual(fallback.items[0].variants, pinned.variants);
});

test("compatibility rejects renamed DSpark metadata and known drafter paths without blocking new decoders", () => {
  const options = { contextSize: 4096, memoryLimitPercent: 75 };
  const metadata = { inspectionVersion: GGUF_INSPECTION_VERSION, version: 3, architecture: "dspark", generalType: "model", chatTemplate: false };
  for (const result of [evaluateCompatibility(1024, options, metadata),
    evaluateCompatibility(1024, options, undefined, undefined, true, undefined, ["Bonsai-27B-dspark-bf16.gguf"])]) {
    assert.equal(result.canLoad, false); assert.equal(result.canDownload, false); assert.equal(result.status, "incompatible");
    assert.deepEqual(result.blockingIssues.map(issue => issue.code), ["model_type"]);
    assert.match(result.reasons.join(" "), /DSpark.*auxiliary.*main GGUF/);
  }
  assert.equal(evaluateCompatibility(1024, options, { ...metadata, architecture: "qwen35" }).canLoad, true);
  assert.equal(evaluateCompatibility(1024, options, { ...metadata, architecture: "future-decoder" }).canLoad, true);
});

test("import inspects renamed drafters before publishing or copying them", async t => {
  const { root, options, cleanup } = await setup(t);
  const service = new LocalModelService(options, new Logger()); cleanup.push(() => service.dispose());
  const bytes = gguf("dspark"), source = path.join(root, "looks-like-main-BF16.gguf");
  await fs.writeFile(source, bytes);
  await assert.rejects(service.importModel([source]), /DSpark.*auxiliary/);
  assert.equal(service.snapshot().models.length, 0);
  assert.deepEqual(await fs.readFile(source), bytes);
  assert.deepEqual((await fs.readdir(options.modelsDir)).filter(name => name.startsWith("gguf-")), []);
  const main = path.join(root, "Bonsai-27B-Q1_0.gguf"); await fs.writeFile(main, gguf("qwen35"));
  assert.equal((await service.importModel([main])).compatibility?.canLoad, true);
});

test("existing DSpark records remain intact and fail clearly before invoking the native loader", async t => {
  const { options, cleanup } = await setup(t);
  const store = new ModelLibraryStore(options.dataDir, options.modelsDir); await store.init();
  const bytes = gguf("dspark"), file = artifact("Bonsai-27B-dspark-bf16.gguf", bytes), id = "gguf-existing-dspark";
  await fs.mkdir(store.modelDirectory(id)); await fs.writeFile(path.join(store.modelDirectory(id), file.path), bytes);
  await store.putModel({ id, libraryId: id, providerId: "llamacpp", providerName: "Local models", displayName: "Installed Bonsai", variantId: file.path,
    quantization: "BF16", license: "MIT", installedAt: "2026-09-01T00:00:00Z", owned: true, files: [file], sizeBytes: bytes.length,
    metadata: { inspectionVersion: GGUF_INSPECTION_VERSION, version: 3, architecture: "dspark", generalType: "model", chatTemplate: false },
    state: "unloaded", loaded: false, loadedInstanceIds: [] });
  await store.dispose();
  const manifestBefore = await fs.readFile(path.join(options.dataDir, "library.json"), "utf8");
  const service = new LocalModelService(options, new Logger()); cleanup.push(() => service.dispose());
  await service.init();
  const runtime = (service as unknown as { runtime: LlamaCppRuntime }).runtime;
  const load = t.mock.method(runtime, "load", async () => assert.fail("Auxiliary weights reached the native loader"));
  assert.equal(service.snapshot().models[0].compatibility?.canLoad, false);
  await assert.rejects(service.loadModel(id), /DSpark.*auxiliary/);
  await assert.rejects(service.generateText({ model: id, prompt: "Hello" }), /DSpark.*auxiliary/);
  assert.equal(load.mock.callCount(), 0);
  assert.equal(service.snapshot().models[0].id, id);
  assert.deepEqual(await fs.readFile(path.join(options.modelsDir, id, file.path)), bytes);
  assert.equal(await fs.readFile(path.join(options.dataDir, "library.json"), "utf8"), manifestBefore);
});

test("downloads reject named drafters and never publish renamed DSpark weights", async t => {
  const { options, cleanup } = await setup(t);
  const store = new ModelLibraryStore(options.dataDir, options.modelsDir); await store.init(); cleanup.push(() => store.dispose());
  const bytes = gguf("dspark"); let requests = 0;
  const downloads = new ModelDownloadService(store, undefined, async () => { requests++; return new Response(new Uint8Array(bytes), { headers: { "content-length": String(bytes.length) } }); });
  cleanup.push(() => downloads.dispose());
  const named = variant(artifact("Bonsai-27B-dspark-bf16.gguf", bytes));
  await assert.rejects(downloads.start(model([named]), named), /DSpark.*auxiliary/);
  assert.equal(requests, 0); assert.equal(downloads.list().length, 0);
  const renamed = variant(artifact("Bonsai-main-BF16.gguf", bytes));
  const job = await downloads.start(model([renamed]), renamed);
  await until(() => downloads.list()[0].state === "failed");
  assert.match(downloads.list()[0].error!, /DSpark.*auxiliary/);
  assert.equal(store.listModels().length, 0);
  assert.deepEqual(await fs.readFile(path.join(store.stagingDirectory(job.id), renamed.files[0].path)), bytes);
  // A resumed legacy job must not bypass catalog filtering or erase its files.
  await store.putJob({ ...job, id: "download-old-dspark", files: named.files, variantId: named.id, state: "paused" });
  await assert.rejects(downloads.resume("download-old-dspark"), /DSpark.*auxiliary/);
  assert.equal(requests, 1);
});
