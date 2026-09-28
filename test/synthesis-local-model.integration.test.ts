import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

/** Deliberately opt-in: ordinary CI must not load a multi-gigabyte local model. */
test("real local model executes authored calculator DSL and produces trusted Pass evidence", {
  skip: process.env.SYNTHESIS_MODEL_PATH ? false : "Set SYNTHESIS_MODEL_PATH to an installed GGUF to run real inference (no download).",
  timeout: 1000000
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-synthesis-real-"));
  // Keep artifacts for research/reproduction, including failed runs.
  console.log(`Real synthesis evidence: ${directory}`);
  const child = spawn(process.execPath, [path.resolve("scripts/run-synthesis-demo.cjs"), "--model-path", process.env.SYNTHESIS_MODEL_PATH!, "--data-dir", directory], {stdio: ["ignore", "pipe", "pipe"]});
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  let output = "";
  child.stdout.on("data", chunk => { output = (output + String(chunk)).slice(-16000); });
  child.stderr.on("data", chunk => { output = (output + String(chunk)).slice(-16000); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, output);
  const report = JSON.parse(await fs.readFile(path.join(directory, "report.json"), "utf8"));
  assert.equal(report.run.status, "accepted");
  assert.equal(report.run.evidence.status, "Pass");
  assert.ok(report.run.usage.calls > 0);
  assert.ok(report.run.models.every((model: {providerId: string}) => model.providerId === "llamacpp"));
  assert.ok(report.run.events.some((event: {step: string}) => event.step === "models.load"));
  assert.equal(report.diff.files.length, 3);
});
