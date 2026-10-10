import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { createHash } from "node:crypto";
import { setDiagnosticSink } from "../src/diagnostics/DiagnosticLog";
import { chooseCudaVariant, compareVersions, cudaVariants, CUDA_LICENSE_TOKEN, GpuRuntimeService, parseNvidiaQuery, type CudaVariant } from "../src/local/GpuRuntimeService";
import { LocalModelService } from "../src/local/LocalModelService";
import { Logger } from "../src/utils/Logger";
import { zipOf } from "./fixtures/zip";

const MiB = 1024 ** 2;
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const repoManifest = () => JSON.parse(fs.readFileSync(path.resolve("resources/llama/runtime-manifest.json"), "utf8"));
const posix = process.platform !== "win32";

test("nvidia-smi answers with or without compute capability, and names may contain commas", () => {
  assert.deepEqual(parseNvidiaQuery("NVIDIA GeForce RTX 3070 Ti, 610.88, 8192, 8.6\r\n"), [{ name: "NVIDIA GeForce RTX 3070 Ti", driver: "610.88", memoryBytes: 8192 * MiB, computeCapability: "8.6" }]);
  assert.deepEqual(parseNvidiaQuery("NVIDIA RTX A4000, Quadro, 552.12, 16376\n"), [{ name: "NVIDIA RTX A4000, Quadro", driver: "552.12", memoryBytes: 16376 * MiB }], "an old driver without compute_cap");
  assert.equal(parseNvidiaQuery("NVIDIA A, 580.1, 24576, 8.9\nNVIDIA B, 580.1, 24576, 8.9\n").length, 2);
  assert.deepEqual(parseNvidiaQuery("No devices were found\n"), []);
  assert.ok(compareVersions("551.78", "551.6") > 0 && compareVersions("580", "580.00") === 0 && compareVersions("566.36", "580") < 0);
});

test("the CUDA build is chosen by GPU and driver: ready code first, then the lowest requirements", () => {
  const variants = cudaVariants(repoManifest(), "win32", "x64");
  assert.deepEqual(variants.map(variant => variant.id), ["win32-x64-cuda13", "win32-x64-cuda12"]);
  assert.deepEqual(cudaVariants(repoManifest(), "darwin", "arm64"), []);
  const pick = (gpu: { name?: string; driver: string; computeCapability?: string }) => chooseCudaVariant([{ name: "NVIDIA", ...gpu }], variants);
  assert.equal(pick({ driver: "610.88", computeCapability: "8.6" }).variant?.id, "win32-x64-cuda13", "RTX 3070 Ti: CUDA 13 has its code");
  assert.equal(pick({ driver: "590.1", computeCapability: "12.0" }).variant?.id, "win32-x64-cuda13", "RTX 50");
  assert.equal(pick({ driver: "580.88", computeCapability: "6.1" }).variant?.id, "win32-x64-cuda12", "GTX 1070 Ti: only CUDA 12 still runs Pascal");
  assert.equal(pick({ driver: "580.88", computeCapability: "7.5" }).variant?.id, "win32-x64-cuda12", "RTX 20: no ready code anywhere, so the lowest requirements");
  assert.equal(pick({ driver: "566.36", computeCapability: "8.9" }).variant?.id, "win32-x64-cuda12", "an RTX 40 with a driver too old for CUDA 13");
  assert.equal(pick({ driver: "552.12" }).variant?.id, "win32-x64-cuda12", "unknown compute capability");
  assert.match(pick({ driver: "537.58", computeCapability: "8.6" }).reason ?? "", /Update the NVIDIA driver to 551\.78 or newer to use CUDA \(this computer has 537\.58\)/);
  assert.equal(chooseCudaVariant([], variants).reason, "No NVIDIA GPU was found.");
});

/** The variant's two archives, served locally (with Range), and a manifest that pins them. */
function fixture(t: TestContext, options: { slow?: boolean; overlayExtra?: Record<string, string> } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gpu-runtime-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nvidia = { "cudart64_13.dll": "cudart", "cublas64_13.dll": "cublas", "cublasLt64_13.dll": "cublasLt" };
  const archive = zipOf({ "llama-server.exe": "server", "ggml-cuda.dll": "cuda", "ggml-base.dll": "base" });
  const overlay = zipOf({ ...nvidia, ...options.overlayExtra });
  const variant = { platform: "win32", arch: "x64", backend: "cuda", executable: "llama-server.exe",
    archive: { url: "https://example.invalid/cuda.zip", sha256: sha(archive), size: archive.length },
    overlay: { url: "https://example.invalid/cudart.zip", sha256: sha(zipOf({ ...nvidia })), size: zipOf({ ...nvidia }).length },
    files: Object.fromEntries(Object.entries(nvidia).map(([name, content]) => [name, sha(content)])),
    requires: { nvidiaDriver: "580", minComputeCapability: "7.5", nativeComputeCapabilities: ["8.6"] }, installedBytes: 4096 };
  const manifest = { build: "b10809", commit: "5266f24", runtimes: { "win32-x64-cuda13": variant } };
  const served = new Map([["/cuda.zip", archive], ["/cudart.zip", overlay]]);
  const requests: Array<{ url: string; range?: string }> = [];
  const server = http.createServer((request, response) => {
    const file = served.get(request.url ?? "");
    requests.push({ url: request.url ?? "", range: request.headers.range });
    if (!file) { response.writeHead(404).end(); return; }
    const start = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1] ?? 0);
    const body = file.subarray(start);
    response.writeHead(start ? 206 : 200, { "content-length": String(body.length) });
    if (!options.slow) { response.end(body); return; }
    let sent = 0;
    const timer = setInterval(() => { response.write(body.subarray(sent, sent + 16)); sent += 16; if (sent >= body.length) { clearInterval(timer); response.end(); } }, 20);
    request.on("close", () => clearInterval(timer));
  });
  const bundled = path.join(root, "bundled");
  fs.mkdirSync(bundled);
  for (const name of ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"]) fs.writeFileSync(path.join(bundled, name), name);
  const runtimesDir = path.join(root, "runtimes");
  const activations: string[] = [];
  let devices = "Available devices:\n  CUDA0: NVIDIA GeForce RTX 3070 Ti (8191 MiB, 7109 MiB free)\n";
  const create = (port: number) => new GpuRuntimeService({ runtimesDir, bundledRuntimeDir: bundled, manifestFile: "", dataDir: path.join(root, "data"), platform: "win32", arch: "x64",
    fetcher: ((url: string, init?: RequestInit) => fetch(String(url).replace("https://example.invalid", `http://127.0.0.1:${port}`), init)) as typeof fetch,
    nvidiaSmi: async () => "NVIDIA GeForce RTX 3070 Ti, 610.88, 8192, 8.6\n",
    run: async (_file, args) => args[0] === "--version" ? { status: 0, stdout: "version: 0.4.0 (build 10809)", stderr: "" } : { status: 0, stdout: devices, stderr: "" },
    changed: () => undefined, activate: async () => { activations.push(service.activeRuntimeDir() ?? "bundled"); } }, manifest);
  let service!: GpuRuntimeService;
  const start = async () => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    service = create((server.address() as AddressInfo).port);
    return service;
  };
  return { root, runtimesDir, requests, activations, start, again: () => create((server.address() as AddressInfo).port), setDevices: (value: string) => { devices = value; },
    folder: path.join(runtimesDir, "win32-x64-cuda13-b10809"), variant: variant as unknown as CudaVariant };
}

test("installing CUDA needs NVIDIA's license, then downloads, checks and switches models to it", { skip: !posix }, async t => {
  const f = fixture(t);
  const service = await f.start();
  await service.detect();
  assert.equal(service.snapshot().cuda.state, "available");
  assert.equal(service.snapshot().cuda.offer, true, "offered once at first launch");
  assert.equal(service.snapshot().gpu?.name, "NVIDIA GeForce RTX 3070 Ti");
  await assert.rejects(service.install(undefined), /Accept NVIDIA's license/);
  await service.install(CUDA_LICENSE_TOKEN);
  await service.whenIdle();
  assert.equal(service.snapshot().cuda.state, "installed", service.snapshot().cuda.reason);
  assert.equal(service.snapshot().cuda.offer, false);
  assert.deepEqual(f.activations, [f.folder], "models switched to the CUDA build");
  for (const name of ["llama-server.exe", "ggml-cuda.dll", "cudart64_13.dll", "cublasLt64_13.dll", "vcruntime140.dll", "CUDA_NOTICE.txt"]) assert.ok(fs.existsSync(path.join(f.folder, name)), name);
  assert.match(fs.readFileSync(path.join(f.folder, "CUDA_NOTICE.txt"), "utf8"), /docs\.nvidia\.com\/cuda\/eula/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.folder, "runtime.json"), "utf8")).requires, { nvidiaDriver: "580" });
  assert.deepEqual(fs.readdirSync(path.join(f.runtimesDir, ".downloads")), [], "the archives are gone");
  assert.equal(f.again().activeRuntimeDir(), f.folder, "after a restart too");

  await service.remove();
  assert.equal(fs.existsSync(f.folder), false);
  assert.deepEqual(f.activations, [f.folder, "bundled"], "models went back to the bundled build before the files were removed");
  assert.equal(service.snapshot().cuda.state, "available");
  assert.equal(service.snapshot().cuda.offer, false, "not offered again");
});

test("a changed NVIDIA archive or a CUDA build without a CUDA device installs nothing", { skip: !posix }, async t => {
  const recorded: unknown[] = [];
  setDiagnosticSink({ record: (event, fields) => { recorded.push([event, fields]); } });
  t.after(() => setDiagnosticSink(undefined));
  const changed = fixture(t, { overlayExtra: { "cudart64_13.dll.bak": "planted" } });
  const one = await changed.start();
  await one.install(CUDA_LICENSE_TOKEN);
  await one.whenIdle();
  assert.equal(one.snapshot().cuda.state, "available");
  assert.match(one.snapshot().cuda.reason ?? "", /does not match the pinned release/);
  assert.equal(fs.existsSync(changed.folder), false);
  assert.deepEqual(changed.activations, []);
  assert.deepEqual(recorded.at(-1), ["local_runtime.install_failed", { backend: "cuda", stage: "download", code: "checksum_mismatch" }]);

  const blind = fixture(t);
  const two = await blind.start();
  blind.setDevices("Available devices:\n  (none)\n");
  await two.install(CUDA_LICENSE_TOKEN);
  await two.whenIdle();
  assert.match(two.snapshot().cuda.reason ?? "", /does not see the GPU\. Update the NVIDIA driver to 580 or newer/);
  assert.equal(fs.existsSync(blind.folder), false, "nothing is installed");
  assert.deepEqual(fs.readdirSync(blind.runtimesDir).filter(name => name.startsWith(".staging")), [], "the staging folder is removed");
});

test("a cancelled download continues where it stopped; declining the offer is remembered", { skip: !posix }, async t => {
  const f = fixture(t, { slow: true });
  const service = await f.start();
  await service.install(CUDA_LICENSE_TOKEN);
  await new Promise(resolve => setTimeout(resolve, 120));
  service.cancel();
  await service.whenIdle();
  assert.equal(service.snapshot().cuda.state, "available");
  assert.equal(service.snapshot().cuda.reason, undefined, "a cancel is no error");
  const partial = fs.readdirSync(path.join(f.runtimesDir, ".downloads")).find(name => name.endsWith(".part"));
  assert.ok(partial, "what arrived is kept");
  const kept = fs.statSync(path.join(f.runtimesDir, ".downloads", partial!)).size;
  assert.ok(kept > 0);
  await service.install(CUDA_LICENSE_TOKEN);
  await service.whenIdle();
  assert.equal(service.snapshot().cuda.state, "installed", service.snapshot().cuda.reason);
  assert.ok(f.requests.some(request => request.range === `bytes=${kept}-`), "the download continued with a Range request");

  const declined = fixture(t);
  const first = await declined.start();
  await first.detect();
  await first.dismissOffer();
  const restarted = declined.again();
  await restarted.detect();
  assert.equal(restarted.snapshot().cuda.offer, false);
  assert.equal(restarted.snapshot().cuda.state, "available", "Settings keeps the button");
});

test("models use an installed CUDA build, and one that sees no GPU sends them back to the bundled build", { skip: !posix }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gpu-activate-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A fake llama-server that lists the devices given in its folder's devices.txt.
  const server = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');const args=process.argv.slice(2);
if(args.includes('--version')){console.log('version: 0.4.0 (build 10809)');process.exit(0);}
if(args.includes('--list-devices')){process.stdout.write(fs.readFileSync(path.join(__dirname,'devices.txt'),'utf8'));process.exit(0);}
process.exit(1);
`;
  const runtime = (directory: string, metadata: object, devices: string) => {
    fs.mkdirSync(directory, { recursive: true });
    for (const name of ["llama-server", "llama-server.exe"]) fs.writeFileSync(path.join(directory, name), server, { mode: 0o755 });
    fs.writeFileSync(path.join(directory, "runtime.json"), JSON.stringify(metadata));
    fs.writeFileSync(path.join(directory, "devices.txt"), devices);
  };
  const bundled = path.join(root, "llama", "win32-x64"), runtimesDir = path.join(root, "runtimes");
  runtime(bundled, { id: "win32-x64", backend: "vulkan", build: "b10809" }, "Available devices:\n  Vulkan0: NVIDIA Fake (8192 MiB, 8000 MiB free)\n");
  const cuda = path.join(runtimesDir, "win32-x64-cuda13-b10809");
  runtime(cuda, { id: "win32-x64-cuda13", backend: "cuda", build: "b10809" }, "Available devices:\n  CUDA0: NVIDIA Fake (8192 MiB, 8000 MiB free)\n");
  const manifest = { ...repoManifest(), build: "b10809" };
  let service!: LocalModelService;
  const gpu = new GpuRuntimeService({ runtimesDir, bundledRuntimeDir: bundled, manifestFile: "", dataDir: path.join(root, "data"), platform: "win32", arch: "x64",
    nvidiaSmi: async () => "NVIDIA Fake, 610.88, 8192, 8.6\n", changed: () => undefined, activate: () => service.activateRuntime() }, manifest);
  service = new LocalModelService({ enabled: true, dataDir: path.join(root, "data"), modelsDir: path.join(root, "models"), runtimeDir: bundled, runtimesDir, contextSize: 2048,
    gpuLayers: "auto", loadTimeoutMs: 5000, generationTimeoutMs: 5000, memoryLimitPercent: 75 }, new Logger(), gpu);
  t.after(() => service.dispose());
  await service.init();
  assert.equal(service.snapshot().runtime.runtimeId, "win32-x64-cuda13", "an installed CUDA build is used from the start");
  assert.equal(service.snapshot().runtime.acceleration?.cuda.state, "installed");

  fs.writeFileSync(path.join(cuda, "devices.txt"), "Available devices:\n  (none)\n");
  await service.activateRuntime();
  assert.equal(service.snapshot().runtime.runtimeId, "win32-x64", "back on the bundled build");
  assert.equal(service.snapshot().runtime.acceleration?.cuda.state, "failed");
  assert.match(service.snapshot().runtime.acceleration?.cuda.reason ?? "", /does not see the GPU/);
  assert.equal(gpu.activeRuntimeDir(), undefined);
});
