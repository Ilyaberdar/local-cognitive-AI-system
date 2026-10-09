import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import { validateSettingsPatch } from "../src/app/settingsValidation";
import { config, parseGpuLayers } from "../src/config/config";

const legacyDefault = process.platform === "darwin" ? 99 : 0;

async function storeWith(t: TestContext, localModels: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gpu-layers-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new AppSettingsStore(root, config);
  const fresh = await store.get();
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({ ...fresh, schemaVersion: 4, localModels: { ...fresh.localModels, ...localModels } }));
  return { root, store: new AppSettingsStore(root, config) };
}

test("GPU layers parse auto, empty and numbers", () => {
  assert.equal(parseGpuLayers(undefined), "auto");
  assert.equal(parseGpuLayers(""), "auto");
  assert.equal(parseGpuLayers(" AUTO "), "auto");
  assert.equal(parseGpuLayers("40"), 40);
  assert.equal(parseGpuLayers("0"), 0);
  assert.equal(parseGpuLayers("5000"), 999);
  assert.equal(parseGpuLayers("many"), "auto");
});

test("the old persisted platform default becomes auto; explicit values are kept", async t => {
  const legacy = await storeWith(t, { gpuLayers: legacyDefault });
  const migrated = await legacy.store.get();
  assert.equal(migrated.localModels?.gpuLayers, "auto");
  assert.equal(migrated.schemaVersion, 5);
  assert.equal(JSON.parse(await fs.readFile(path.join(legacy.root, "settings.json"), "utf8")).localModels.gpuLayers, "auto", "the migration is persisted");

  const explicit = await storeWith(t, { gpuLayers: 64 });
  assert.equal((await explicit.store.get()).localModels?.gpuLayers, 64);
});

test("settings accept auto or a layer count", () => {
  validateSettingsPatch({ localModels: { gpuLayers: "auto" } });
  validateSettingsPatch({ localModels: { gpuLayers: 32 } });
  assert.throws(() => validateSettingsPatch({ localModels: { gpuLayers: "foo" as never } }), /gpuLayers/);
  assert.throws(() => validateSettingsPatch({ localModels: { gpuLayers: 1000 } }), /gpuLayers/);
  assert.throws(() => validateSettingsPatch({ localModels: { gpuLayers: 1.5 } }), /gpuLayers/);
});

test("multi-GPU settings are checked: known modes, GPU ids, a model's own GPUs", () => {
  validateSettingsPatch({ localModels: { multiGpu: { split: "always", mode: "row", devices: ["GPU-a", "CUDA1"], pins: { "gguf-1": ["GPU-b"] } } } } as never);
  for (const multiGpu of [{ split: "sometimes" }, { mode: "tensor" }, { devices: ["GPU a"] }, { devices: ["x", "x"] }, { pins: JSON.parse('{"__proto__": ["GPU-a"]}') }, { extra: true }]) {
    assert.throws(() => validateSettingsPatch({ localModels: { multiGpu } } as never), JSON.stringify(multiGpu));
  }
});
