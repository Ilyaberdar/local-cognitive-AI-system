import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { LocalInferenceScheduler } from "../src/local/LocalInferenceScheduler";
import { LlamaCppRuntime } from "../src/local/LlamaCppRuntime";
import { evaluateCompatibility } from "../src/local/ModelCompatibility";
import { parseMacMemory } from "../src/utils/systemMemory";
import { LocalModelOptions } from "../src/local/types";
import { Logger } from "../src/utils/Logger";

test("local inference serializes callers, cancels only the queued caller, and releases after failure", async () => {
  const scheduler = new LocalInferenceScheduler();
  const order: string[] = [];
  let release!: () => void;
  const first = scheduler.run("alpha", async () => { order.push("alpha:start"); await new Promise<void>((resolve) => { release = resolve; }); order.push("alpha:end"); return "first"; });
  await delay(0);
  const cancelled = new AbortController();
  const second = scheduler.run("beta", async () => { order.push("beta:unexpected"); }, cancelled.signal);
  const rejected = assert.rejects(second, /cancelled/i);
  const third = scheduler.run("alpha", async () => { order.push("third"); throw new Error("inference failed"); });
  const thirdRejected = assert.rejects(third, /inference failed/);
  assert.equal(scheduler.queueLength, 2); assert.equal(scheduler.activeModelId, "alpha");
  cancelled.abort(); await rejected;
  assert.equal(scheduler.queueLength, 1); assert.equal(scheduler.busy, true);
  release(); assert.equal(await first, "first"); await thirdRejected;
  assert.equal(await scheduler.run("gamma", async () => "recovered"), "recovered");
  assert.deepEqual(order, ["alpha:start", "alpha:end", "third"]);
  await scheduler.dispose();
});

test("scheduler shutdown rejects waiting work without executing it", async () => {
  const scheduler = new LocalInferenceScheduler(); let release!: () => void;
  const running = scheduler.run("alpha", () => new Promise<void>((resolve) => { release = resolve; }));
  await delay(0);
  const waiting = scheduler.run("beta", async () => assert.fail("queued request ran during shutdown"));
  const rejected = assert.rejects(waiting, /shutting down/); const shutdown = scheduler.dispose();
  await rejected; release(); await running; await shutdown;
  await assert.rejects(scheduler.run("gamma", async () => {}), /shutting down/);
});

test("compatibility uses total unified memory, with separate warning threshold and blockers", () => {
  const GiB = 1024 ** 3;
  const memory = { total: 48 * GiB, free: 1.8 * GiB };
  const metadata = { version: 3, architecture: "llama", chatTemplate: true, embeddingLength: 2048, blockCount: 24, headCount: 32, headCountKv: 8 };
  const small = evaluateCompatibility(1 * GiB, { contextSize: 4096, memoryLimitPercent: 75 }, metadata, 40 * GiB, false, memory);
  assert.notEqual(small.status, "incompatible"); assert.equal(small.availableMemoryBytes, 48 * GiB); assert.equal(small.memoryWarningBytes, 36 * GiB);
  const big = evaluateCompatibility(50 * GiB, { contextSize: 4096, memoryLimitPercent: 75 }, metadata, 40 * GiB, false, memory);
  assert.equal(big.status, "incompatible"); assert.ok(big.reasons.some((reason) => reason.includes("too large"))); assert.ok(big.reasons.some((reason) => reason.includes("disk")));
  const unsupported = evaluateCompatibility(10, { contextSize: 4096, memoryLimitPercent: 75 }, { version: 3, architecture: "clip" }, undefined, true, memory);
  assert.equal(unsupported.status, "incompatible");
  assert.deepEqual(unsupported.blockingIssues.map(issue => issue.code), ["model_type"]);
  assert.equal(big.canLoad, false); assert.equal(big.canDownload, false);
  const downloadable = evaluateCompatibility(50 * GiB, { contextSize: 4096, memoryLimitPercent: 75 }, metadata, 100 * GiB, false, memory);
  assert.equal(downloadable.canDownload, true); assert.equal(downloadable.canLoad, false);
});

test("Qwen35 hybrid caches account for explicit head size, recurrent layers and skipped MTP", () => {
  const GiB = 1024 ** 3; const MiB = 1024 ** 2;
  const metadata = { version: 3, architecture: "qwen35", chatTemplate: true, embeddingLength: 5120, blockCount: 65, nextnPredictLayers: 1,
    headCount: 24, headCountKv: 4, attentionKeyLength: 256, attentionValueLength: 256, fullAttentionInterval: 4,
    ssmConvKernel: 4, ssmInnerSize: 6144, ssmStateSize: 128, ssmGroupCount: 16 };
  const options = { contextSize: 4096, memoryLimitPercent: 75 };
  for (const architecture of ["qwen35", "qwen35moe"]) for (const size of [9.2 * GiB, 16464440224]) {
    const result = evaluateCompatibility(size, options, { ...metadata, architecture }, undefined, true, { total: 48 * GiB, free: 30 * GiB });
    assert.equal(result.canLoad, true); assert.equal(result.status, "compatible"); assert.equal(result.kvCacheBytes, 256 * MiB);
    assert.equal(result.recurrentStateBytes, 149.625 * MiB); assert.ok(result.estimatedMemoryBytes < 18 * GiB);
  }
  const longer = evaluateCompatibility(16464440224, { ...options, contextSize: 32768 }, metadata, undefined, true, { total: 48 * GiB, free: 40 * GiB });
  assert.equal(longer.kvCacheBytes, 2048 * MiB); assert.equal(longer.recurrentStateBytes, 149.625 * MiB);
  const explicit = evaluateCompatibility(16464440224, options, { ...metadata, recurrentLayers: Array.from({ length: 65 }, (_, index) => index < 64 && (index + 1) % 4 !== 0) }, undefined, true, { total: 48 * GiB, free: 40 * GiB });
  assert.equal(explicit.kvCacheBytes, 256 * MiB);
});

test("38 GiB weights remain loadable on a 48 GiB Mac above the warning threshold", () => {
  const GiB = 1024 ** 3;
  const result = evaluateCompatibility(38 * GiB, { contextSize: 4096, memoryLimitPercent: 75 }, { version: 3, architecture: "qwen35", chatTemplate: true }, undefined, true, { total: 48 * GiB, free: 40 * GiB });
  assert.equal(result.canLoad, true); assert.equal(result.status, "warning"); assert.deepEqual(result.reasons, []);
  assert.ok(result.warnings.some(warning => warning.includes("75% warning threshold")));
  const unknown = evaluateCompatibility(GiB, { contextSize: 4096, memoryLimitPercent: 75 }, { version: 3, architecture: "future-decoder", chatTemplate: true }, undefined, true, { total: 48 * GiB, free: 40 * GiB });
  assert.equal(unknown.canLoad, true, "The native loader must validate new decoder architectures");
});

test("macOS reclaimable file cache does not appear as occupied model memory", () => {
  const GiB = 1024 ** 3;
  const result = parseMacMemory('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 32768.\nFile-backed pages: 1966080.\n', 48 * GiB);
  assert.equal(result?.total, 48 * GiB); assert.equal(result?.free, 30.5 * GiB); assert.equal(result?.cached, 30 * GiB);
  assert.equal(parseMacMemory('invalid metrics', 48 * GiB), undefined);
});

test("native runtime uses loopback authentication, unload/reload, and recovers after a process crash", { skip: process.platform === "win32" }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llama-runtime-test-"));
  const executable = path.join(directory, "fake llama-server");
  await fs.writeFile(executable, `#!/usr/bin/env node
const http = require('http'); const fs = require('fs');
const args = process.argv.slice(2); const arg = name => args[args.indexOf(name)+1];
const model = arg('--model');
const server = http.createServer(async (req,res) => {
 if(req.url === '/health') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({status:'ok'})); return; }
 if(req.headers.authorization !== 'Bearer ' + process.env.LLAMA_API_KEY) {res.statusCode=401;res.end('{}');return;}
 let body=''; for await (const chunk of req) body += chunk;
 const payload = body ? JSON.parse(body) : {};
 if(payload.input === 'crash') {process.exit(7); return;}
 res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({status:'completed',output_text:'Local final answer',id:'ephemeral'}));
});
server.listen(Number(arg('--port')), '127.0.0.1', () => fs.writeFileSync(model + '.process.json', JSON.stringify({pid:process.pid,port:server.address().port})));
`, { mode: 0o755 });
  const options: LocalModelOptions = { enabled: true, dataDir: directory, modelsDir: directory, runtimeDir: directory, executablePath: executable,
    contextSize: 2048, gpuLayers: 0, loadTimeoutMs: 5000, generationTimeoutMs: 5000, memoryLimitPercent: 75 };
  const runtime = new LlamaCppRuntime(options, new Logger());
  t.after(async () => { await runtime.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  await runtime.init(); assert.equal(runtime.status, "stopped");
  const modelPath = path.join(directory, "tiny model.gguf");
  await runtime.load("tiny", modelPath);
  const first = JSON.parse(await fs.readFile(`${modelPath}.process.json`, "utf8"));
  const unauthorized = await fetch(`http://127.0.0.1:${first.port}/v1/models`); assert.equal(unauthorized.status, 401);
  assert.equal(runtime.snapshot().modelId, "tiny"); assert.equal("token" in runtime.snapshot(), false);
  const response = await runtime.generateText({ model: "tiny", prompt: "hello" });
  assert.equal(response.text, "Local final answer"); assert.equal(response.responseId, undefined);
  await runtime.load("tiny", modelPath);
  assert.equal(JSON.parse(await fs.readFile(`${modelPath}.process.json`, "utf8")).pid, first.pid);
  await runtime.stop(); assert.equal(runtime.status, "stopped");
  assert.throws(() => process.kill(first.pid, 0), /ESRCH/);
  await runtime.load("tiny", modelPath);
  const crashed = await runtime.generateText({ model: "tiny", prompt: "crash" }).catch((error: Error) => ({ error: error.message }));
  assert.ok(crashed.error);
  await delay(100);
  assert.equal(runtime.status, "error");
  await runtime.load("tiny", modelPath);
  assert.equal((await runtime.generateText({ model: "tiny", prompt: "again" })).text, "Local final answer");
  const guarded = JSON.parse(await fs.readFile(`${modelPath}.process.json`, "utf8"));
  (runtime as unknown as { child: import("node:child_process").ChildProcess }).child.kill("SIGKILL");
  for (let attempt = 0; runtime.status !== "error" && attempt < 100; attempt++) await delay(10);
  await delay(50);
  assert.equal(runtime.status, "error");
  await assert.rejects(fetch(`http://127.0.0.1:${guarded.port}/health`));
  await runtime.load("tiny", modelPath);
  assert.equal((await runtime.generateText({ model: "tiny", prompt: "guardian recovered" })).text, "Local final answer");
  await runtime.reconfigure({ ...options, contextSize: 4096 });
  assert.equal(runtime.status, "stopped"); assert.equal(runtime.snapshot().contextSize, 4096);
});
