import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { pathToFileURL } from "node:url";

// The scripts are ES modules; a real dynamic import survives the CommonJS test build.
const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, "..", "..");
const script = (name: string) => path.join(repo, "scripts", name);
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const posix = process.platform !== "win32";
const repoManifest = () => JSON.parse(fs.readFileSync(path.join(repo, "resources/llama/runtime-manifest.json"), "utf8"));

const cudaEntry = (files: Record<string, string>, overlaySha = "a".repeat(64)) => ({ platform: "linux", arch: "x64", backend: "cuda", base: "linux-x64", executable: "llama-server",
  overlay: { url: "https://example.invalid/overlay.tar.gz", sha256: overlaySha }, files, notices: ["CUDA_NOTICE.txt"] });

test("the manifest keeps schema 1 working and validates schema 2 variants", async () => {
  const { normalizeManifest, runtimeEntry } = await importModule(pathToFileURL(script("lib/llama-manifest.mjs")).href);
  const current = normalizeManifest(repoManifest());
  assert.equal(runtimeEntry(current, "linux-x64").backend, "cpu");
  assert.equal(runtimeEntry(current, "darwin-arm64").backend, "metal");
  const v2 = normalizeManifest({ ...repoManifest(), schemaVersion: 2, runtimes: { "linux-x64-cuda12": cudaEntry({ "libggml-cuda.so": "b".repeat(64) }) } });
  const cuda = runtimeEntry(v2, "linux-x64-cuda12");
  assert.equal(cuda.sha256, runtimeEntry(v2, "linux-x64").sha256, "the base archive is the platform build");
  assert.equal(cuda.overlay.sha256, "a".repeat(64));
  const reject = (change: (manifest: any) => void, pattern: RegExp) => {
    const manifest = { ...repoManifest(), schemaVersion: 2, runtimes: { "linux-x64-cuda12": cudaEntry({ "libggml-cuda.so": "b".repeat(64) }) } };
    change(manifest);
    assert.throws(() => normalizeManifest(manifest), pattern);
  };
  reject(m => { m.runtimes["linux-x64-cuda12"].base = "linux-arm64"; }, /unknown base/);
  reject(m => { m.runtimes["linux-x64-cuda12"].arch = "arm64"; }, /its base is linux-x64/);
  reject(m => { m.runtimes["linux-x64-cuda12"].overlay.url = "http://example.invalid/o.tgz"; }, /https/);
  reject(m => { m.runtimes["linux-x64-cuda12"].overlay.sha256 = "ABC"; }, /sha256/);
  reject(m => { m.runtimes["linux-x64-cuda12"].files = { "../libggml-cuda.so": "b".repeat(64) }; }, /file name/);
  reject(m => { m.runtimes["linux-x64-cuda12"].files = { "libggml-cpu-haswell.so": "b".repeat(64) }; }, /may not replace the base backend/);
  reject(m => { m.schemaVersion = 3; }, /unsupported schemaVersion/);
  reject(m => { delete m.schemaVersion; }, /require schemaVersion 2/);
});

/** A base tarball like upstream's, an overlay, and a manifest naming both. */
function fixture(t: TestContext, overlayFiles: Record<string, string>, options: { manifestFiles?: Record<string, string>; symlink?: string; extraFiles?: Record<string, string> } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llama-scripts-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, "base", "llama-b10809");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "llama-server"), "#!/bin/sh\necho 'version: 0.4.0 (build 10809)'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(base, "libggml-base.so"), "base");
  fs.writeFileSync(path.join(base, "libggml-cpu-haswell.so"), "cpu");
  spawnSync("tar", ["-czf", path.join(root, "base.tar.gz"), "-C", path.join(root, "base"), "llama-b10809"]);
  const overlay = path.join(root, "overlay");
  fs.mkdirSync(path.join(overlay, "licenses"), { recursive: true });
  for (const [name, content] of Object.entries({ ...overlayFiles, ...options.extraFiles })) fs.writeFileSync(path.join(overlay, name), content);
  if (options.symlink) fs.symlinkSync("/etc/passwd", path.join(overlay, options.symlink));
  const names = fs.readdirSync(overlay, { recursive: true }).map(String).filter(name => !fs.statSync(path.join(overlay, name)).isDirectory() || fs.lstatSync(path.join(overlay, name)).isSymbolicLink());
  spawnSync("tar", ["-czf", path.join(root, "overlay.tar.gz"), "-C", overlay, ...names]);
  const listed = options.manifestFiles ?? Object.fromEntries(Object.entries(overlayFiles).filter(([name]) => name.endsWith(".so") || name.includes(".so.")).map(([name, content]) => [name, sha(content)]));
  const manifest = { ...repoManifest(), schemaVersion: 2, runtimes: { "linux-x64-cuda12": cudaEntry(listed, sha(fs.readFileSync(path.join(root, "overlay.tar.gz")))) } };
  manifest.platforms["linux-x64"].sha256 = sha(fs.readFileSync(path.join(root, "base.tar.gz")));
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
  const destination = path.join(root, "resources", "llama", "linux-x64-cuda12");
  const prepare = (...extra: string[]) => spawnSync(process.execPath, [script("prepare-llama-runtime.mjs"), "--manifest", path.join(root, "manifest.json"), "--variant", "linux-x64-cuda12",
    "--archive", path.join(root, "base.tar.gz"), "--overlay", path.join(root, "overlay.tar.gz"), "--destination", destination, ...extra], { encoding: "utf8" });
  return { root, destination, prepare };
}
const goodOverlay = { "libggml-cuda.so": "cuda module", "libcudart.so.12": "cudart", "CUDA_NOTICE.txt": "notice", "licenses/NVIDIA-CUDA-EULA.txt": "eula" };

test("prepare assembles a CUDA variant from the base build and a verified overlay, and verify re-checks it", { skip: !posix }, t => {
  const f = fixture(t, goodOverlay);
  const prepared = f.prepare();
  assert.equal(prepared.status, 0, prepared.stderr);
  const runtime = JSON.parse(fs.readFileSync(path.join(f.destination, "runtime.json"), "utf8"));
  assert.deepEqual({ id: runtime.id, backend: runtime.backend, build: runtime.build }, { id: "linux-x64-cuda12", backend: "cuda", build: "b10809" });
  assert.equal(runtime.overlaySha256, sha(fs.readFileSync(path.join(f.root, "overlay.tar.gz"))));
  for (const name of ["llama-server", "libggml-base.so", "libggml-cpu-haswell.so", "libggml-cuda.so", "libcudart.so.12", "CUDA_NOTICE.txt", "licenses/NVIDIA-CUDA-EULA.txt"]) {
    assert.ok(fs.existsSync(path.join(f.destination, name)), name);
  }
  assert.equal(fs.statSync(path.join(f.destination, "libggml-cuda.so")).mode & 0o111, 0o111);
  assert.deepEqual(fs.readdirSync(path.dirname(f.destination)), ["linux-x64-cuda12"], "no partial directory is left behind");

  const resources = path.join(f.root, "resources");
  fs.copyFileSync(path.join(f.root, "manifest.json"), path.join(resources, "llama", "runtime-manifest.json"));
  fs.writeFileSync(path.join(resources, "llama", "THIRD_PARTY_NOTICES.txt"), "notices");
  fs.mkdirSync(path.join(resources, "models"));
  fs.writeFileSync(path.join(resources, "models", "recommended.json"), "{}");
  const verify = () => spawnSync(process.execPath, [script("verify-packaged-runtime.mjs"), resources, "--variant", "linux-x64-cuda12"], { encoding: "utf8" });
  const verified = verify();
  assert.equal(verified.status, 0, verified.stderr);
  fs.appendFileSync(path.join(f.destination, "libcudart.so.12"), "x");
  assert.match(verify().stderr, /libcudart\.so\.12 SHA-256 mismatch/);
});

test("prepare refuses overlays that do not match the manifest or could escape their directory", { skip: !posix }, t => {
  const cases: Array<[string, ReturnType<typeof fixture>, RegExp]> = [
    ["an unlisted backend", fixture(t, goodOverlay, { extraFiles: { "libggml-cpu-haswell.so": "planted" } }), /does not list|would replace/],
    ["a symlink", fixture(t, goodOverlay, { symlink: "licenses/link.txt" }), /not a regular file/],
    ["a listed file with another hash", fixture(t, goodOverlay, { manifestFiles: { "libggml-cuda.so": sha("different"), "libcudart.so.12": sha("cudart") } }), /libggml-cuda\.so SHA-256 mismatch/],
    ["a file that collides with the base", fixture(t, { ...goodOverlay, "llama-server": "replaced" }, { manifestFiles: { "libggml-cuda.so": sha("cuda module") } }), /does not list|would replace/]
  ];
  for (const [label, f, pattern] of cases) {
    const result = f.prepare();
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, pattern, label);
    assert.equal(fs.existsSync(f.destination), false, `${label}: nothing is installed`);
  }
  const baseMismatch = fixture(t, goodOverlay);
  fs.appendFileSync(path.join(baseMismatch.root, "base.tar.gz"), "x");
  assert.match(baseMismatch.prepare().stderr, /Runtime archive SHA-256 mismatch/);
  const foreign = fixture(t, goodOverlay);
  fs.mkdirSync(foreign.destination, { recursive: true });
  fs.writeFileSync(path.join(foreign.destination, "notes.txt"), "mine");
  assert.match(foreign.prepare().stderr, /not a prepared runtime; refusing to replace it/);
  assert.equal(fs.readFileSync(path.join(foreign.destination, "notes.txt"), "utf8"), "mine");
});
