import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readInstalledRuntime, runtimeDirOf, runtimeEnv, runtimeIsolation } from "../src/local/RuntimeInstall";

test("the runtime environment drops inherited ggml and llama-server settings and prefers bundled libraries", () => {
  const env = runtimeEnv({ PATH: "/usr/bin", GGML_BACKEND_PATH: "/x/libggml-evil.so", GGML_CUDA_DEVICES: "4", ggml_cuda_enable_unified_memory: "1",
    LLAMA_ARG_HOST: "0.0.0.0", LLAMA_ARG_MODEL: "/x", LD_LIBRARY_PATH: "/usr/local/cuda/lib64:/opt/rt::/usr/lib" }, "/opt/rt", "linux");
  assert.deepEqual(env, { PATH: "/usr/bin", VK_LOADER_LAYERS_DISABLE: "~implicit~", LD_LIBRARY_PATH: "/opt/rt:/usr/local/cuda/lib64:/usr/lib" });
  assert.equal(runtimeEnv({}, "/opt/rt", "linux").LD_LIBRARY_PATH, "/opt/rt");
  assert.deepEqual(runtimeEnv({ PATH: "/usr/bin", DYLD_LIBRARY_PATH: "/x", GGML_BACKEND_PATH: "/y" }, "/opt/rt", "darwin"), { PATH: "/usr/bin", DYLD_LIBRARY_PATH: "/x", VK_LOADER_LAYERS_DISABLE: "~implicit~" });
});

test("the runtime environment keeps the vision projector, Vulkan layers and the user's llama.cpp config out", () => {
  const inherited = { Path: "C:\\Windows", MTMD_BACKEND_DEVICE: "Vulkan0", VK_INSTANCE_LAYERS: "VK_LAYER_KHRONOS_validation", VK_LOADER_LAYERS_ENABLE: "*", VK_LAYER_PATH: "C:\\x",
    VK_ADD_LAYER_PATH: "C:\\y", APPDATA: "C:\\Users\\pc\\AppData\\Roaming" };
  const isolation = runtimeIsolation("C:\\data\\local-models");
  const windows = runtimeEnv(inherited, "C:\\rt", "win32", isolation);
  assert.deepEqual(windows, { Path: "C:\\Windows", VK_LOADER_LAYERS_DISABLE: "~implicit~", APPDATA: isolation.configDir, CUDA_CACHE_PATH: isolation.cudaCacheDir });
  const linux = runtimeEnv({ PATH: "/usr/bin", CUDA_CACHE_PATH: "/srv/cache" }, "/opt/rt", "linux", runtimeIsolation("/srv/data"));
  assert.equal(linux.XDG_CONFIG_HOME, "/srv/data/runtime/llama-config", "~/.config/llama.cpp/config.ini is not read");
  assert.equal(linux.CUDA_CACHE_PATH, "/srv/cache", "a cache the host chose stays");
  assert.equal(linux.APPDATA, undefined);
});

test("a CUDA runtime's driver requirement comes from runtime.json or the Linux overlay's metadata", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-requires-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ id: "linux-x64-cuda12", backend: "cuda" }));
  fs.writeFileSync(path.join(root, "cuda-overlay.json"), JSON.stringify({ requires: { nvidiaDriver: "570", glibc: "2.34" } }));
  assert.equal(readInstalledRuntime(root)?.requires?.nvidiaDriver, "570");
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ id: "win32-x64-cuda13", backend: "cuda", requires: { nvidiaDriver: "580" } }));
  assert.equal(readInstalledRuntime(root)?.requires?.nvidiaDriver, "580");
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
