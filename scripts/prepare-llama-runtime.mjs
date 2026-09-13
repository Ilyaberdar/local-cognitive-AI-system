import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = (flag, fallback) => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback;
const platform = value('--platform', process.platform);
const arch = value('--arch', process.arch);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'resources/llama/runtime-manifest.json'), 'utf8'));
const target = manifest.platforms[`${platform}-${arch}`];
if (!target) throw new Error(`No pinned llama.cpp runtime for ${platform}-${arch}.`);
const destination = path.join(root, 'resources/llama', `${platform}-${arch}`);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-llama-'));
try {
  const archive = value('--archive', path.join(temporary, target.url.endsWith('.zip') ? 'runtime.zip' : 'runtime.tar.gz'));
  if (!process.argv.includes('--archive')) {
    console.log(`Downloading llama.cpp ${manifest.build} for ${platform}-${arch}`);
    const response = await fetch(target.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`Runtime download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  }
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  if (digest.digest('hex') !== target.sha256) throw new Error('Runtime archive SHA-256 mismatch.');
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
  // Replace only this generated runtime directory, after verifying the complete archive.
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true });
  await fs.writeFile(path.join(destination, 'runtime.json'), JSON.stringify({ build: manifest.build, commit: manifest.commit, platform, arch, backend: target.backend, sha256: target.sha256 }, null, 2));
  if (platform === process.platform && arch === process.arch) {
    const checked = spawnSync(path.join(destination, target.executable), ['--version'], { encoding: 'utf8', timeout: 30000 });
    if (checked.error || checked.status !== 0) throw checked.error ?? new Error(checked.stderr);
    const version = checked.stdout + checked.stderr;
    if (!version.includes(manifest.build.replace(/^b/, '')) && !version.includes(manifest.version)) throw new Error(`Unexpected runtime version: ${version}`);
    console.log(version.trim());
  }
  console.log(`Prepared ${destination}`);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
