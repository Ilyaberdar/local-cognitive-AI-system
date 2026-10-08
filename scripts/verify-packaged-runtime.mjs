import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeManifest, runtimeEntry, sha256File } from './lib/llama-manifest.mjs';

// Usage: node scripts/verify-packaged-runtime.mjs <application.app | resources directory> [--variant id]... [--check-libraries]
const supplied = process.argv[2];
if (!supplied || supplied.startsWith('--')) throw new Error('Usage: node scripts/verify-packaged-runtime.mjs <application.app | resources directory> [--variant id]... [--check-libraries]');
const resources = path.resolve(supplied.endsWith('.app') ? path.join(supplied, 'Contents/Resources') : supplied);
const variants = process.argv.flatMap((argument, index) => argument === '--variant' ? [process.argv[index + 1]] : []);
if (!variants.length) variants.push(`${process.platform}-${process.arch}`);
const manifest = normalizeManifest(JSON.parse(await fs.readFile(path.join(resources, 'llama/runtime-manifest.json'), 'utf8')));
await fs.access(path.join(resources, 'llama/THIRD_PARTY_NOTICES.txt'));
await fs.access(path.join(resources, 'models/recommended.json'));

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
  for (const name of target.notices ?? []) await fs.access(path.join(directory, name));
  // The driver library must come from the host; a bundled stub would hide every GPU.
  const stub = (await fs.readdir(directory)).find(name => /^libcuda\.so/.test(name));
  if (stub) throw new Error(`${variant} must not contain ${stub}`);
  const result = { variant, backend: target.backend, result: 'passed' };
  if (target.platform === process.platform && target.arch === process.arch) {
    const run = (args) => spawnSync(path.join(directory, target.executable), args, { cwd: directory, encoding: 'utf8', timeout: 30000 });
    const checked = run(['--version']);
    if (checked.error || checked.status !== 0) throw checked.error ?? new Error(checked.stderr);
    const output = checked.stdout + checked.stderr;
    if (!output.includes(manifest.version) && !output.includes(manifest.build.replace(/^b/, ''))) throw new Error(`Unexpected binary version: ${output}`);
    result.version = output.trim();
    if (target.backend === 'cuda') {
      const devices = run(['--list-devices']);
      if (devices.status !== 0 || !devices.stdout.startsWith('Available devices:')) throw new Error(`${variant}: --list-devices failed: ${devices.stderr}`);
      result.devices = devices.stdout.trim().split('\n').slice(1).map(line => line.trim());
    }
    if (process.argv.includes('--check-libraries') && target.platform === 'linux' && target.files) {
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
