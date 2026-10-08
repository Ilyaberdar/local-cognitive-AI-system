import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readInstalledRuntime, runtimeDirOf, runtimeEnv } from "../src/local/RuntimeInstall";

test("the runtime environment drops inherited ggml and llama-server settings and prefers bundled libraries", () => {
  const env = runtimeEnv({ PATH: "/usr/bin", GGML_BACKEND_PATH: "/x/libggml-evil.so", GGML_CUDA_DEVICES: "4", ggml_cuda_enable_unified_memory: "1",
    LLAMA_ARG_HOST: "0.0.0.0", LLAMA_ARG_MODEL: "/x", LD_LIBRARY_PATH: "/usr/local/cuda/lib64:/opt/rt::/usr/lib" }, "/opt/rt", "linux");
  assert.deepEqual(env, { PATH: "/usr/bin", LD_LIBRARY_PATH: "/opt/rt:/usr/local/cuda/lib64:/usr/lib" });
  assert.equal(runtimeEnv({}, "/opt/rt", "linux").LD_LIBRARY_PATH, "/opt/rt");
  assert.deepEqual(runtimeEnv({ PATH: "/usr/bin", DYLD_LIBRARY_PATH: "/x", GGML_BACKEND_PATH: "/y" }, "/opt/rt", "darwin"), { PATH: "/usr/bin", DYLD_LIBRARY_PATH: "/x" });
});

test("installed runtime metadata is optional and never throws", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readInstalledRuntime(root), undefined);
  fs.writeFileSync(path.join(root, "runtime.json"), "{not json");
  assert.equal(readInstalledRuntime(root), undefined);
  fs.writeFileSync(path.join(root, "runtime.json"), "[1]");
  assert.equal(readInstalledRuntime(root), undefined);
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ id: "linux-x64-cuda12", backend: "cuda", build: "b10809" }));
  assert.equal(readInstalledRuntime(root)?.backend, "cuda");
  assert.equal(runtimeDirOf({ runtimeDir: "/opt/rt", executablePath: "/custom/bin/llama-server" }), "/custom/bin");
  assert.equal(runtimeDirOf({ runtimeDir: "/opt/rt" }), "/opt/rt");
});
