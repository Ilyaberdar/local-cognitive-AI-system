import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const supplied = process.argv[2];
if (!supplied) throw new Error('Usage: node scripts/verify-speech-runtime.mjs <application.app | resources directory>');
const resources = path.resolve(supplied.endsWith('.app') ? path.join(supplied, 'Contents/Resources') : supplied);
const directory = path.join(resources, 'speech', `${process.platform}-${process.arch}`);
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'runtime.json'), 'utf8'));
await fs.access(path.join(directory, 'LICENSE-whisper.txt'));
const executable = path.join(directory, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 30000 }).trim();
if (!version.includes(manifest.version.replace(/^v/, ''))) throw new Error(`Unexpected speech runtime version: ${version}`);
let minimumMacOS;
if (process.platform === 'darwin') {
  minimumMacOS = execFileSync('otool', ['-l', executable], { encoding: 'utf8' }).match(/\bminos\s+(\S+)/)?.[1];
  if (minimumMacOS !== '13.3') throw new Error(`Unexpected macOS deployment target: ${minimumMacOS}`);
}
console.log(JSON.stringify({ directory, version, minimumMacOS, result: 'passed' }, null, 2));
