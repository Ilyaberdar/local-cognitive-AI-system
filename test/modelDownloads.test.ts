import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ModelLibraryStore, validateArtifactPath } from "../src/local/ModelLibraryStore";
import { ModelDownloadService } from "../src/local/ModelDownloadService";
import { artifactDownloadUrl, groupVariants } from "../src/local/HuggingFaceCatalog";
import { readGGUFMetadata } from "../src/local/ModelCompatibility";
import { CatalogModel, CatalogVariant } from "../src/local/types";
import { LocalModelService } from "../src/local/LocalModelService";
import { Logger } from "../src/utils/Logger";

const gguf = (): Buffer => {
  const u32 = (number: number) => { const result = Buffer.alloc(4); result.writeUInt32LE(number); return result; };
  const u64 = (number: number) => { const result = Buffer.alloc(8); result.writeBigUInt64LE(BigInt(number)); return result; };
  const string = (text: string) => Buffer.concat([u64(Buffer.byteLength(text)), Buffer.from(text)]);
  return Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(3), string("general.architecture"), u32(8), string("llama"),
    string("general.name"), u32(8), string("Tiny fixture"), string("tokenizer.chat_template"), u32(8), string("{{messages}}"), Buffer.alloc(32768, 42)]);
};
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const modelFor = (bytes: Buffer): { model: CatalogModel; variant: CatalogVariant } => {
  const variant: CatalogVariant = { id: "tiny-Q4_K_M.gguf", name: "Q4_K_M", quantization: "Q4_K_M", sizeBytes: bytes.length,
    files: [{ path: "tiny-Q4_K_M.gguf", sizeBytes: bytes.length, sha256: hash(bytes) }] };
  return { variant, model: { id: "author/tiny-GGUF", repoId: "author/tiny-GGUF", revision: "a".repeat(40), name: "Tiny", author: "author", license: "MIT", gated: false, variants: [variant] } };
};
const until = async (predicate: () => boolean, timeout = 5000) => {
  const start = Date.now(); while (!predicate()) { if (Date.now() - start > timeout) assert.fail("Timed out waiting for download state"); await delay(10); }
};
const setup = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llama-download-test-"));
  const store = new ModelLibraryStore(path.join(root, "metadata"), path.join(root, "models")); await store.init();
  return { root, store };
};

test("GGUF validation rejects truncation and artifact paths cannot escape the library", async () => {
  for (const unsafe of ["../model.gguf", "/tmp/model.gguf", "C:\\model.gguf", "a/../../bad", "a//bad.gguf", "a/./bad.gguf", "model.gguf "]) assert.throws(() => validateArtifactPath(unsafe));
  assert.throws(() => artifactDownloadUrl("author/model", "main", "x.gguf"), /immutable/);
  assert.throws(() => artifactDownloadUrl("../secret", "a".repeat(40), "x.gguf"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gguf-")); const file = path.join(root, "tiny.gguf");
  try {
    await fs.writeFile(file, gguf()); assert.equal((await readGGUFMetadata(file)).architecture, "llama");
    await fs.writeFile(file, gguf().subarray(0, 30)); await assert.rejects(readGGUFMetadata(file), /truncated|metadata/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("catalog groups all shards and rejects incomplete or unverifiable variants", () => {
  const sha256 = "a".repeat(64);
  const file = (name: string) => ({ rfilename: name, size: 100, lfs: { size: 100, sha256 } });
  const variants = groupVariants([file("A-Q4_K_M-00001-of-00002.gguf"), file("A-Q4_K_M-00002-of-00002.gguf"),
    file("B-Q8_0-00001-of-00002.gguf"), file("mmproj-Q8_0.gguf"), { rfilename: "unverified.gguf", size: 100 }]);
  assert.equal(variants.length, 1); assert.equal(variants[0].files.length, 2); assert.equal(variants[0].sizeBytes, 200); assert.equal(variants[0].quantization, "Q4_K_M");
});

test("simultaneous starts of one pinned variant share one job and one file transfer", async (t) => {
  const { root, store } = await setup(); const bytes = gguf(); const { model, variant } = modelFor(bytes);
  let requests = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const downloads = new ModelDownloadService(store, undefined, async () => {
    requests++; await gate;
    return new Response(new Uint8Array(bytes), { headers: { "content-length": String(bytes.length) } });
  });
  t.after(async () => { release(); await downloads.dispose(); await store.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const tooLarge = { ...variant, sizeBytes: Number.MAX_SAFE_INTEGER };
  const failures = await Promise.allSettled([downloads.start(model, tooLarge), downloads.start(model, tooLarge)]);
  assert.ok(failures.every((result) => result.status === "rejected"));
  assert.equal(downloads.list().length, 0);
  // A failed admission must not leave its deduplication slot permanently occupied.
  const starts = await Promise.all(Array.from({ length: 12 }, () => downloads.start(model, variant)));
  assert.equal(new Set(starts.map((job) => job.id)).size, 1);
  assert.equal(downloads.list().length, 1);
  await until(() => requests === 1);
  release(); await until(() => downloads.list()[0].state === "completed");
  assert.equal((await downloads.start(model, variant)).id, starts[0].id);
  assert.equal(requests, 1);
  const other = { ...variant, id: "tiny-Q8_0.gguf", quantization: "Q8_0", files: [{ ...variant.files[0], path: "tiny-Q8_0.gguf" }] };
  const otherJob = await downloads.start(model, other);
  assert.notEqual(otherJob.id, starts[0].id);
  await until(() => downloads.list().find((job) => job.id === otherJob.id)?.state === "completed");
  assert.equal(requests, 2); assert.equal(store.listModels().length, 2);
});

test("downloads pause, persist partial bytes, survive restart, and resume with a verified byte range", async (t) => {
  const { root, store } = await setup(); const bytes = gguf(); const { model, variant } = modelFor(bytes); const ranges: string[] = [];
  const fetcher: typeof fetch = async (_url, options) => {
    const range = new Headers(options?.headers).get("range") ?? ""; ranges.push(range);
    const start = range ? Number(range.match(/\d+/)![0]) : 0; let position = start;
    return new Response(new ReadableStream({ async pull(controller) {
      await delay(12); if (options?.signal?.aborted) { controller.error(new Error("aborted")); return; }
      if (position >= bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, position + 1024); controller.enqueue(bytes.subarray(position, end)); position = end;
    } }), { status: start ? 206 : 200, headers: { "content-length": String(bytes.length - start), ...(start ? { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}) } });
  };
  const downloads = new ModelDownloadService(store, undefined, fetcher);
  let secondStore: ModelLibraryStore | undefined; let secondDownloads: ModelDownloadService | undefined;
  t.after(async () => { await secondDownloads?.dispose(); await secondStore?.dispose(); await downloads.dispose().catch(() => {}); await store.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const job = await downloads.start(model, variant);
  await until(() => downloads.list()[0].downloadedBytes >= 2048);
  await downloads.pause(job.id); assert.equal(downloads.list()[0].state, "paused");
  const partial = await fs.stat(path.join(store.stagingDirectory(job.id), `${variant.files[0].path}.part`)); assert.ok(partial.size > 0 && partial.size < bytes.length);
  await downloads.dispose(); await store.dispose();
  secondStore = new ModelLibraryStore(path.join(root, "metadata"), path.join(root, "models")); await secondStore.init();
  secondDownloads = new ModelDownloadService(secondStore, undefined, fetcher);
  await secondDownloads.resume(job.id); await until(() => secondDownloads!.list()[0].state === "completed");
  assert.ok(ranges.some((range) => range === `bytes=${partial.size}-`));
  const installed = secondStore.listModels(); assert.equal(installed.length, 1); assert.equal(installed[0].loaded, false);
  assert.equal(hash(await fs.readFile(await secondStore.verifiedModelPath(installed[0]))), hash(bytes));
});

test("ignored Range restarts the file instead of appending, and corrupt hashes never publish a model", async (t) => {
  const { root, store } = await setup(); const bytes = gguf(); const { model, variant } = modelFor(bytes);
  let downloads: ModelDownloadService | undefined;
  t.after(async () => { await downloads?.dispose(); await store.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const fetcher: typeof fetch = async () => new Response(new Uint8Array(bytes), { headers: { "content-length": String(bytes.length) } });
  downloads = new ModelDownloadService(store, undefined, fetcher);
  // A failed verification leaves no ready model, even with a successful HTTP status.
  const corrupt = { ...variant, files: [{ ...variant.files[0], sha256: "0".repeat(64) }] };
  const failed = await downloads.start(model, corrupt);
  await until(() => downloads!.list().find((item) => item.id === failed.id)?.state === "failed");
  assert.match(downloads.list().find((item) => item.id === failed.id)?.error ?? "", /SHA-256/); assert.equal(store.listModels().length, 0);
  await downloads.cancel(failed.id);
  // Seed paused .part data and let a server ignore Range: the final hash still has to match.
  const now = new Date().toISOString();
  const id = "download-range-ignored";
  const seed = { ...failed, id, state: "paused" as const, files: variant.files, createdAt: now, updatedAt: now, error: undefined };
  await store.putJob(seed); await fs.mkdir(store.stagingDirectory(id), { recursive: true });
  await fs.writeFile(path.join(store.stagingDirectory(id), `${variant.files[0].path}.part`), bytes.subarray(0, 1024));
  await downloads.resume(id); await until(() => downloads!.list().find((item) => item.id === id)?.state === "completed");
  assert.equal(store.listModels().length, 1);
});

test("a second process owner cannot mutate the same model library", async (t) => {
  const { root, store } = await setup();
  t.after(async () => { await store.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const duplicate = new ModelLibraryStore(path.join(root, "other-metadata"), store.modelsDir);
  await assert.rejects(duplicate.init(), /Another application process owns/);
  await store.dispose(); await duplicate.init(); await duplicate.dispose();
});

test("changing the model folder copies and verifies owned models and rolls back on destination conflicts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llama-storage-move-"));
  const options = { enabled: true, dataDir: path.join(root, "metadata"), modelsDir: path.join(root, "old-models"), runtimeDir: path.join(root, "runtime"),
    contextSize: 2048, gpuLayers: 0, loadTimeoutMs: 5000, generationTimeoutMs: 5000, memoryLimitPercent: 75 };
  const service = new LocalModelService(options, new Logger());
  t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await service.init();
  const original = path.join(root, "tiny-Q4_K_M.gguf"); await fs.writeFile(original, gguf());
  const model = await service.importModel([original]);
  const next = { ...options, modelsDir: path.join(root, "new-models") };
  await service.reconfigure(next);
  assert.equal(service.snapshot().runtime.modelsDir, next.modelsDir);
  assert.equal((await service.listAllModels())[0].id, model.id);
  assert.equal(hash(await fs.readFile(path.join(next.modelsDir, model.id, model.files[0].path))), hash(gguf()));
  assert.equal(hash(await fs.readFile(path.join(options.modelsDir, model.id, model.files[0].path))), hash(gguf()));
  assert.equal(hash(await fs.readFile(original)), hash(gguf()));
  const conflict = path.join(root, "conflict-models"); const foreign = path.join(conflict, model.id);
  await fs.mkdir(foreign, { recursive: true }); await fs.writeFile(path.join(foreign, "user-file.txt"), "Keep this file");
  await assert.rejects(service.reconfigure({ ...next, modelsDir: conflict }), /already contains/);
  assert.equal(service.snapshot().runtime.modelsDir, next.modelsDir);
  assert.equal(await fs.readFile(path.join(foreign, "user-file.txt"), "utf8"), "Keep this file");
  assert.equal((await service.listAllModels()).length, 1);
  await service.reconfigure(options); // Existing exact backup is reused for settings rollback.
  assert.equal(service.snapshot().runtime.modelsDir, options.modelsDir);
  await fs.writeFile(path.join(next.modelsDir, model.id, model.files[0].path), Buffer.alloc(gguf().length));
  await assert.rejects(service.reconfigure(next), /different file hashes/);
  assert.equal(service.snapshot().runtime.modelsDir, options.modelsDir);
  assert.equal(hash(await fs.readFile(path.join(options.modelsDir, model.id, model.files[0].path))), hash(gguf()));
});

test("interrupted download records recover as paused and cancelling removes only their partial files", async (t) => {
  const { root, store } = await setup(); const { model, variant } = modelFor(gguf());
  const downloads = new ModelDownloadService(store, undefined, async (_url, options) => new Response(new ReadableStream({
    async pull(controller) { await delay(10); if (options?.signal?.aborted) controller.error(new Error("cancelled")); else controller.enqueue(gguf().subarray(0, 512)); }
  }), { headers: { "content-length": String(gguf().length) } }));
  t.after(async () => { await downloads.dispose().catch(() => {}); await store.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const job = await downloads.start(model, variant);
  await until(() => downloads.list()[0].downloadedBytes > 0);
  await downloads.cancel(job.id);
  assert.equal(downloads.list()[0].state, "cancelled");
  await assert.rejects(fs.access(store.stagingDirectory(job.id)), /ENOENT/);
  assert.equal(store.listModels().length, 0);
  await downloads.dispose();
  await store.putJob({ ...store.getJob(job.id), state: "verifying" }); await store.dispose();
  const recovered = new ModelLibraryStore(path.join(root, "metadata"), path.join(root, "models")); await recovered.init();
  assert.equal(recovered.getJob(job.id).state, "paused"); assert.match(recovered.getJob(job.id).error ?? "", /restarted/);
  await recovered.dispose();
});
