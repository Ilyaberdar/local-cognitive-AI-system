import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { danglingRuntimeLinks, repairRuntimeLinks } from "../src/update/runtimeLinks";

const posix = process.platform !== "win32";

const temporary = (t: TestContext) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lc-runtime-links-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
};

// A llama.cpp runtime folder as an older update left it: every library link an absolute path into a
// release that has since been pruned.
const brokenRuntime = (base: string) => {
  const runtime = path.join(base, "releases", "0.1.4", "resources", "llama", "linux-x64-cuda12");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "libllama.so.0.4.0"), "llama");
  fs.writeFileSync(path.join(runtime, "libggml.so.0.23.0"), "ggml");
  fs.writeFileSync(path.join(runtime, "llama-server"), "#!/bin/sh\n", { mode: 0o755 });
  const gone = path.join(base, "releases", "0.1.0", "resources", "llama", "linux-x64-cuda12");
  for (const [name, target] of [["libllama.so", "libllama.so.0.4.0"], ["libllama.so.0", "libllama.so.0.4.0"], ["libggml.so.0", "libggml.so.0.23.0"]]) {
    fs.symlinkSync(path.join(gone, target!), path.join(runtime, name!));
  }
  return runtime;
};

test("library links that point into a pruned release are pointed back at the files beside them", { skip: !posix }, t => {
  const runtime = brokenRuntime(temporary(t));
  assert.deepEqual(danglingRuntimeLinks(runtime).sort(), ["libggml.so.0", "libllama.so", "libllama.so.0"]);
  const result = repairRuntimeLinks(runtime);
  assert.deepEqual(result.relinked.sort(), ["libggml.so.0", "libllama.so", "libllama.so.0"]);
  assert.deepEqual(result.broken, []);
  assert.equal(fs.readlinkSync(path.join(runtime, "libllama.so.0")), "libllama.so.0.4.0", "relative, beside it");
  assert.equal(fs.readFileSync(path.join(runtime, "libllama.so"), "utf8"), "llama");
  assert.deepEqual(danglingRuntimeLinks(runtime), []);
  assert.deepEqual(repairRuntimeLinks(runtime), { relinked: [], broken: [] }, "a repaired folder is left alone");
  assert.ok(!fs.readdirSync(runtime).some(name => name.includes("relink")), "no temporary links are left");
});

test("upstream's relative chains are kept, and nothing outside the folder is followed or changed", { skip: !posix }, t => {
  const base = temporary(t), runtime = path.join(base, "runtime"), outside = path.join(base, "outside");
  fs.mkdirSync(runtime); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(runtime, "libmtmd.so.0.4.0"), "mtmd");
  fs.symlinkSync("libmtmd.so.0.4.0", path.join(runtime, "libmtmd.so.0"));
  fs.symlinkSync("libmtmd.so.0", path.join(runtime, "libmtmd.so"));
  fs.writeFileSync(path.join(outside, "libcuda.so.1"), "driver");
  fs.symlinkSync("../outside/libcuda.so.1", path.join(runtime, "libcuda.so.1"));
  fs.symlinkSync("/nowhere/libmissing.so.0.1", path.join(runtime, "libmissing.so"));
  const result = repairRuntimeLinks(runtime);
  assert.deepEqual(result.relinked, []);
  assert.deepEqual(result.broken.sort(), ["libcuda.so.1", "libmissing.so"], "no file of that name beside them: reported, not touched");
  assert.equal(fs.readlinkSync(path.join(runtime, "libmtmd.so")), "libmtmd.so.0");
  assert.equal(fs.readlinkSync(path.join(runtime, "libcuda.so.1")), "../outside/libcuda.so.1");
  assert.equal(fs.readFileSync(path.join(outside, "libcuda.so.1"), "utf8"), "driver");
});

test("the server's repair-runtimes command does the same as root before the service starts", { skip: !posix }, t => {
  const base = temporary(t), runtime = brokenRuntime(base);
  const wrapper = fs.readFileSync("deploy/server/local-cognitive-server", "utf8");
  const repair = /\nrepair_runtimes\(\) \{\n[\s\S]*?\n\}\n/.exec(wrapper)?.[0];
  assert.ok(repair, "the repair_runtimes function");
  assert.match(wrapper, /\n {2}repair-runtimes\)\n {4}# [^\n]*\n {4}need_root "\$@"\n {4}repair_runtimes ;;\n/, "the repair-runtimes command");
  const unit = fs.readFileSync("deploy/server/local-cognitive.service", "utf8");
  assert.ok(unit.includes("\nExecStartPre=-+/usr/local/bin/local-cognitive-server repair-runtimes\n"), "the unit runs it as root, and a failure never blocks the start");
  fs.symlinkSync("releases/0.1.4", path.join(base, "current"));
  const output = execFileSync("bash", ["-c", `set -euo pipefail\nPREFIX=${JSON.stringify(base)}\n${repair}\nrepair_runtimes\nrepair_runtimes`]).toString();
  assert.equal(output.trim().split("\n").length, 3, "three links repaired, then nothing to do");
  assert.equal(fs.readlinkSync(path.join(runtime, "libllama.so")), "libllama.so.0.4.0");
  assert.equal(fs.readFileSync(path.join(runtime, "libggml.so.0"), "utf8"), "ggml");
  assert.deepEqual(danglingRuntimeLinks(runtime), []);
});
