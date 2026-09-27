import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inspectModelStorage } from "../src/local/ModelStorageInventory";
import { LibraryModel } from "../src/local/types";

test("storage inventory separates owned weights, partials, untracked files and external MLX/GGUF models without following links", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "model-inventory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const modelsDir = path.join(root, "managed");
  const external = path.join(root, "lmstudio");
  const write = async (name: string, size: number) => { const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, Buffer.alloc(size)); };
  await write("managed/gguf-tiny/tiny.gguf", 128);
  await write("managed/gguf-tiny/mmproj.gguf", 64);
  await write("managed/.downloads/job/large.gguf.part", 256);
  await write("managed/orphan/old.gguf", 512);
  await write("managed/.owner.json", 20);
  await write("lmstudio/author/Qwen-MLX/model-00001.safetensors", 1024);
  await write("lmstudio/author/Qwen-MLX/model-00002.safetensors", 1024);
  await write("lmstudio/author/Qwen-GGUF/Q4/model.gguf", 512);
  await write("outside/hidden.gguf", 4096);
  if (process.platform !== "win32") {
    await fs.symlink(path.join(root, "outside"), path.join(external, "external-link"));
    await fs.symlink(path.join(root, "outside", "hidden.gguf"), path.join(modelsDir, "linked.gguf"));
  }
  const model = { id: "gguf-tiny", files: [{ path: "tiny.gguf", sizeBytes: 128, sha256: "a".repeat(64) }], projector: { path: "mmproj.gguf", sizeBytes: 64, sha256: "b".repeat(64) } } as LibraryModel;
  const inventory = await inspectModelStorage(modelsDir, [model], [{ providerId: "lmstudio", name: "LM Studio", path: external }], []);
  assert.equal(inventory.managedBytes, 192);
  assert.equal(inventory.partialBytes, 256);
  assert.equal(inventory.untrackedBytes, 512);
  assert.equal(inventory.externalLibraries[0].sizeBytes, 2560);
  assert.deepEqual(inventory.externalLibraries[0].models.map(item => [item.name, item.format, item.sizeBytes]), [["author/Qwen-MLX", "MLX", 2048], ["author/Qwen-GGUF", "GGUF", 512]]);
  assert.ok(inventory.warnings.some(warning => warning.includes("outside the installed library")));
  assert.equal((await inspectModelStorage(modelsDir, [model], [{ providerId: "lmstudio", name: "LM Studio", path: modelsDir }], [])).externalLibraries.length, 0);
  assert.equal((await fs.stat(path.join(root, "outside", "hidden.gguf"))).size, 4096);
});

test("temporary inventory discovers only lcai profile models and never traverses arbitrary temp data or links", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "model-temporary-inventory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name: string, size: number) => { const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, Buffer.alloc(size)); };
  await write("managed/own.gguf", 64);
  await write("temporary/lcai-json-live/models/gguf-fixture/qwen.gguf", 1024);
  await write("temporary/lcai-json-live/models/gguf-fixture/mmproj.gguf", 128);
  await write("temporary/lcai-json-live/Cache/large-cache", 4096);
  await write("temporary/lcai-no-models/nested/models/hidden.gguf", 4096);
  await write("temporary/unrelated/models/hidden.gguf", 4096);
  await write("outside/hidden.gguf", 4096);
  if (process.platform !== "win32") {
    await fs.symlink(path.join(root, "temporary", "lcai-json-live"), path.join(root, "temporary", "lcai-symlink"));
    await fs.mkdir(path.join(root, "temporary", "lcai-linked-models"));
    await fs.symlink(path.join(root, "outside"), path.join(root, "temporary", "lcai-linked-models", "models"));
  }
  const temporary = path.join(root, "temporary");
  const inventory = await inspectModelStorage(path.join(root, "managed"), [], [], [temporary, temporary]);
  assert.equal(inventory.externalLibraries.length, 1);
  const library = inventory.externalLibraries[0];
  assert.equal(library.providerId, "temporary");
  assert.equal(library.name, "Temporary test models — lcai-json-live");
  assert.equal(library.path, path.join(await fs.realpath(temporary), "lcai-json-live", "models"));
  assert.equal(library.sizeBytes, 1152);
  assert.deepEqual(library.models.map(model => [model.name, model.sizeBytes, model.format]), [["gguf-fixture", 1152, "GGUF"]]);
  assert.equal((await inspectModelStorage(library.path, [], [], [temporary])).externalLibraries.length, 0, "The active managed library must not be counted twice");
  assert.equal((await fs.stat(path.join(root, "temporary", "unrelated", "models", "hidden.gguf"))).size, 4096);
});
