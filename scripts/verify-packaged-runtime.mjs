import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeManifest, runtimeEntry, sha256File } from './lib/llama-manifest.mjs';
import { DRIVER_DLLS, missingImports } from './lib/pe-imports.mjs';

// Usage: node scripts/verify-packaged-runtime.mjs <application.app | resources directory> [--variant id]... [--check-libraries]
// A Windows build's resources directory is release/win-unpacked/resources. --check-libraries makes sure
// every library a runtime needs resolves: on Linux with ldd (on Linux), for Windows runtimes from their
// PE headers (on any machine), where Microsoft's C++ runtime must come with the runtime.
const supplied = process.argv[2];
if (!supplied || supplied.startsWith('--')) throw new Error('Usage: node scripts/verify-packaged-runtime.mjs <application.app | resources directory> [--variant id]... [--check-libraries]');
const resources = path.resolve(supplied.endsWith('.app') ? path.join(supplied, 'Contents/Resources') : supplied);
const variants = process.argv.flatMap((argument, index) => argument === '--variant' ? [process.argv[index + 1]] : []);
if (!variants.length) variants.push(`${process.platform}-${process.arch}`);
const checkLibraries = process.argv.includes('--check-libraries');
const manifest = normalizeManifest(JSON.parse(await fs.readFile(path.join(resources, 'llama/runtime-manifest.json'), 'utf8')));
await fs.access(path.join(resources, 'llama/THIRD_PARTY_NOTICES.txt'));
await fs.access(path.join(resources, 'models/recommended.json'));
// Nothing inherited may change the runtime's devices or arguments.
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GGML_|LLAMA_ARG_|MTMD_)/.test(name)));

const results = [];
for (const variant of variants) {
  const target = runtimeEntry(manifest, variant);
  const directory = path.join(resources, 'llama', variant);
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'runtime.json'), 'utf8'));
  if (metadata.sha256 !== target.sha256 || metadata.build !== manifest.build || metadata.backend !== target.backend || (metadata.id ?? variant) !== variant
    || metadata.overlaySha256 !== target.overlay?.sha256) throw new Error(`Packaged runtime metadata mismatch for ${variant}`);
  for (const [name, digest] of Object.entries(target.files ?? {})) {
    if (await sha256File(path.join(directory, name)) !== digest) throw new Error(`${variant}: ${name} SHA-256 mismatch`);
  }
  for (const [name, digest] of Object.entries(metadata.vcRuntime?.files ?? {})) {
    if (await sha256File(path.join(directory, name)) !== digest) throw new Error(`${variant}: ${name} SHA-256 mismatch`);
  }
  for (const name of target.notices ?? []) await fs.access(path.join(directory, name));
  const names = await fs.readdir(directory);
  // The driver's libraries must come from the host: a bundled copy or stub would hide every GPU.
  const stub = names.find(name => /^libcuda\.so/.test(name) || DRIVER_DLLS.has(name.toLowerCase()));
  if (stub) throw new Error(`${variant} must not contain ${stub}`);
  // A CUDA folder with the Vulkan backend too would list every NVIDIA GPU twice.
  if (target.backend === 'cuda' && names.some(name => /^(lib)?ggml-vulkan\./i.test(name))) throw new Error(`${variant} must not contain the Vulkan backend`);
  const result = { variant, backend: target.backend, result: 'passed' };
  if (checkLibraries && target.platform === 'win32') {
    const missing = await missingImports(directory);
    if (missing.size) throw new Error(`${variant}: libraries missing from the runtime: ${[...missing].map(([library, users]) => `${library} (needed by ${users.length})`).join(', ')}`);
    result.libraries = 'resolved';
  }
  if (target.platform === process.platform && target.arch === process.arch) {
    const run = (args) => spawnSync(path.join(directory, target.executable), args, { cwd: directory, encoding: 'utf8', timeout: 60000, env: environment });
    const checked = run(['--version']);
    if (checked.error || checked.status !== 0) throw checked.error ?? new Error(`${variant}: ${target.executable} exited ${checked.status}: ${checked.stderr}`);
    const output = checked.stdout + checked.stderr;
    if (!output.includes(manifest.version) && !output.includes(manifest.build.replace(/^b/, ''))) throw new Error(`Unexpected binary version: ${output}`);
    result.version = output.trim();
    if (target.backend === 'cuda' || target.backend === 'vulkan') {
      const devices = run(['--list-devices']);
      if (devices.status !== 0 || !devices.stdout.startsWith('Available devices:')) throw new Error(`${variant}: --list-devices failed: ${devices.stderr}`);
      result.devices = devices.stdout.trim().split(/\r?\n/).slice(1).map(line => line.trim());
    }
    if (checkLibraries && target.platform === 'linux' && target.files) {
      for (const name of Object.keys(target.files).filter(name => name.endsWith('.so') || /\.so\.\d+$/.test(name))) {
        const ldd = spawnSync('ldd', [path.join(directory, name)], { encoding: 'utf8', env: { PATH: process.env.PATH } });
        const missing = ldd.stdout.split('\n').filter(line => line.includes('not found')).map(line => line.trim().split(' ')[0]);
        // libcuda.so.1 is the driver; everything else must resolve without LD_LIBRARY_PATH.
        if (ldd.status !== 0 || missing.some(library => library !== 'libcuda.so.1')) throw new Error(`${variant}: ${name} has unresolved libraries: ${missing.join(', ') || ldd.stderr}`);
      }
      result.libraries = 'resolved';
    }
  } else result.execution = `skipped on ${process.platform}-${process.arch}`;
  results.push(result);
}
console.log(JSON.stringify({ resources, build: manifest.build, runtimes: results, result: 'passed' }, null, 2));
