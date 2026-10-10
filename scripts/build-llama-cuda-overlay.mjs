// Builds the linux-x64 CUDA 12 overlay for llama.cpp: libggml-cuda.so from the pinned commit plus
// the NVIDIA runtime libraries it links, taken unmodified from NVIDIA's redistributable archives.
// Linux only (docker, GNU tar, gzip, readelf). Building is local; publishing is a separate step that
// needs the owner's CUDA EULA sign-off (.github/workflows/llama-cuda-runtime.yml).
//
//   module  --source <llama.cpp checkout> --out <dir> [--architectures "61-real;..."] [--image <devel image>] [--jobs n] [--docker "sudo docker"]
//   package --module <libggml-cuda.so> --toolchain <file> --llama-license <file> --architectures <list>
//           --tag <release tag> --repository <owner/repo> --out <dir> [--downloads <dir>] [--base-archive <file>] [--skip-smoke]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeManifest, runtimeEntry, sha256File } from './lib/llama-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VARIANT = 'linux-x64-cuda12', BASE = 'linux-x64', TOOLKIT = '12.8.1';
const DEFAULT_IMAGE = 'nvidia/cuda:12.8.1-devel-ubuntu22.04';
// Real code for common GPUs (61 = GTX 10xx), PTX for the rest so newer and older GPUs still run.
const DEFAULT_ARCHITECTURES = '50-virtual;61-real;70-virtual;75-real;80-real;86-real;89-real;90-real;90-virtual;120a-real';
// NVIDIA CUDA 12.8 Update 1 redistributables (redistrib_12.8.1.json).
const NVIDIA = [
  { name: 'cudart', version: '12.8.90', libraries: ['libcudart.so.12'], sha256: '8d566b5fe745c46842dc16945cf36686227536decd2302c372be86da37faca68',
    url: 'https://developer.download.nvidia.com/compute/cuda/redist/cuda_cudart/linux-x86_64/cuda_cudart-linux-x86_64-12.8.90-archive.tar.xz' },
  { name: 'cublas', version: '12.8.4.1', libraries: ['libcublas.so.12', 'libcublasLt.so.12'], sha256: '21718957c2cf000bacd69d36c95708a2319199e39e056f8b4f0f68e3b9f323bb',
    url: 'https://developer.download.nvidia.com/compute/cuda/redist/libcublas/linux-x86_64/libcublas-linux-x86_64-12.8.4.1-archive.tar.xz' }
];
// What libggml-cuda.so may link: ggml, the bundled CUDA libraries, the driver and the C/C++ runtime.
const ALLOWED_NEEDED = new Set(['libggml-base.so.0', 'libcudart.so.12', 'libcublas.so.12', 'libcublasLt.so.12', 'libcuda.so.1', 'libstdc++.so.6', 'libm.so.6',
  'libgcc_s.so.1', 'libc.so.6', 'ld-linux-x86-64.so.2', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1']);
const REQUIRED_NEEDED = ['libggml-base.so.0', 'libcudart.so.12', 'libcublas.so.12'];
// The upstream CPU build already needs these; the overlay must not raise the host requirements.
const CEILINGS = { GLIBC: '2.35', GLIBCXX: '3.4.30' };

const args = process.argv.slice(2);
const command = args[0];
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const required = (flag) => { const result = value(flag); if (!result) throw new Error(`${flag} is required`); return result; };
const compare = (left, right) => {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
};
const manifestFile = path.join(root, 'resources/llama/runtime-manifest.json');
const repositoryManifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
const manifest = normalizeManifest(repositoryManifest);

async function buildModule() {
  const source = path.resolve(required('--source')), out = path.resolve(required('--out'));
  const head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== manifest.commit) throw new Error(`${source} is at ${head}, but the manifest pins ${manifest.commit}.`);
  await fs.mkdir(out, { recursive: true });
  const [docker, ...dockerArgs] = value('--docker', 'docker').split(/\s+/);
  const script = [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq && apt-get install -y -qq --no-install-recommends cmake ninja-build >/dev/null',
    'cmake -S /src -B /tmp/build -G Ninja -DCMAKE_BUILD_TYPE=Release "-DCMAKE_INSTALL_RPATH=\\$ORIGIN" -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON'
      + ' -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON -DGGML_NATIVE=OFF -DGGML_CPU=OFF -DGGML_CUDA=ON -DGGML_CUDA_NCCL=OFF'
      + ' "-DCMAKE_CUDA_ARCHITECTURES=$CUDA_ARCHITECTURES" -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TOOLS=OFF'
      + ' -DLLAMA_BUILD_SERVER=OFF -DLLAMA_OPENSSL=OFF > /out/configure.log',
    'cmake --build /tmp/build --target ggml-cuda -j "$JOBS" > /out/build.log',
    'cp /tmp/build/bin/libggml-cuda.so /out/',
    '{ nvcc --version | tail -1; gcc --version | head -1; cmake --version | head -1; } > /out/toolchain.txt',
    'chown -R "$HOST_ID" /out'
  ].join('\n');
  execFileSync(docker, [...dockerArgs, 'run', '--rm', '-e', `CUDA_ARCHITECTURES=${value('--architectures', DEFAULT_ARCHITECTURES)}`,
    '-e', `JOBS=${value('--jobs', String(Math.max(1, os.availableParallelism() - 1)))}`, '-e', `HOST_ID=${process.getuid()}:${process.getgid()}`,
    '-v', `${source}:/src:ro`, '-v', `${out}:/out`, value('--image', DEFAULT_IMAGE), 'bash', '-euo', 'pipefail', '-c', script], { stdio: 'inherit' });
  console.log(`Built ${path.join(out, 'libggml-cuda.so')}`);
}

/** RUNPATH, NEEDED and the highest symbol versions required from glibc and libstdc++. */
function inspectModule(file) {
  const dynamic = execFileSync('readelf', ['-dW', file], { encoding: 'utf8' });
  const runpath = /\(RUNPATH\)\s+Library runpath: \[(.*)\]/.exec(dynamic)?.[1];
  const needed = [...dynamic.matchAll(/\(NEEDED\)\s+Shared library: \[(.*)\]/g)].map(match => match[1]);
  const versions = execFileSync('readelf', ['-VW', file], { encoding: 'utf8' });
  const highest = (prefix) => [...versions.matchAll(new RegExp(`Name: ${prefix}_([0-9.]+)`, 'g'))].map(match => match[1]).sort(compare).at(-1);
  return { runpath, needed, glibc: highest('GLIBC'), glibcxx: highest('GLIBCXX') };
}

async function fetchVerified(item, directory) {
  const file = path.join(directory, path.basename(new URL(item.url).pathname));
  if (await sha256File(file).catch(() => '') === item.sha256) return file;
  console.log(`Downloading ${item.url}`);
  const response = await fetch(item.url, { signal: AbortSignal.timeout(1_800_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  if (await sha256File(file) !== item.sha256) throw new Error(`${path.basename(file)} SHA-256 mismatch.`);
  return file;
}

async function packageOverlay() {
  const tag = required('--tag'), repository = required('--repository'), architectures = required('--architectures');
  if (!new RegExp(`^llama-${manifest.build}-cuda${TOOLKIT.replace(/\./g, '\\.')}-r\\d+$`).test(tag)) throw new Error(`Tag ${tag} must look like llama-${manifest.build}-cuda${TOOLKIT}-r1.`);
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) throw new Error(`Repository ${repository} must be owner/name.`);
  const module = path.resolve(required('--module')), out = path.resolve(required('--out'));
  const downloads = path.resolve(value('--downloads', path.join(out, 'downloads')));
  const overlay = path.join(out, 'overlay'), release = path.join(out, 'release'), scratch = path.join(out, 'nvidia');
  for (const directory of [overlay, release, scratch]) await fs.rm(directory, { recursive: true, force: true });
  for (const directory of [downloads, path.join(overlay, 'licenses'), release, scratch]) await fs.mkdir(directory, { recursive: true });

  const inspected = inspectModule(module);
  if (inspected.runpath !== '$ORIGIN') throw new Error(`libggml-cuda.so RUNPATH is ${inspected.runpath ?? 'missing'}, expected $ORIGIN.`);
  const unexpected = inspected.needed.filter(name => !ALLOWED_NEEDED.has(name));
  if (unexpected.length) throw new Error(`libggml-cuda.so links unexpected libraries: ${unexpected.join(', ')}`);
  const absent = REQUIRED_NEEDED.filter(name => !inspected.needed.includes(name));
  if (absent.length) throw new Error(`libggml-cuda.so does not link ${absent.join(', ')}; is it a CUDA backend module?`);
  if (inspected.glibc && compare(inspected.glibc, CEILINGS.GLIBC) > 0) throw new Error(`libggml-cuda.so needs GLIBC_${inspected.glibc} (at most ${CEILINGS.GLIBC}).`);
  if (inspected.glibcxx && compare(inspected.glibcxx, CEILINGS.GLIBCXX) > 0) throw new Error(`libggml-cuda.so needs GLIBCXX_${inspected.glibcxx} (at most ${CEILINGS.GLIBCXX}).`);
  await fs.copyFile(module, path.join(overlay, 'libggml-cuda.so'));

  const licenses = [];
  for (const item of NVIDIA) {
    const archive = await fetchVerified(item, downloads);
    const target = path.join(scratch, item.name);
    await fs.mkdir(target);
    execFileSync('tar', ['-xJf', archive, '-C', target, '--wildcards', ...item.libraries.map(library => `*/lib/${library}*`), '*/LICENSE']);
    const [top] = await fs.readdir(target);
    // The archive's soname entry is a symlink to the versioned file; the overlay holds the file itself.
    for (const library of item.libraries) await fs.copyFile(await fs.realpath(path.join(target, top, 'lib', library)), path.join(overlay, library));
    licenses.push({ name: item.name, text: await fs.readFile(path.join(target, top, 'LICENSE'), 'utf8') });
  }
  const eulaFiles = licenses.every(license => license.text === licenses[0].text) ? [['licenses/NVIDIA-CUDA-EULA.txt', licenses[0].text]]
    : licenses.map(license => [`licenses/NVIDIA-CUDA-EULA-${license.name}.txt`, license.text]);
  for (const [name, text] of eulaFiles) await fs.writeFile(path.join(overlay, name), text);
  await fs.copyFile(path.resolve(required('--llama-license')), path.join(overlay, 'licenses/llama.cpp-LICENSE'));
  const versions = Object.fromEntries(NVIDIA.map(item => [item.name, item.version]));
  await fs.writeFile(path.join(overlay, 'CUDA_NOTICE.txt'), [
    `NVIDIA CUDA redistributable components (runtime ${VARIANT})`,
    `This directory contains unmodified object-code files from the NVIDIA CUDA Toolkit ${TOOLKIT},`,
    'redistributed under the NVIDIA CUDA Toolkit End User License Agreement, Attachment A',
    '("CUDA Runtime", "CUDA BLAS Library"):',
    ...NVIDIA.flatMap(item => item.libraries.map(library => `  ${library.padEnd(18)} ${item.name} ${item.version}  (${path.basename(new URL(item.url).pathname)})`)),
    'Copyright (c) NVIDIA Corporation. All rights reserved. NVIDIA, CUDA and cuBLAS are trademarks of NVIDIA Corporation.',
    'These files are provided solely for use by the bundled llama.cpp CUDA backend (libggml-cuda.so) of',
    'Local Cognitive and may only be accessed by that application; they are not licensed for',
    'separate use or redistribution. Their use is governed by the NVIDIA CUDA Toolkit EULA',
    `(${eulaFiles.map(([name]) => name).join(', ')}; https://docs.nvidia.com/cuda/eula/).`,
    `libggml-cuda.so is built from llama.cpp (MIT, licenses/llama.cpp-LICENSE) ${manifest.build}, commit`,
    `${manifest.commit}, for CUDA architectures ${architectures}.`,
    'An NVIDIA GPU and NVIDIA driver 570 or newer (not included) are required.', ''
  ].join('\n'));

  const libraries = ['libggml-cuda.so', ...NVIDIA.flatMap(item => item.libraries)];
  for (const library of libraries) await fs.chmod(path.join(overlay, library), 0o755);
  const files = Object.fromEntries(await Promise.all(libraries.map(async library => [library, await sha256File(path.join(overlay, library))])));
  const notices = ['CUDA_NOTICE.txt', 'licenses/llama.cpp-LICENSE', ...eulaFiles.map(([name]) => name)];
  const toolchain = (await fs.readFile(path.resolve(required('--toolchain')), 'utf8')).trim().split('\n');
  await fs.writeFile(path.join(overlay, 'cuda-overlay.json'), JSON.stringify({ variant: VARIANT, build: manifest.build, commit: manifest.commit, toolkit: TOOLKIT,
    ...versions, architectures, toolchain, requires: { glibc: inspected.glibc, glibcxx: inspected.glibcxx, nvidiaDriver: '570' }, files }, null, 2));

  // Deterministic archive: same inputs, same bytes.
  const fileName = `llama-${manifest.build}-linux-x64-cuda${TOOLKIT}-overlay.tar.gz`;
  const tarFile = path.join(out, 'overlay.tar'), archive = path.join(release, fileName);
  execFileSync('tar', ['--format=ustar', '--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0', '--mode=go-w', '-cf', tarFile, '-C', overlay,
    ...libraries, ...notices, 'cuda-overlay.json']);
  execFileSync('gzip', ['-9n', '-f', tarFile]);
  await fs.rename(`${tarFile}.gz`, archive);
  const overlaySha = await sha256File(archive);
  const fragment = { schemaVersion: 2, runtimes: { [VARIANT]: { platform: 'linux', arch: 'x64', backend: 'cuda', base: BASE, executable: 'llama-server',
    overlay: { url: `https://github.com/${repository}/releases/download/${tag}/${fileName}`, sha256: overlaySha }, files, notices,
    validation: 'not tested on target hardware' } } };
  await fs.writeFile(path.join(release, 'manifest-fragment.json'), `${JSON.stringify(fragment, null, 2)}\n`);
  await fs.writeFile(path.join(release, 'SHA256SUMS'), `${overlaySha}  ${fileName}\n${await sha256File(path.join(release, 'manifest-fragment.json'))}  manifest-fragment.json\n`);
  await fs.writeFile(path.join(release, 'RELEASE_NOTES.md'), [
    `llama.cpp ${manifest.build} CUDA ${TOOLKIT} overlay for ${BASE}.`, '',
    `Adds libggml-cuda.so (architectures ${architectures}) and the NVIDIA CUDA runtime and cuBLAS libraries to the upstream ${BASE} build.`,
    'Requires an NVIDIA driver 570 or newer. NVIDIA components are redistributed under the CUDA EULA; see CUDA_NOTICE.txt in the archive.', '',
    `Paste manifest-fragment.json into resources/llama/runtime-manifest.json, then run npm run prepare:llama:server.`, ''
  ].join('\n'));
  const merged = path.join(out, 'manifest.json');
  await fs.writeFile(merged, JSON.stringify({ ...repositoryManifest, schemaVersion: 2, runtimes: { ...repositoryManifest.runtimes, ...fragment.runtimes } }, null, 2));
  runtimeEntry(normalizeManifest(JSON.parse(await fs.readFile(merged, 'utf8'))), VARIANT);
  console.log(JSON.stringify({ archive, sha256: overlaySha, files, requires: { glibc: inspected.glibc, glibcxx: inspected.glibcxx } }, null, 2));

  if (args.includes('--skip-smoke')) return;
  // The real prepare and verify scripts, as a user would run them, on the merged manifest.
  const resources = path.join(out, 'smoke', 'resources');
  await fs.rm(path.join(out, 'smoke'), { recursive: true, force: true });
  await fs.mkdir(path.join(resources, 'llama'), { recursive: true });
  await fs.mkdir(path.join(resources, 'models'), { recursive: true });
  await fs.copyFile(merged, path.join(resources, 'llama', 'runtime-manifest.json'));
  await fs.copyFile(path.join(root, 'resources/llama/THIRD_PARTY_NOTICES.txt'), path.join(resources, 'llama', 'THIRD_PARTY_NOTICES.txt'));
  await fs.copyFile(path.join(root, 'resources/models/recommended.json'), path.join(resources, 'models', 'recommended.json'));
  const base = value('--base-archive');
  execFileSync(process.execPath, [path.join(root, 'scripts/prepare-llama-runtime.mjs'), '--manifest', merged, '--variant', VARIANT, '--overlay', archive,
    '--destination', path.join(resources, 'llama', VARIANT), ...(base ? ['--archive', path.resolve(base)] : [])], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(root, 'scripts/verify-packaged-runtime.mjs'), resources, '--variant', VARIANT, '--check-libraries'], { stdio: 'inherit' });
}

if (command === 'module') await buildModule();
else if (command === 'package') await packageOverlay();
else throw new Error('Usage: build-llama-cuda-overlay.mjs module|package [options] (see the header of this file)');
