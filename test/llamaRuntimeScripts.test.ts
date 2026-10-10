import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { zipOf } from "./fixtures/zip";

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
  fs.writeFileSync(
    path.join(base, "llama-server"),
    `#!/bin/sh
case "$1" in
  --version) echo 'version: 0.4.0 (build 10809)' ;;
  --list-devices) echo 'Available devices:' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 }
  );
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

test("downloads take as long as they need and give up only when nothing arrives", async t => {
  const { download } = await importModule(pathToFileURL(script("lib/download.mjs")).href);
  // Ten bytes 50 ms apart; /stalls sends two and then keeps the connection open.
  const server = http.createServer((request, response) => {
    if (request.url === "/missing") { response.writeHead(404).end(); return; }
    const stopAfter = request.url === "/stalls" ? 2 : 10;
    response.writeHead(200, { "content-length": "10" });
    let sent = 0;
    const timer = setInterval(() => {
      if (sent === stopAfter) { clearInterval(timer); return; }
      response.write(Buffer.from([sent]));
      if (++sent === 10) { clearInterval(timer); response.end(); }
    }, 50);
    request.on("close", () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "download-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  // Half a second in all, longer than the 400 ms without data that ends a download.
  await download(`${base}/slow`, path.join(directory, "slow"), "the slow file", { stallMs: 400, progressMs: 0, log });
  assert.deepEqual([...fs.readFileSync(path.join(directory, "slow"))], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(lines[0], "Downloading the slow file");
  assert.ok(lines.length > 1, "progress is shown while it lasts");
  await assert.rejects(download(`${base}/stalls`, path.join(directory, "stalls"), "the stalled file", { stallMs: 400, log }), /the stalled file download stopped: nothing arrived/);
  await assert.rejects(download(`${base}/missing`, path.join(directory, "missing"), "the missing file", { stallMs: 400, log }), /HTTP 404/);
});

test("the manifest pins Vulkan for Windows and CUDA variants with archives of their own", async () => {
  const { normalizeManifest, runtimeEntry } = await importModule(pathToFileURL(script("lib/llama-manifest.mjs")).href);
  const manifest = normalizeManifest(repoManifest());
  const windows = runtimeEntry(manifest, "win32-x64");
  assert.deepEqual({ backend: windows.backend, kind: windows.kind, executable: windows.executable }, { backend: "vulkan", kind: "zip", executable: "llama-server.exe" });
  for (const id of ["win32-x64-cuda12", "win32-x64-cuda13"]) {
    const cuda = runtimeEntry(manifest, id);
    assert.equal(cuda.backend, "cuda");
    assert.equal(cuda.base, undefined, "its own archive, not the Vulkan build");
    assert.ok(cuda.url.startsWith(`https://github.com/ggml-org/llama.cpp/releases/download/${manifest.build}/`), cuda.url);
    assert.ok(cuda.overlay.url.startsWith(`https://github.com/ggml-org/llama.cpp/releases/download/${manifest.build}/`), cuda.overlay.url);
    assert.equal(cuda.overlay.kind, "zip");
    assert.ok(Number(cuda.requires.nvidiaDriver) > 0);
  }
  const windowsRuntime = (patch: (entry: any) => void) => {
    const entry = { platform: "win32", arch: "x64", backend: "cuda", executable: "llama-server.exe", archive: { url: "https://example.invalid/cuda.zip", sha256: "c".repeat(64) },
      overlay: { url: "https://example.invalid/cudart.zip", sha256: "d".repeat(64) }, files: { "cudart64_12.dll": "e".repeat(64) } };
    patch(entry);
    return () => normalizeManifest({ ...repoManifest(), runtimes: { "win32-x64-cuda99": entry } });
  };
  assert.equal(windowsRuntime(() => undefined)().entries.get("win32-x64-cuda99").kind, "zip");
  assert.throws(windowsRuntime(entry => { entry.base = "win32-x64"; }), /either a base or an archive/);
  assert.throws(windowsRuntime(entry => { delete entry.archive; }), /either a base or an archive/);
  assert.throws(windowsRuntime(entry => { entry.archive.url = "https://example.invalid/cuda.7z"; }), /\.zip or \.tar\.gz/);
  assert.throws(windowsRuntime(entry => { entry.files = { "ggml-cpu-haswell.dll": "e".repeat(64) }; }), /may not replace the base backend/);
  assert.throws(windowsRuntime(entry => { entry.files = { "GGML-BASE.DLL": "e".repeat(64) }; }), /may not replace the base backend/);
  assert.throws(windowsRuntime(entry => { entry.requires = { nvidiaDriver: "latest" }; }), /requires nvidiaDriver/);
  assert.throws(() => normalizeManifest({ ...repoManifest(), runtimes: { "win32-x64-../x": {} } }), /runtime id/);
});

/** A minimal PE32+ file that imports `imports` and delay-loads `delayed`. */
const fakePe = (imports: string[], delayed: string[] = []) => {
  const headers = Buffer.alloc(0x400), section = Buffer.alloc(0x400);
  let names = 0x300;
  const nameRva = (name: string) => { const rva = 0x1000 + names; section.write(`${name}\0`, names, "latin1"); names += name.length + 1; return rva; };
  imports.forEach((name, index) => section.writeUInt32LE(nameRva(name), index * 20 + 12));
  delayed.forEach((name, index) => section.writeUInt32LE(nameRva(name), 0x100 + index * 32 + 4));
  headers.write("MZ", 0, "latin1"); headers.writeUInt32LE(0x40, 0x3c); headers.write("PE\0\0", 0x40, "latin1");
  headers.writeUInt16LE(0x8664, 0x44); headers.writeUInt16LE(1, 0x46); headers.writeUInt16LE(240, 0x54);
  const optional = 0x58;
  headers.writeUInt16LE(0x20b, optional); headers.writeUInt32LE(16, optional + 108);
  headers.writeUInt32LE(0x1000, optional + 112 + 8); headers.writeUInt32LE((imports.length + 1) * 20, optional + 112 + 12);
  if (delayed.length) { headers.writeUInt32LE(0x1100, optional + 112 + 104); headers.writeUInt32LE((delayed.length + 1) * 32, optional + 112 + 108); }
  const table = optional + 240;
  headers.write(".rdata", table, "latin1"); headers.writeUInt32LE(0x400, table + 8); headers.writeUInt32LE(0x1000, table + 12); headers.writeUInt32LE(0x400, table + 16); headers.writeUInt32LE(0x400, table + 20);
  return Buffer.concat([headers, section]);
};

test("Windows runtimes: imports are read from PE headers, and a folder must bring the C++ runtime but never the driver", async t => {
  const { peImports, missingImports } = await importModule(pathToFileURL(script("lib/pe-imports.mjs")).href);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pe-imports-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "llama-server.exe"), fakePe(["llama.dll", "KERNEL32.dll", "vcruntime140.dll", "api-ms-win-crt-runtime-l1-1-0.dll"], ["vulkan-1.dll"]));
  fs.writeFileSync(path.join(directory, "llama.dll"), fakePe(["msvcp140.dll", "kernel32.dll"]));
  assert.deepEqual(await peImports(path.join(directory, "llama-server.exe")), ["llama.dll", "kernel32.dll", "vcruntime140.dll", "api-ms-win-crt-runtime-l1-1-0.dll", "vulkan-1.dll"]);
  assert.deepEqual(Object.fromEntries(await missingImports(directory)), { "vcruntime140.dll": ["llama-server.exe"], "msvcp140.dll": ["llama.dll"] });
  fs.writeFileSync(path.join(directory, "vcruntime140.dll"), fakePe([]));
  fs.writeFileSync(path.join(directory, "MSVCP140.dll"), fakePe([]));
  assert.equal((await missingImports(directory)).size, 0, "names match without regard to case");
  fs.writeFileSync(path.join(directory, "notes.dll"), "not a program");
  await assert.rejects(missingImports(directory), /not a PE file/);
});

test("prepare assembles a Windows CUDA runtime from two zip archives and refuses unsafe zip entries", { skip: !posix }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llama-zip-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nvidia = { "cudart64_12.dll": fakePe(["kernel32.dll"]), "cublas64_12.dll": fakePe(["cublasLt64_12.dll"]), "cublasLt64_12.dll": fakePe(["kernel32.dll"]) };
  const write = (name: string, files: Record<string, string | Buffer>) => { fs.writeFileSync(path.join(root, name), zipOf(files)); return sha(fs.readFileSync(path.join(root, name))); };
  const build = (cuda: Record<string, string | Buffer>, cudart: Record<string, string | Buffer>) => {
    const runtime = { platform: "win32", arch: "x64", backend: "cuda", executable: "llama-server.exe",
      archive: { url: "https://example.invalid/llama-cuda.zip", sha256: write("cuda.zip", cuda) }, overlay: { url: "https://example.invalid/cudart.zip", sha256: write("cudart.zip", cudart) },
      files: Object.fromEntries(Object.entries(nvidia).map(([name, content]) => [name, sha(content)])), notices: [] };
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ ...repoManifest(), runtimes: { "win32-x64-cuda12": runtime } }));
    const destination = path.join(root, "resources", "llama", "win32-x64-cuda12");
    const prepared = spawnSync(process.execPath, [script("prepare-llama-runtime.mjs"), "--manifest", path.join(root, "manifest.json"), "--variant", "win32-x64-cuda12",
      "--archive", path.join(root, "cuda.zip"), "--overlay", path.join(root, "cudart.zip"), "--destination", destination], { encoding: "utf8" });
    return { prepared, destination };
  };
  const base = { "llama-server.exe": fakePe(["llama.dll", "kernel32.dll"]), "llama.dll": fakePe(["ggml-cuda.dll"]), "ggml-cuda.dll": fakePe(["cudart64_12.dll", "cublas64_12.dll", "nvcuda.dll"]) };
  const { prepared, destination } = build(base, nvidia);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stderr, /Visual C\+\+ runtime is not bundled/, "only a Windows machine can bundle it");
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, "runtime.json"), "utf8")).backend, "cuda");
  assert.match(fs.readFileSync(path.join(destination, "CUDA_NOTICE.txt"), "utf8"), /docs\.nvidia\.com\/cuda\/eula/, "NVIDIA's notice goes in beside its DLLs");
  for (const name of [...Object.keys(base), ...Object.keys(nvidia)]) assert.ok(fs.existsSync(path.join(destination, name)), name);

  // The packaged check: the C++ runtime is missing until it is bundled; the driver and Vulkan never belong.
  const resources = path.join(root, "resources");
  fs.copyFileSync(path.join(root, "manifest.json"), path.join(resources, "llama", "runtime-manifest.json"));
  fs.writeFileSync(path.join(resources, "llama", "THIRD_PARTY_NOTICES.txt"), "notices");
  fs.mkdirSync(path.join(resources, "models"));
  fs.writeFileSync(path.join(resources, "models", "recommended.json"), "{}");
  const verify = (...extra: string[]) => spawnSync(process.execPath, [script("verify-packaged-runtime.mjs"), resources, "--variant", "win32-x64-cuda12", ...extra], { encoding: "utf8" });
  assert.equal(verify().status, 0, verify().stderr);
  fs.writeFileSync(path.join(destination, "llama-server.exe"), fakePe(["llama.dll", "kernel32.dll", "vcruntime140.dll"]));
  assert.match(verify("--check-libraries").stderr, /libraries missing from the runtime: vcruntime140\.dll \(needed by 1\)/);
  fs.writeFileSync(path.join(destination, "vcruntime140.dll"), fakePe([]));
  assert.equal(verify("--check-libraries").status, 0, verify("--check-libraries").stderr);
  fs.writeFileSync(path.join(destination, "ggml-vulkan.dll"), fakePe([]));
  assert.match(verify().stderr, /must not contain the Vulkan backend/);
  fs.rmSync(path.join(destination, "ggml-vulkan.dll"));
  fs.writeFileSync(path.join(destination, "nvcuda.dll"), fakePe([]));
  assert.match(verify().stderr, /must not contain nvcuda\.dll/);

  for (const unsafe of ["../outside.dll", "C:evil.dll", "/etc/evil.dll", "dir\\evil.dll"]) {
    fs.rmSync(path.join(root, "resources"), { recursive: true, force: true });
    const { prepared: refused, destination: nothing } = build(base, { ...nvidia, [unsafe]: "x" });
    assert.notEqual(refused.status, 0, unsafe);
    assert.match(refused.stderr, /unsafe path/, unsafe);
    assert.equal(fs.existsSync(nothing), false, `${unsafe}: nothing is installed`);
  }
  fs.rmSync(path.join(root, "resources"), { recursive: true, force: true });
  const collision = build({ ...base, "CUDART64_12.DLL": "base copy" }, nvidia);
  assert.match(collision.prepared.stderr, /would replace cudart64_12\.dll/, "names collide regardless of case");
});

