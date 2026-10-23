// TEMPORARY CI diagnostic (release/0.1.9 only) for the AppContainer child-spawn EPERM on the GitHub
// Windows runner. Runs node INSIDE the sandbox and has it try cp.spawn with several option sets, reporting
// each error code, plus whether the parent is in a job and its mitigation policy. Remove before release.
//   node scripts/diag-sandbox-spawn.mjs <resources dir>
import { execFileSync, execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.resolve(process.argv[2] ?? path.join(root, 'release', 'win-unpacked', 'resources'));
const sandboxDir = path.join(resources, 'sandbox', 'win32-x64');
const helper = path.join(sandboxDir, 'lc-sandbox.exe');
const node = path.join(sandboxDir, 'node', 'node.exe');
execFileSync(helper, ['grant-tools', sandboxDir], { stdio: 'inherit', timeout: 30000 });
process.env.LC_SANDBOX_HELPER = helper;
process.env.LC_SANDBOX_NODE = node;
process.env.LC_SANDBOX_ROOTS = os.tmpdir();
const { platformSandbox } = await import(pathToFileURL(path.join(root, 'dist', 'src', 'synthesis', 'checks', 'sandbox.js')).href);
const sandbox = platformSandbox();

const code = `
const cp=require('child_process');
const run=(label,opts)=>{try{const r=cp.spawnSync(process.execPath,['-e','process.exit(7)'],opts);console.log('SPAWN '+label+': '+(r.error?('ERR '+r.error.code+' '+(r.error.errno||'')):('status '+r.status)));}catch(e){console.log('SPAWN '+label+': THROW '+e.code);}};
console.log('PARENT_PID '+process.pid);
run('detached_ignore',{detached:true,stdio:'ignore'});
run('plain_ignore',{stdio:'ignore'});
run('plain_inherit',{stdio:'inherit'});
run('plain_pipe',{stdio:'pipe'});
run('windowshide',{windowsHide:true,stdio:'ignore'});
try{const p=process.report?process.report.getReport():null;if(p&&p.header){console.log('DUMPABLE '+(p.header.dumpEventTime?'y':'y'));}}catch(e){}
console.log('DIAG_END');
`;
const work = path.join(os.tmpdir(), `lc-diag-${Date.now()}`);
await import('node:fs').then(fs => fs.mkdirSync(work, { recursive: true }));
const wrapped = sandbox.wrap(node, ['-e', code], work, [path.dirname(node)]);
await new Promise(resolve => execFile(wrapped.executable, wrapped.args, { cwd: work, env: wrapped.env, timeout: 30000 }, (error, stdout, stderr) => {
  console.log('--- sandbox stdout ---'); console.log(String(stdout));
  console.log('--- sandbox stderr ---'); console.log(String(stderr));
  if (error) console.log('--- outer error ---', error.message);
  resolve();
}));
// Clean the diag profile.
const empty = sandbox.empty(work);
await new Promise(resolve => execFile(empty.executable, empty.args, { env: empty.env, timeout: 15000 }, () => resolve()));
await import('node:fs').then(fs => fs.rmSync(work, { recursive: true, force: true }));
