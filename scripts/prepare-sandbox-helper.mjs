// Prepares the Windows Synthesis sandbox resources into resources/sandbox/win32-<arch>:
//   - lc-sandbox.exe, compiled from native/windows-sandbox/LcSandbox.cs with the .NET Framework's own
//     csc (no Visual C++ toolchain), so it builds both in CI and on a developer's Windows machine;
//   - node/, the official Node runtime for the same major the app's server ships (node.exe and
//     node_modules/npm only), verified against nodejs.org's SHASUMS256.
//
//   node scripts/prepare-sandbox-helper.mjs [--arch x64] [--node 22.23.3]
//
// It builds only on Windows (csc is Windows-only); elsewhere it says so and exits without doing anything.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { download } from './lib/download.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const arch = option('--arch', process.arch);
// The same major the server runtime ships (scripts/pack-server.mjs --node default).
const nodeVersion = option('--node', '22.23.3');
// A test build (--test) compiles the test-only commands (the __walk seam); the release build does not, so
// they are not commands in what ships. dist:win and CI never pass --test.
const test = process.argv.includes('--test');

if (process.platform !== 'win32') {
  console.log('The Windows sandbox helper builds only on Windows (it needs the .NET Framework csc). Skipping.');
  process.exit(0);
}
if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported sandbox helper architecture.');

const destination = path.join(root, 'resources', 'sandbox', `win32-${arch}`);
await fs.rm(destination, { recursive: true, force: true });
await fs.mkdir(destination, { recursive: true });

// 1. Compile the helper with the framework's own compiler (C# 5).
const csc = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
await fs.access(csc).catch(() => { throw new Error(`The .NET Framework compiler was not found at ${csc}.`); });
const source = path.join(root, 'native', 'windows-sandbox', 'LcSandbox.cs');
const exe = path.join(destination, 'lc-sandbox.exe');
execFileSync(csc, ['/nologo', '/target:exe', '/optimize+', `/platform:${arch === 'arm64' ? 'arm64' : 'x64'}`, '/unsafe', ...(test ? ['/define:LC_SANDBOX_TEST'] : []), `/out:${exe}`, source], { stdio: 'inherit' });
if (test) console.log('Built with the test-only commands (LC_SANDBOX_TEST).');
console.log(`Compiled ${exe}`);

// 2. The Node runtime it runs inside the sandbox, verified against nodejs.org's published digests.
const nodeName = `node-v${nodeVersion}-win-${arch}`;
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-sandbox-'));
try {
  const zip = path.join(temporary, `${nodeName}.zip`);
  const sums = await (await fetch(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find(line => line.endsWith(`  ${nodeName}.zip`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`nodejs.org lists no ${nodeName}.zip`);
  await download(`https://nodejs.org/dist/v${nodeVersion}/${nodeName}.zip`, zip, `Node ${nodeVersion} for the sandbox`);
  const digest = createHash('sha256').update(await fs.readFile(zip)).digest('hex');
  if (digest !== expected) throw new Error('The Node download does not match nodejs.org\'s SHASUMS256.');
  // Windows' own bsdtar unpacks a zip.
  const systemTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(systemTar, ['-xf', zip, '-C', temporary], { stdio: 'inherit' });
  const unpacked = path.join(temporary, nodeName);
  const nodeDir = path.join(destination, 'node');
  await fs.mkdir(path.join(nodeDir, 'node_modules'), { recursive: true });
  await fs.copyFile(path.join(unpacked, 'node.exe'), path.join(nodeDir, 'node.exe'));
  // npm (and npx) are run as node on their cli scripts; the shims and the rest of the runtime are dropped.
  await fs.cp(path.join(unpacked, 'node_modules', 'npm'), path.join(nodeDir, 'node_modules', 'npm'), { recursive: true });
  await fs.copyFile(path.join(unpacked, 'LICENSE'), path.join(nodeDir, 'LICENSE-node.txt'));
  await fs.writeFile(path.join(destination, 'runtime.json'), JSON.stringify({ node: nodeVersion, arch, platform: 'win32' }, null, 2));
  console.log(`Prepared ${nodeDir} (Node ${nodeVersion})`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
