import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { readGGUFMetadata, evaluateCompatibility } from "../src/local/ModelCompatibility";
import { ModelLibraryStore } from "../src/local/ModelLibraryStore";
import { LocalModelService } from "../src/local/LocalModelService";
import { Logger } from "../src/utils/Logger";

const fixture = () => {
  const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
  const u64 = (value: number) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
  const string = (value: string) => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
  const entries: Record<string, string | number | boolean[]> = {
    "general.architecture": "qwen35", "general.type": "model", "general.name": "Installed Qwen", "tokenizer.chat_template": "{{ messages }}",
    "qwen35.context_length": 262144, "qwen35.embedding_length": 5120, "qwen35.block_count": 65, "qwen35.nextn_predict_layers": 1,
    "qwen35.attention.head_count": 24, "qwen35.attention.head_count_kv": 4, "qwen35.attention.key_length": 256, "qwen35.attention.value_length": 256,
    "qwen35.attention.recurrent_layers": Array.from({ length: 65 }, (_, index) => index < 64 && (index + 1) % 4 !== 0),
    "qwen35.ssm.conv_kernel": 4, "qwen35.ssm.inner_size": 6144, "qwen35.ssm.state_size": 128, "qwen35.ssm.group_count": 16
  };
  return Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(Object.keys(entries).length), ...Object.entries(entries).map(([key, value]) => Buffer.concat([
    string(key), typeof value === "string" ? Buffer.concat([u32(8), string(value)]) : typeof value === "number" ? Buffer.concat([u32(4), u32(value)]) : Buffer.concat([u32(9), u32(7), u64(value.length), Buffer.from(value.map(Number))])
  ])), Buffer.alloc(32768)]);
};

test("GGUF inspection reads hybrid attention metadata and preserves recurrent masks", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gguf-metadata-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "qwen.gguf"); await fs.writeFile(filename, fixture());
  const metadata = await readGGUFMetadata(filename);
  assert.equal(metadata.generalType, "model"); assert.equal(metadata.attentionKeyLength, 256); assert.equal(metadata.nextnPredictLayers, 1);
  assert.equal(Array.isArray(metadata.recurrentLayers) && metadata.recurrentLayers.filter(Boolean).length, 48);
  const result = evaluateCompatibility(16464440224, { contextSize: 4096, memoryLimitPercent: 75 }, metadata, undefined, true, { total: 48 * 1024 ** 3, free: 32 * 1024 ** 3 });
  assert.equal(result.canLoad, true); assert.equal(result.kvCacheBytes, 256 * 1024 ** 2); assert.equal(result.recurrentStateBytes, 149.625 * 1024 ** 2);
});

test("existing installed models receive new metadata without replacing their files or IDs", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gguf-migration-"));
  const dataDir = path.join(directory, "metadata"); const modelsDir = path.join(directory, "models");
  const store = new ModelLibraryStore(dataDir, modelsDir); await store.init();
  const bytes = fixture(); const sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = "gguf-existing-qwen"; const filename = "qwen.gguf"; const installedAt = "2026-09-01T00:00:00.000Z";
  await fs.mkdir(store.modelDirectory(id)); await fs.writeFile(path.join(store.modelDirectory(id), filename), bytes);
  await store.putModel({ id, libraryId: id, providerId: "llamacpp", providerName: "Local models", displayName: "User's installed Qwen", variantId: filename,
    quantization: "Q4_K_M", license: "apache-2.0", owned: true, installedAt, sizeBytes: bytes.length, files: [{ path: filename, sizeBytes: bytes.length, sha256 }],
    metadata: { version: 3, architecture: "qwen35", blockCount: 65, chatTemplate: true }, state: "unloaded", loaded: false, loadedInstanceIds: [] });
  await store.dispose();
  const service = new LocalModelService({ enabled: true, dataDir, modelsDir, runtimeDir: directory, executablePath: process.execPath, contextSize: 4096, gpuLayers: 0,
    loadTimeoutMs: 1000, generationTimeoutMs: 1000, memoryLimitPercent: 75 }, new Logger());
  t.after(async () => { await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  await service.init();
  const [model] = await service.listAllModels();
  assert.equal(model.id, id); assert.equal(model.installedAt, installedAt); assert.equal(model.displayName, "User's installed Qwen");
  assert.equal(model.metadata?.attentionKeyLength, 256); assert.equal(model.metadata?.nextnPredictLayers, 1);
  assert.equal(model.compatibility?.canLoad, true); assert.equal(model.compatibility?.kvCacheBytes, 256 * 1024 ** 2);
  assert.deepEqual(await fs.readFile(path.join(modelsDir, id, filename)), bytes);
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "library.json"), "utf8"));
  assert.equal(persisted.items[0].metadata.inspectionVersion, 2); assert.equal(persisted.items[0].files[0].sha256, sha256);
});
