// Checks the packaged Windows sandbox helper: that it imports only system DLLs, and that the app's own
// platformSandbox() finds it isolating here (reads no file outside its folders, writes only its work
// folder, reaches no port, and ends what a command leaves behind). Run in CI after the Windows package
// is built, from the repository checkout (its dist/ holds the compiled app code).
//
//   node scripts/verify-sandbox-helper.mjs [release/win-unpacked/resources]
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { peImports } from './lib/pe-imports.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.resolve(process.argv[2] ?? path.join(root, 'release', 'win-unpacked', 'resources'));
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const sandboxDir = path.join(resources, 'sandbox', `win32-${arch}`);
const helper = path.join(sandboxDir, 'lc-sandbox.exe');
const node = path.join(sandboxDir, 'node', 'node.exe');
const fail = message => { console.error(message); process.exit(1); };

for (const file of [helper, node]) await fs.access(file).catch(() => fail(`missing ${file}`));

// The helper may import only Windows' own DLLs (and the .NET shim mscoree.dll); a managed assembly
// usually lists none in its classic import table.
const allowed = new Set(['mscoree.dll', 'kernel32.dll', 'kernelbase.dll', 'ntdll.dll', 'user32.dll', 'advapi32.dll', 'userenv.dll', 'ole32.dll', 'oleaut32.dll', 'shell32.dll']);
const stray = (await peImports(helper)).filter(dll => !allowed.has(dll) && !/^(api|ext)-ms-win-/.test(dll));
if (stray.length) fail(`lc-sandbox.exe imports non-system DLLs: ${stray.join(', ')}`);
console.log('PE imports: system DLLs only.');

// Let the sandbox read the helper and its Node, then check the app's own provider reports it isolating.
execFileSync(helper, ['grant-tools', sandboxDir], { stdio: 'inherit', timeout: 30000 });
process.env.LC_SANDBOX_HELPER = helper;
process.env.LC_SANDBOX_NODE = node;
process.env.LC_SANDBOX_ROOTS = os.tmpdir();

const { platformSandbox } = await import(pathToFileURL(path.join(root, 'dist', 'src', 'synthesis', 'checks', 'sandbox.js')).href);
const sandbox = platformSandbox();
if (sandbox.name !== 'appcontainer') fail(`platformSandbox() is ${sandbox.name}, not the Windows AppContainer`);
const reason = await sandbox.unavailable();
if (reason) fail(`the packaged sandbox is not available: ${reason}`);
console.log('The packaged Windows sandbox isolates. OK.');
