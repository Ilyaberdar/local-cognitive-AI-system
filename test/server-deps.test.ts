import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseServerArgs } from "../src/server/args";
import { ControlServer } from "../src/server/ControlServer";
import { controlSocketPathFor, dataDirectories } from "../src/server/dataRoot";
import { Logger } from "../src/utils/Logger";

const cli = path.resolve(__dirname, "..", "src", "server", "cli.js");
const run = promisify(execFile);
const npmHere = [path.join(path.dirname(process.execPath), "npm"), ...(process.env.PATH ?? "").split(path.delimiter).map(dir => path.join(dir, "npm"))].some(file => fs.existsSync(file));

test("deps names a project, and runs install scripts only when asked", () => {
  assert.deepEqual(parseServerArgs(["deps", "My", "app", "--data-dir", "/srv/lc"], {}).deps, { project: "My app", scripts: false });
  assert.deepEqual(parseServerArgs(["deps", "/srv/lc/projects/app", "--scripts", "--data-dir", "/srv/lc"], {}).deps, { project: "/srv/lc/projects/app", scripts: true });
  assert.throws(() => parseServerArgs(["deps", "--data-dir", "/srv/lc"], {}), /deps <project>/);
});

test("deps installs a project's dependencies with npm ci, without install scripts unless asked and without the server's keys", { skip: process.platform === "win32" || !npmHere, timeout: 120_000 }, async t => {
  // A short path: macOS limits socket paths to 103 bytes.
  const base = fs.realpathSync(fs.mkdtempSync("/tmp/lcd-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "d");
  fs.mkdirSync(path.join(root, "app", "runtime"), { recursive: true });
  const project = (name: string, files: Record<string, string>) => {
    const folder = path.join(base, name); fs.mkdirSync(folder);
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(folder, file), content);
    return folder;
  };
  // A root lifecycle script shows whether install scripts ran, and with which environment.
  const manifest = JSON.stringify({ name: "app", version: "1.0.0", private: true, scripts: { install: "node -e \"require('fs').writeFileSync('ran.txt', String(process.env.DEEPSEEK_API_KEY))\"" } });
  const lock = JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "app", version: "1.0.0" } } });
  const app = project("app", { "package.json": manifest, "package-lock.json": lock });
  const nolock = project("nolock", { "package.json": manifest });
  const empty = project("empty", {});
  const views = [["11111111-1111-4111-8111-111111111111", "App", app], ["22222222-2222-4222-8222-222222222222", "No lock", nolock], ["33333333-3333-4333-8333-333333333333", "Empty", empty]]
    .map(([id, name, rootPath]) => ({ id, name, rootPath, origin: "device", archived: false, allowed: false }));
  const server = await ControlServer.listen(controlSocketPathFor(dataDirectories(root).app), { status: () => ({}), drain: async () => ({ drained: true, remaining: 0, elapsedMs: 0 }),
    cloudModels: async () => ({ projects: views }) }, new Logger());
  t.after(() => server.close());
  const env = { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`, HOME: base, DEEPSEEK_API_KEY: "sk-server-secret-key" };

  const installed = await run(process.execPath, [cli, "deps", "App", "--data-dir", root], { env });
  assert.match(installed.stdout, /npm ci --no-audit --no-fund --ignore-scripts \(install scripts are not run/);
  assert.match(installed.stdout, /Dependencies of App .* installed/);
  assert.equal(fs.existsSync(path.join(app, "ran.txt")), false, "no install script ran");
  assert.ok(fs.existsSync(path.join(root, "cache", "npm")), "npm's cache is the server's own, outside backups");

  await run(process.execPath, [cli, "deps", app, "--scripts", "--data-dir", root], { env });
  assert.equal(fs.readFileSync(path.join(app, "ran.txt"), "utf8"), "undefined", "with --scripts they run, without the server's keys");

  for (const [name, pattern] of [["No lock", /no package-lock\.json/], ["Empty", /no package\.json/], ["Nobody", /No project on this server/]] as const) {
    await assert.rejects(run(process.execPath, [cli, "deps", name, "--data-dir", root], { env }), (error: { code?: number; stderr?: string }) => error.code === 1 && pattern.test(error.stderr ?? ""), name);
  }
});
