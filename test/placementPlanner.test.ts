import assert from "node:assert/strict";
import test from "node:test";
import { DeviceInventory, mergeDevices, parseListDevices, parseNvidiaSmi, type InventoryDevice } from "../src/local/DeviceInventory";
import { estimateModelMemory, type ModelMemoryEstimate } from "../src/local/ModelCompatibility";
import { planPlacement, type PlacementInput, type PlacementPlan } from "../src/local/PlacementPlanner";

const MiB = 1024 ** 2, GiB = 1024 ** 3;
// usable = free - 512 headroom - 384 context - 384 compute = free - 1280 MiB
const gpu = (index: number, freeMiB: number, totalMiB = freeMiB): InventoryDevice => ({ id: `GPU-${index}`, uuid: `GPU-${index}`, backendName: `CUDA${index}`, index,
  name: "NVIDIA Test", kind: "gpu", totalBytes: totalMiB * MiB, freeBytes: freeMiB * MiB });
// need = weights*1.1 (no KV) = 4400 MiB; perLayer = 4000/41 + 0 ≈ 98 MiB
const estimate = (weightsMiB = 4000, layers = 40): ModelMemoryEstimate => ({ layers, weightsBytes: weightsMiB * MiB, projectorBytes: 0, kvCacheBytes: 0,
  recurrentStateBytes: 0, overheadBytes: 384 * MiB, totalBytes: Math.ceil(weightsMiB * MiB * 1.1 + 384 * MiB), perLayerBytes: layers ? weightsMiB * MiB / (layers + 1) : 0 });
const plan = (input: Partial<PlacementInput>) => planPlacement({ modelId: "m", estimate: estimate(), contextSize: 4096, devices: [], system: { totalBytes: 32 * GiB },
  residents: [], gpuLayers: "auto", ...input });
const ok = (result: ReturnType<typeof planPlacement>) => { assert.notEqual(result.kind, "error", (result as { message?: string }).message); return result as PlacementPlan; };

test("a model that fits one GPU runs entirely on it with the GPU's identity pinned", () => {
  const result = ok(plan({ devices: [gpu(0, 8000)] }));
  assert.equal(result.kind, "single-gpu");
  assert.deepEqual(result.launch.args, ["--device", "CUDA0", "--n-gpu-layers", "all", "--fit", "off"]);
  assert.deepEqual(result.launch.env, { CUDA_DEVICE_ORDER: "PCI_BUS_ID", CUDA_VISIBLE_DEVICES: "GPU-0" });
  assert.equal(result.label, "GPU 0");
});

test("with several GPUs an idle one is preferred, then the tightest fit", () => {
  assert.equal(ok(plan({ devices: [gpu(0, 24000), gpu(1, 8000)] })).devices[0]!.index, 1, "tightest fit");
  const busy = ok(plan({ devices: [gpu(0, 24000), gpu(1, 8000)], residents: [{ modelId: "other", deviceBytes: { "GPU-1": 1000 * MiB }, hostBytes: 0 }] }));
  assert.equal(busy.devices[0]!.index, 0, "the idle GPU wins even when larger");
});

test("the boundary is exact: need == usable fits, one MiB more does not", () => {
  assert.equal(ok(plan({ devices: [gpu(0, 4400 + 1280)] })).kind, "single-gpu");
  assert.notEqual(ok(plan({ devices: [gpu(0, 4400 + 1279)] })).kind, "single-gpu");
});

test("a model too large for any GPU is split across the smallest set, proportionally", () => {
  const result = ok(plan({ estimate: estimate(10000), devices: [gpu(0, 8000), gpu(1, 8000), gpu(2, 4000)] }));
  assert.equal(result.kind, "multi-gpu");
  assert.deepEqual(result.devices.map(device => device.index), [0, 1]);
  assert.deepEqual(result.tensorSplit, [6720, 6720]);
  assert.deepEqual(result.launch.args.slice(0, 6), ["--device", "CUDA0,CUDA1", "--split-mode", "layer", "--tensor-split", "6720,6720"]);
  assert.equal(result.launch.env.CUDA_VISIBLE_DEVICES, "GPU-0,GPU-1");
});

test("what does not fit on GPUs runs partly on the CPU with a visible warning", () => {
  const result = ok(plan({ estimate: estimate(12000), devices: [gpu(0, 8000)] }));
  assert.equal(result.kind, "partial");
  assert.equal(typeof result.gpuLayers, "number");
  assert.ok((result.gpuLayers as number) >= 1 && (result.gpuLayers as number) < 41);
  assert.match(result.warnings[0]!, /layers fit in GPU memory/);
  assert.match(result.label, /partly CPU/);
});

test("without GPU room the model runs on the CPU; without GPUs the legacy arguments are kept", () => {
  const full = ok(plan({ devices: [gpu(0, 1300)] }));
  assert.equal(full.kind, "cpu");
  assert.deepEqual(full.launch.args, ["--device", "none", "--n-gpu-layers", "0", "--fit", "off"]);
  assert.match(full.warnings[0]!, /No GPU has enough free memory/);
  const none = ok(plan({ devices: [] }));
  assert.deepEqual(none.launch.args, ["--n-gpu-layers", "0"]);
  assert.deepEqual(none.warnings, []);
  const explicit = ok(plan({ devices: [gpu(0, 8000)], gpuLayers: 0 }));
  assert.equal(explicit.kind, "cpu");
  assert.deepEqual(explicit.warnings, []);
  assert.deepEqual(ok(plan({ devices: [], gpuLayers: 0, gpuRuntime: true })).launch.args, ["--device", "none", "--n-gpu-layers", "0", "--fit", "off"],
    "a GPU build with zero layers would still offload prompt processing to a GPU");
});

test("when nothing fits, nothing is evicted and the error lists concrete options", () => {
  const result = plan({ estimate: { ...estimate(30000), kvCacheBytes: 4 * GiB, totalBytes: 38 * GiB }, devices: [gpu(0, 1500)], system: { totalBytes: 32 * GiB },
    residents: [{ modelId: "big", deviceBytes: {}, hostBytes: 6 * GiB }, { modelId: "small", deviceBytes: {}, hostBytes: 1 * GiB }] });
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.deepEqual(result.options.filter(option => option.action === "unload").map(option => (option as { modelId: string }).modelId), ["big", "small"]);
  assert.ok(result.options.some(option => option.action === "smaller_quantization"));
  assert.match(result.message, /Not enough memory to load m: .*unload big/);
});

// Qwen2.5-14B-Instruct Q4_K_M at 4096 context on an idle GTX 1070 Ti (8105 MiB, 7981 MiB free).
// Measured: ~765 MiB fixed plus ~171 MiB per offloaded layer; 25 layers ran at 5.5 tok/s, 33 at 7.2.
const qwen14b = estimateModelMemory(8_988_110_976, 4096, { version: 3, architecture: "qwen2", blockCount: 48, embeddingLength: 5120, headCount: 40, headCountKv: 8 });
const gtx1070ti = gpu(0, 7981, 8105);
const measuredMiB = (layers: number) => 765 + layers * 171;

test("partial offload uses most of the GPU yet keeps headroom over measured use", () => {
  const result = ok(plan({ estimate: qwen14b, devices: [gtx1070ti] }));
  assert.equal(result.kind, "partial");
  const layers = result.gpuLayers as number;
  assert.ok(layers >= 30, `${layers} layers`);
  assert.ok(measuredMiB(layers) <= 7981 - 512, `${measuredMiB(layers)} MiB of 7981 free`);
  assert.equal(result.label, `GPU 0 · partly CPU (${layers}/49 layers)`);
});

test("an out-of-memory retry moves to the next placement kind; partial first retries with fewer layers", () => {
  const retry = ok(plan({ devices: [gpu(0, 8000), gpu(1, 8000)], after: "single-gpu", policy: { safetyFactor: 1.2 } }));
  assert.equal(retry.kind, "multi-gpu");
  const first = ok(plan({ estimate: qwen14b, devices: [gtx1070ti] }));
  const smaller = ok(plan({ estimate: qwen14b, devices: [gtx1070ti], after: "partial", policy: { safetyFactor: 1.2 } }));
  assert.equal(smaller.kind, "partial");
  assert.ok((smaller.gpuLayers as number) < (first.gpuLayers as number), `${String(smaller.gpuLayers)} < ${String(first.gpuLayers)}`);
});

test("a user layer count is passed literally and 0 means CPU", () => {
  const result = ok(plan({ devices: [gpu(0, 8000)], gpuLayers: 20 }));
  assert.equal(result.manual, true);
  assert.deepEqual(result.launch.args, ["--device", "CUDA0", "--n-gpu-layers", "20", "--fit", "off"]);
  assert.equal(result.kind, "partial", "20 of 41 layers leaves the rest on the CPU");
  assert.equal(result.label, "GPU 0 · partly CPU (20/41 layers)");
  assert.equal(ok(plan({ devices: [gpu(0, 8000)], gpuLayers: 99 })).kind, "single-gpu");
});

test("a user layer count that fits only partly is checked against those layers, not the whole model", () => {
  const fits = ok(plan({ estimate: qwen14b, devices: [gtx1070ti], gpuLayers: 33 }));
  assert.equal(fits.kind, "partial");
  assert.equal(fits.label, "GPU 0 · partly CPU (33/49 layers)");
  assert.deepEqual(fits.warnings, []);
  assert.deepEqual(fits.launch.args, ["--device", "CUDA0", "--n-gpu-layers", "33", "--fit", "off"]);
  assert.match(ok(plan({ estimate: qwen14b, devices: [gtx1070ti], gpuLayers: 45 })).warnings[0]!, /45 GPU layers may not fit/);
});

test("Apple unified memory keeps today's arguments and blocks only on resident models", () => {
  const unified: InventoryDevice = { id: "unified", backendName: "MTL0", index: 0, name: "Unified memory", kind: "unified", totalBytes: 32 * GiB, freeBytes: 20 * GiB };
  const auto = ok(plan({ devices: [unified] }));
  assert.deepEqual(auto.launch, { args: ["--n-gpu-layers", "99"], env: {} });
  assert.deepEqual(ok(plan({ devices: [unified], gpuLayers: 32 })).launch.args, ["--n-gpu-layers", "32"]);
  const blocked = plan({ devices: [unified], estimate: estimate(20000), residents: [{ modelId: "loaded", deviceBytes: {}, hostBytes: 16 * GiB }] });
  assert.equal(blocked.kind, "error");
});

test("device listing parses llama-server and nvidia-smi output and maps identities in PCI order", () => {
  // Captured from llama.cpp b10809 on an Apple M4 Pro.
  assert.deepEqual(parseListDevices("Available devices:\n  MTL0: Apple M4 Pro (38338 MiB, 38338 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)\n").map(device => device.backendName), ["MTL0"]);
  assert.deepEqual(parseListDevices("Available devices:\n  (none)\n"), []);
  const listed = parseListDevices("Available devices:\n  CUDA0: NVIDIA GeForce RTX 3070 Ti (8191 MiB, 7600 MiB free)\n  CUDA1: NVIDIA RTX A4000 (16376 MiB, 16000 MiB free)\n");
  const smi = parseNvidiaSmi("1, GPU-bbb, 00000000:02:00.0, NVIDIA RTX A4000, 16376, 376, 16000\n0, GPU-aaa, 00000000:01:00.0, NVIDIA GeForce RTX 3070 Ti, 8191, 591, 7600\n2, [N/A], x, y, 1, 1, 1\n");
  assert.deepEqual(smi.map(row => row.uuid), ["GPU-aaa", "GPU-bbb"]);
  const merged = mergeDevices(listed, smi);
  assert.deepEqual(merged.devices.map(device => [device.backendName, device.uuid]), [["CUDA0", "GPU-aaa"], ["CUDA1", "GPU-bbb"]]);
  assert.deepEqual(merged.warnings, []);
  assert.deepEqual(mergeDevices(listed, smi, "1").devices.map(device => device.uuid), [undefined, undefined], "a count mismatch never guesses identities");
  assert.equal(mergeDevices(listed.slice(1), smi, "GPU-bbb").devices[0]!.uuid, undefined, "CUDA0 inside a restricted parent is the first visible GPU");
});

test("inventory never spawns on macOS and falls back to nvidia-smi when listing fails", async () => {
  let listed = 0;
  const mac = new DeviceInventory({ platform: "darwin", listDevices: async () => { listed++; return ""; }, nvidiaSmi: async () => undefined, systemMemory: () => ({ total: 32 * GiB, free: 20 * GiB }) });
  assert.equal((await mac.probeDevices()).devices[0]!.kind, "unified");
  assert.equal(listed, 0);
  const linux = new DeviceInventory({ platform: "linux", listDevices: async () => { throw new Error("no runtime"); },
    nvidiaSmi: async () => "0, GPU-aaa, 00000000:01:00.0, NVIDIA GeForce RTX 3070 Ti, 8191, 591, 7600\n", systemMemory: () => ({ total: 32 * GiB, free: 20 * GiB }), expectedBackend: "cuda" });
  const snapshot = await linux.probeDevices();
  assert.deepEqual(snapshot.devices.map(device => [device.backendName, device.uuid]), [["CUDA0", "GPU-aaa"]]);
  assert.match(snapshot.warnings[0]!, /nvidia-smi/);
  const cpuOnly = new DeviceInventory({ platform: "linux", listDevices: async () => "Available devices:\n  (none)\n", nvidiaSmi: async () => undefined,
    systemMemory: () => ({ total: 32 * GiB, free: 20 * GiB }), expectedBackend: "cuda" });
  const none = await cpuOnly.probeDevices();
  assert.equal(none.fallbackReason, "No NVIDIA GPU or driver was found.");
  assert.match(none.warnings.join(" "), /Models run on the CPU/);
  const oldDriver = new DeviceInventory({ platform: "linux", listDevices: async () => "Available devices:\n  (none)\n",
    nvidiaSmi: async () => "0, GPU-aaa, 00000000:01:00.0, NVIDIA GeForce GTX 1070 Ti, 8192, 111, 7981\n", systemMemory: () => ({ total: 32 * GiB, free: 20 * GiB }), expectedBackend: "cuda" });
  assert.match((await oldDriver.probeDevices()).fallbackReason ?? "", /NVIDIA GPU was found, but the CUDA runtime cannot use it/);
  const cpuBuild = new DeviceInventory({ platform: "linux", listDevices: async () => { throw new Error("no runtime"); },
    nvidiaSmi: async () => "0, GPU-aaa, 00000000:01:00.0, NVIDIA GeForce RTX 3070 Ti, 8191, 591, 7600\n", systemMemory: () => ({ total: 32 * GiB, free: 20 * GiB }), expectedBackend: "cpu" });
  const cpuSnapshot = await cpuBuild.probeDevices();
  assert.deepEqual(cpuSnapshot.devices, [], "a CPU build is never launched with --device CUDA0");
  assert.equal(cpuSnapshot.fallbackReason, undefined);
});
