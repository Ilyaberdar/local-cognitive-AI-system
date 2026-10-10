import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { download } from './lib/download.mjs';
import { normalizeManifest, overlayMayContain, runtimeEntry, sha256File } from './lib/llama-manifest.mjs';

// Usage: node scripts/prepare-llama-runtime.mjs [--platform p --arch a | --variant id] [--manifest file]
//   [--archive base.(zip|tar.gz)] [--overlay overlay.(zip|tar.gz)] [--destination dir]
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

// Windows' own bsdtar unpacks zip and tar.gz alike; elsewhere zip goes through unzip.
const systemTar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
// Upstream's Windows builds need Microsoft's C++ runtime, which a clean Windows lacks: these go next to
// them (app-local, as Microsoft allows), taken from the Windows build machine. b10809 is linked with
// MSVC 14.51, so the runtime must be at least that.
const VC_RUNTIME = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
const VC_RUNTIME_MINIMUM = [14, 51];
const CUDA_NOTICE = 'This folder includes NVIDIA CUDA Runtime and cuBLAS libraries, redistributed unmodified under the NVIDIA CUDA Toolkit End User License Agreement:\nhttps://docs.nvidia.com/cuda/eula/\n';

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

/** Unpacks an archive after checking every name in it: nothing may land outside `into`. */
const unpack = (file, kind, into) => {
  const posixZip = kind === 'zip' && process.platform !== 'win32';
  const listing = posixZip ? execFileSync('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: 16 << 20 })
    : execFileSync(systemTar, ['-tf', file], { encoding: 'utf8', maxBuffer: 16 << 20 });
  for (const name of listing.split(/\r?\n/).filter(Boolean)) {
    if (name.includes('\\') || /^[A-Za-z]:/.test(name) || path.posix.isAbsolute(name) || name.split('/').includes('..')) throw new Error(`The archive contains an unsafe path ${name}.`);
  }
  if (posixZip) execFileSync('unzip', ['-q', file, '-d', into]);
  else execFileSync(systemTar, ['-xf', file, '-C', into]);
};

/** The file version of a Windows DLL, read by Windows itself. */
const fileVersion = (file) => execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Item -LiteralPath $env:LLAMA_DLL).VersionInfo.FileVersion'],
  { encoding: 'utf8', env: { ...process.env, LLAMA_DLL: file } }).trim();

/** The environment for running the runtime: nothing inherited may change its devices or arguments. */
const runtimeEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(GGML_|LLAMA_ARG_|MTMD_)/.test(name) && !['VK_INSTANCE_LAYERS', 'VK_LOADER_LAYERS_ENABLE', 'VK_LAYER_PATH', 'VK_ADD_LAYER_PATH'].includes(name)));

/** Why a Windows runtime exited, when Windows says so with a status code. */
const windowsExit = (status) => ({ 3221225781: 'a DLL it needs is missing (the Microsoft Visual C++ runtime?)', 3221225785: 'a DLL it loaded is the wrong version',
  3221225501: 'this processor lacks an instruction it uses', 3236495362: 'Smart App Control or a code integrity policy blocked it' })[status];

try {
  const archive = value('--archive', path.join(temporary, `runtime.${target.kind}`));
  if (!process.argv.includes('--archive')) await download(target.url, archive, `llama.cpp ${manifest.build} for ${variant}`);
  if (await sha256File(archive) !== target.sha256) throw new Error('Runtime archive SHA-256 mismatch.');
  const extracted = path.join(temporary, 'extracted');
  await fs.mkdir(extracted);
  unpack(archive, target.kind, extracted);
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
    const overlay = value('--overlay', path.join(temporary, `overlay.${target.overlay.kind}`));
    if (!process.argv.includes('--overlay')) await download(target.overlay.url, overlay, `the ${variant} overlay`);
    if (await sha256File(overlay) !== target.overlay.sha256) throw new Error('Overlay archive SHA-256 mismatch.');
    overlayDirectory = path.join(temporary, 'overlay');
    await fs.mkdir(overlayDirectory);
    unpack(overlay, target.overlay.kind, overlayDirectory);
    overlayFiles = await walk(overlayDirectory);
    // Case-insensitive, as on NTFS and APFS.
    const base = new Set((await fs.readdir(source, { recursive: true })).map(name => name.split(path.sep).join('/').toLowerCase()));
    for (const name of overlayFiles) {
      if (!overlayMayContain(target, name)) throw new Error(`The overlay contains ${name}, which the manifest does not list.`);
      if (base.has(name.toLowerCase())) throw new Error(`The overlay would replace ${name} from the base runtime.`);
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
  // Upstream's archive of NVIDIA's Windows DLLs carries no license: the notice goes in beside them.
  if (target.backend === 'cuda' && !overlayFiles.includes('CUDA_NOTICE.txt')) await fs.writeFile(path.join(partial, 'CUDA_NOTICE.txt'), CUDA_NOTICE);
  let vcRuntime;
  if (target.platform === 'win32') {
    if (process.platform !== 'win32') console.warn(`The Microsoft Visual C++ runtime is not bundled: prepare ${variant} on Windows for a release.`);
    else {
      const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      const version = fileVersion(path.join(system32, 'vcruntime140.dll'));
      const [major, minor] = version.split('.').map(Number);
      if (major < VC_RUNTIME_MINIMUM[0] || (major === VC_RUNTIME_MINIMUM[0] && minor < VC_RUNTIME_MINIMUM[1])) throw new Error(`This machine's Visual C++ runtime ${version} is older than ${VC_RUNTIME_MINIMUM.join('.')}.`);
      vcRuntime = { version, files: {} };
      for (const name of VC_RUNTIME) {
        await fs.copyFile(path.join(system32, name), path.join(partial, name));
        vcRuntime.files[name] = await sha256File(path.join(partial, name));
      }
    }
  }
  await fs.writeFile(path.join(partial, 'runtime.json'), JSON.stringify({ id: variant, build: manifest.build, commit: manifest.commit, platform: target.platform, arch: target.arch,
    backend: target.backend, sha256: target.sha256, ...(target.overlay ? { overlaySha256: target.overlay.sha256 } : {}), ...(target.requires ? { requires: target.requires } : {}),
    ...(vcRuntime ? { vcRuntime } : {}) }, null, 2));
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(partial, destination);

  if (target.platform === process.platform && target.arch === process.arch) {
    const run = (args) => spawnSync(path.join(destination, target.executable), args, { cwd: destination, encoding: 'utf8', timeout: 60000, env: runtimeEnvironment() });
    const checked = run(['--version']);
    if (checked.error || checked.status !== 0) throw checked.error ?? new Error(windowsExit(checked.status) ? `${target.executable} did not start: ${windowsExit(checked.status)}.` : checked.stderr);
    const version = checked.stdout + checked.stderr;
    if (!version.includes(manifest.build.replace(/^b/, '')) && !version.includes(manifest.version)) throw new Error(`Unexpected runtime version: ${version}`);
    console.log(version.trim());
    // Informational: a build machine without a GPU lists no devices.
    if (target.backend === 'cuda' || target.backend === 'vulkan') console.log(run(['--list-devices']).stdout.trim());
  }
  console.log(`Prepared ${destination}`);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
