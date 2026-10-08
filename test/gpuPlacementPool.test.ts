import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { DeviceInventory, type DeviceProbe } from "../src/local/DeviceInventory";
import { LocalRuntimePool } from "../src/local/LocalRuntimePool";
import type { ModelMemoryEstimate } from "../src/local/ModelCompatibility";
import { LocalModelError, type LocalModelOptions } from "../src/local/types";
import { Logger } from "../src/utils/Logger";

const MiB = 1024 ** 2, GiB = 1024 ** 3;
const estimate = (weightsMiB: number): ModelMemoryEstimate => ({ layers: 40, weightsBytes: weightsMiB * MiB, projectorBytes: 0, kvCacheBytes: 0,
  recurrentStateBytes: 0, overheadBytes: 384 * MiB, totalBytes: weightsMiB * MiB * 1.1 + 384 * MiB, perLayerBytes: weightsMiB * MiB * 1.1 / 41 });

// Records argv, the visible GPUs, working directory, inherited ggml settings and start time;
// reports CUDA OOM when asked for the first GPU only.
const fakeServer = `#!/usr/bin/env node
const fs=require('fs'),http=require('http'),path=require('path');const args=process.argv.slice(2);const value=k=>args[args.indexOf(k)+1];
const log=path.join(process.env.FAKE_LOG_DIR,'launches.jsonl');
fs.appendFileSync(log,JSON.stringify({model:value('--alias'),args,visible:process.env.CUDA_VISIBLE_DEVICES,cwd:process.cwd(),ggml:process.env.GGML_BACKEND_PATH,argHost:process.env.LLAMA_ARG_HOST,at:Date.now()})+'\\n');
if(process.env.FAKE_OOM_ON&&value('--device')==='CUDA0'&&process.env.CUDA_VISIBLE_DEVICES===process.env.FAKE_OOM_ON){console.error('ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9000 MiB on device 0: cudaMalloc failed: out of memory');process.exit(1);}
const delay=Number(process.env.FAKE_START_DELAY||0);
setTimeout(()=>http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');
if(req.url==='/health')return res.end('{"status":"ok"}');if(req.url==='/props')return res.end('{"n_ctx":2048}');
for await(const c of req){}res.end(JSON.stringify({output_text:'ok'}));}).listen(Number(value('--port')),'127.0.0.1'),delay);
`;

async function setup(t: TestContext, devices: string, gpuLayers: number | "auto" = "auto", platform: NodeJS.Platform = "linux",
  extra: { runtime?: Record<string, string>; inference?: LocalModelOptions["inference"] } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gpu-pool-")));
  const executable = path.join(root, "llama-server");
  await fs.writeFile(executable, fakeServer, { mode: 0o755 });
  if (extra.runtime) await fs.writeFile(path.join(root, "runtime.json"), JSON.stringify(extra.runtime));
  process.env.FAKE_LOG_DIR = root;
  const probe: DeviceProbe = { platform, listDevices: async () => devices, systemMemory: () => ({ total: 64 * GiB, free: 48 * GiB }),
    nvidiaSmi: async () => "0, GPU-a, 00000000:01:00.0, NVIDIA Fake, 8192, 0, 8192\n1, GPU-b, 00000000:02:00.0, NVIDIA Fake, 8192, 0, 8192\n",
    expectedBackend: extra.runtime?.backend };
  const options: LocalModelOptions = { enabled: true, dataDir: root, modelsDir: root, runtimeDir: root, executablePath: executable, contextSize: 2048,
    gpuLayers, loadTimeoutMs: 5000, generationTimeoutMs: 5000, memoryLimitPercent: 75, ...(extra.inference ? { inference: extra.inference } : {}) };
  const pool = new LocalRuntimePool(options, new Logger(), () => {}, new DeviceInventory(probe));
  t.after(async () => { await pool.dispose(); delete process.env.FAKE_OOM_ON; delete process.env.FAKE_START_DELAY; await fs.rm(root, { recursive: true, force: true }); });
  await pool.init();
  const launches = async () => (await fs.readFile(path.join(root, "launches.jsonl"), "utf8")).trim().split("\n")
    .map(line => JSON.parse(line) as { model: string; args: string[]; visible?: string; cwd: string; ggml?: string; argHost?: string; at: number });
  return { root, pool, launches };
}
const twoGpus = "Available devices:\n  CUDA0: NVIDIA Fake (8192 MiB, 8192 MiB free)\n  CUDA1: NVIDIA Fake (8192 MiB, 8192 MiB free)\n";

test("two models load one at a time and land on different GPUs", async t => {
  process.env.FAKE_START_DELAY = "150";
  const f = await setup(t, twoGpus);
  await Promise.all([f.pool.load("a", path.join(f.root, "a.gguf"), undefined, undefined, estimate(4000)),
    f.pool.load("b", path.join(f.root, "b.gguf"), undefined, undefined, estimate(4000))]);
  const [first, second] = await f.launches();
  assert.ok(second!.at - first!.at >= 140, "the second process starts after the first finished loading");
  assert.notEqual(first!.visible, second!.visible, "each model has its own GPU");
  assert.deepEqual(f.pool.snapshot().instances?.map(instance => instance.placement?.label).sort(), ["GPU 0", "GPU 1"]);
  assert.equal((await f.pool.generateText({ model: "a", prompt: "hi" })).text, "ok");
});

test("an out-of-memory load is retried once with the next placement", async t => {
  process.env.FAKE_OOM_ON = "GPU-a";
  const f = await setup(t, "Available devices:\n  CUDA0: NVIDIA Fake (8192 MiB, 8192 MiB free)\n  CUDA1: NVIDIA Fake (8192 MiB, 8192 MiB free)\n");
  // Fits a single GPU by estimate, but the first GPU reports out of memory.
  const snapshotFor = () => f.pool.forModel("big");
  await f.pool.load("big", path.join(f.root, "big.gguf"), undefined, undefined, estimate(5000));
  const launches = await f.launches();
  assert.equal(launches.length, 2);
  assert.equal(snapshotFor()?.placement?.kind, "multi-gpu");
  assert.equal(snapshotFor()?.placement?.retried, true);
});

test("a model that fits nowhere is refused with options and nothing is unloaded", async t => {
  const f = await setup(t, "Available devices:\n  CUDA0: NVIDIA Fake (8192 MiB, 8192 MiB free)\n");
  await f.pool.load("small", path.join(f.root, "small.gguf"), undefined, undefined, estimate(3000));
  await assert.rejects(f.pool.load("huge", path.join(f.root, "huge.gguf"), undefined, undefined, estimate(70000)),
    (error: unknown) => error instanceof LocalModelError && error.code === "insufficient_memory" && Array.isArray(error.details?.options));
  assert.deepEqual(f.pool.snapshot().loadedModelIds, ["small"]);
  assert.equal(f.pool.forModel("huge")?.status, "error");
});

test("macOS keeps the previous launch arguments; GPU layers 0 never probes devices", async t => {
  const mac = await setup(t, "should not be read", "auto", "darwin");
  await mac.pool.load("m", path.join(mac.root, "m.gguf"), undefined, undefined, estimate(1000));
  const [launch] = await mac.launches();
  assert.equal(launch!.args[launch!.args.indexOf("--n-gpu-layers") + 1], "99");
  assert.equal(launch!.args.includes("--device"), false);
  assert.equal(launch!.args.includes("--fit"), false);
  assert.equal(launch!.visible, undefined);

  const cpu = await setup(t, "should not be read", 0);
  await cpu.pool.load("c", path.join(cpu.root, "c.gguf"), undefined, undefined, estimate(1000));
  const [cpuLaunch] = await cpu.launches();
  assert.equal(cpuLaunch!.args[cpuLaunch!.args.indexOf("--n-gpu-layers") + 1], "0");
  assert.equal(cpuLaunch!.args.includes("--device"), false);
});

const cudaRuntime = { id: "linux-x64-cuda12", backend: "cuda", build: "b10809" };
const noDevices = "Available devices:\n  (none)\n";
const until = async (condition: () => boolean) => { for (let index = 0; index < 100 && !condition(); index++) await new Promise(resolve => setTimeout(resolve, 10)); };

test("llama-server runs inside its runtime directory without inherited ggml settings", async t => {
  process.env.GGML_BACKEND_PATH = "/tmp/planted-backend.so"; process.env.LLAMA_ARG_HOST = "0.0.0.0";
  t.after(() => { delete process.env.GGML_BACKEND_PATH; delete process.env.LLAMA_ARG_HOST; });
  const f = await setup(t, twoGpus);
  await f.pool.load("a", path.join(f.root, "a.gguf"), undefined, undefined, estimate(1000));
  const [launch] = await f.launches();
  assert.equal(launch!.cwd, f.root, "ggml also loads backends from the working directory");
  assert.equal(launch!.ggml, undefined);
  assert.equal(launch!.argHost, undefined);
});

test("a CUDA runtime is labelled by what the probe finds, and without a usable GPU says why", async t => {
  const gpu = await setup(t, twoGpus, "auto", "linux", { runtime: cudaRuntime });
  await until(() => gpu.pool.snapshot().backend === "CUDA");
  assert.equal(gpu.pool.snapshot().runtimeId, "linux-x64-cuda12");
  assert.equal(gpu.pool.snapshot().fallbackReason, undefined);

  const none = await setup(t, noDevices, "auto", "linux", { runtime: cudaRuntime });
  await until(() => Boolean(none.pool.snapshot().fallbackReason));
  assert.equal(none.pool.snapshot().backend, "CPU");
  assert.match(none.pool.snapshot().fallbackReason ?? "", /NVIDIA GPU was found, but the CUDA runtime cannot use it/);
  await none.pool.load("c", path.join(none.root, "c.gguf"), undefined, undefined, estimate(1000));
  const [launch] = await none.launches();
  assert.deepEqual(launch!.args.slice(launch!.args.indexOf("--device"), launch!.args.indexOf("--device") + 2), ["--device", "none"]);
  assert.equal(none.pool.forModel("c")?.placement?.kind, "cpu");
  assert.match(none.pool.forModel("c")?.placement?.warnings.join(" ") ?? "", /Models run on the CPU/);
});

test("--inference cuda without a CUDA device refuses to load instead of using the CPU", async t => {
  const f = await setup(t, noDevices, "auto", "linux", { runtime: cudaRuntime, inference: { preference: "cuda" } });
  await assert.rejects(f.pool.load("c", path.join(f.root, "c.gguf"), undefined, undefined, estimate(1000)),
    (error: unknown) => error instanceof LocalModelError && error.code === "cuda_unavailable" && /NVIDIA GPU was found/.test(error.message));
  await assert.rejects(f.launches(), /ENOENT/, "nothing was started");
});

test("GPU layers 0 on a CUDA runtime keeps the process off the GPUs and is not a fallback", async t => {
  const f = await setup(t, "should not be read", 0, "linux", { runtime: cudaRuntime });
  await f.pool.load("c", path.join(f.root, "c.gguf"), undefined, undefined, estimate(1000));
  const [launch] = await f.launches();
  assert.ok(launch!.args.join(" ").includes("--device none --n-gpu-layers 0"), launch!.args.join(" "));
  assert.equal(f.pool.snapshot().fallbackReason, undefined);
});
