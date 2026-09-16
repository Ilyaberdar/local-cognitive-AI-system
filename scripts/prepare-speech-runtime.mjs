import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const arch = option('--arch', process.arch);
const platform = option('--platform', process.platform);
if (platform !== process.platform) throw new Error(`Build the ${platform} speech runtime on ${platform}; cross-platform compilation is not configured.`);
if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported speech runtime architecture.');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'resources/speech/runtime-manifest.json'), 'utf8'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-speech-'));
try {
  const archive = option('--archive', path.join(temporary, 'source.tar.gz'));
  if (!process.argv.includes('--archive')) {
    const response = await fetch(manifest.source, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Source download failed: ${response.status}`);
    await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));
  }
  if (createHash('sha256').update(await fs.readFile(archive)).digest('hex') !== manifest.sha256) throw new Error('Speech source checksum mismatch.');
  execFileSync('tar', ['-xzf', archive, '-C', temporary]);
  const source = path.join(temporary, `whisper.cpp-${manifest.version.slice(1)}`);
  const build = path.join(temporary, 'build');
  const cmake = option('--cmake', 'cmake');
  execFileSync(cmake, ['-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
    '-DGGML_NATIVE=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF',
    ...(process.platform === 'darwin' ? [`-DCMAKE_OSX_ARCHITECTURES=${arch === 'x64' ? 'x86_64' : 'arm64'}`, '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3', '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON'] : []),
    ...(process.platform === 'win32' ? ['-A', arch === 'x64' ? 'x64' : 'ARM64'] : [])], { stdio: 'inherit' });
  execFileSync(cmake, ['--build', build, '--config', 'Release', '--target', 'whisper-cli', '-j', '6'], { stdio: 'inherit' });
  const executable = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const destination = path.join(root, 'resources/speech', `${process.platform}-${arch}`);
  await fs.mkdir(destination, { recursive: true });
  await fs.copyFile(path.join(build, 'bin', ...(process.platform === 'win32' ? ['Release'] : []), executable), path.join(destination, executable));
  if (process.platform !== 'win32') await fs.chmod(path.join(destination, executable), 0o755);
  await fs.copyFile(path.join(source, 'LICENSE'), path.join(destination, 'LICENSE-whisper.txt'));
  await fs.writeFile(path.join(destination, 'runtime.json'), JSON.stringify({ ...manifest, platform: process.platform, arch }, null, 2));
  console.log(`Prepared ${destination}`);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
