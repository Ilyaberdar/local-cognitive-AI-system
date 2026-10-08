import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeManifest, overlayMayContain, runtimeEntry, sha256File } from './lib/llama-manifest.mjs';

// Usage: node scripts/prepare-llama-runtime.mjs [--platform p --arch a | --variant id] [--manifest file]
//   [--archive base.tar.gz] [--overlay overlay.tar.gz] [--destination dir]
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = (flag, fallback) => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback;
const platform = value('--platform', process.platform);
const arch = value('--arch', process.arch);
const manifestFile = path.resolve(value('--manifest', path.join(root, 'resources/llama/runtime-manifest.json')));
const manifest = normalizeManifest(JSON.parse(await fs.readFile(manifestFile, 'utf8')));
const variant = value('--variant', `${platform}-${arch}`);
const target = runtimeEntry(manifest, variant);
const destination = path.resolve(value('--destination', path.join(root, 'resources/llama', variant)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-llama-'));

const download = async (url, file, what) => {
  console.log(`Downloading ${what}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw new Error(`${what} download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
};

/** Files below a directory as relative paths; anything but plain files and directories is refused. */
const walk = async (directory, prefix = '') => {
  const files = [];
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stat = await fs.lstat(path.join(directory, relative));
    if (stat.isDirectory()) files.push(...await walk(directory, relative));
    else if (stat.isFile() && stat.nlink === 1) files.push(relative);
    else throw new Error(`The overlay contains ${relative}, which is not a regular file.`);
  }
  return files;
};

try {
  const archive = value('--archive', path.join(temporary, target.url.endsWith('.zip') ? 'runtime.zip' : 'runtime.tar.gz'));
  if (!process.argv.includes('--archive')) await download(target.url, archive, `llama.cpp ${manifest.build} for ${target.platform}-${target.arch}`);
  if (await sha256File(archive) !== target.sha256) throw new Error('Runtime archive SHA-256 mismatch.');
  const extracted = path.join(temporary, 'extracted');
  await fs.mkdir(extracted);
  if (target.url.endsWith('.zip')) {
    if (process.platform === 'win32') {
      // Literal arguments are conveyed through environment variables, never interpolated into PowerShell.
      execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:LLAMA_ARCHIVE -DestinationPath $env:LLAMA_EXTRACT'], {
        env: { ...process.env, LLAMA_ARCHIVE: archive, LLAMA_EXTRACT: extracted }, stdio: 'inherit'
      });
    } else execFileSync('unzip', ['-q', archive, '-d', extracted]);
  } else execFileSync('tar', ['-xzf', archive, '-C', extracted]);
  const locate = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.some(entry => entry.name === target.executable)) return directory;
    for (const entry of entries) if (entry.isDirectory()) {
      const found = await locate(path.join(directory, entry.name));
      if (found) return found;
    }
  };
  const source = await locate(extracted);
  if (!source) throw new Error(`Archive does not contain ${target.executable}.`);

  let overlayFiles = [], overlayDirectory;
  if (target.overlay) {
    const overlay = value('--overlay', path.join(temporary, 'overlay.tar.gz'));
    if (!process.argv.includes('--overlay')) await download(target.overlay.url, overlay, `the ${variant} overlay`);
    if (await sha256File(overlay) !== target.overlay.sha256) throw new Error('Overlay archive SHA-256 mismatch.');
    // Names are checked before extraction; the extracted tree is checked again below.
    for (const name of execFileSync('tar', ['-tzf', overlay], { encoding: 'utf8', maxBuffer: 1 << 20 }).split('\n').filter(Boolean)) {
      if (path.posix.isAbsolute(name) || name.split('/').includes('..')) throw new Error(`The overlay contains an unsafe path ${name}.`);
    }
    overlayDirectory = path.join(temporary, 'overlay');
    await fs.mkdir(overlayDirectory);
    execFileSync('tar', ['-xzf', overlay, '-C', overlayDirectory]);
    overlayFiles = await walk(overlayDirectory);
    const base = new Set((await fs.readdir(source, { recursive: true })).map(name => name.split(path.sep).join('/')));
    for (const name of overlayFiles) {
      if (!overlayMayContain(target, name)) throw new Error(`The overlay contains ${name}, which the manifest does not list.`);
      if (base.has(name)) throw new Error(`The overlay would replace ${name} from the base runtime.`);
    }
    for (const [name, digest] of Object.entries(target.files)) {
      if (!overlayFiles.includes(name)) throw new Error(`The overlay is missing ${name}.`);
      if (await sha256File(path.join(overlayDirectory, name)) !== digest) throw new Error(`${name} SHA-256 mismatch.`);
    }
    for (const name of target.notices) if (!overlayFiles.includes(name)) throw new Error(`The overlay is missing ${name}.`);
  }

  // Assemble next to the destination, then swap: a failed run leaves the previous runtime in place.
  const existing = await fs.readdir(destination).catch(() => []);
  if (existing.length && !existing.includes('runtime.json')) throw new Error(`${destination} is not empty and is not a prepared runtime; refusing to replace it.`);
  const partial = `${destination}.partial-${process.pid}`;
  await fs.rm(partial, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, partial, { recursive: true, verbatimSymlinks: true });
  for (const name of overlayFiles) {
    await fs.mkdir(path.dirname(path.join(partial, name)), { recursive: true });
    await fs.copyFile(path.join(overlayDirectory, name), path.join(partial, name));
    if (Object.hasOwn(target.files, name)) await fs.chmod(path.join(partial, name), 0o755);
  }
  await fs.writeFile(path.join(partial, 'runtime.json'), JSON.stringify({ id: variant, build: manifest.build, commit: manifest.commit, platform: target.platform, arch: target.arch,
    backend: target.backend, sha256: target.sha256, ...(target.overlay ? { overlaySha256: target.overlay.sha256 } : {}) }, null, 2));
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(partial, destination);

  if (target.platform === process.platform && target.arch === process.arch) {
    const run = (args) => spawnSync(path.join(destination, target.executable), args, { cwd: destination, encoding: 'utf8', timeout: 30000 });
    const checked = run(['--version']);
    if (checked.error || checked.status !== 0) throw checked.error ?? new Error(checked.stderr);
    const version = checked.stdout + checked.stderr;
    if (!version.includes(manifest.build.replace(/^b/, '')) && !version.includes(manifest.version)) throw new Error(`Unexpected runtime version: ${version}`);
    console.log(version.trim());
    // Informational: a build machine without a GPU lists no devices.
    if (target.backend === 'cuda') console.log(run(['--list-devices']).stdout.trim());
  }
  console.log(`Prepared ${destination}`);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
