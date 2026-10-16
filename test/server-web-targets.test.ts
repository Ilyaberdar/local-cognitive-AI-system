import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { promisify } from "node:util";
import { ProjectStore } from "../src/projects/ProjectStore";
import { parseServerArgs } from "../src/server/args";
import { createWebTargetsControl } from "../src/server/webTargets";
import { ControlServer, controlRequest } from "../src/server/ControlServer";
import { controlSocketPathFor, dataDirectories } from "../src/server/dataRoot";
import { SynthesisService } from "../src/synthesis/SynthesisService";
import { Logger } from "../src/utils/Logger";

const cli = path.resolve(__dirname, "..", "src", "server", "cli.js");
const run = promisify(execFile);

async function fixture(t: TestContext) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lc-web-")));
  const data = path.join(temp, "data");
  const projects = new ProjectStore(data);
  const folder = (name: string) => { const dir = path.join(temp, name); fs.mkdirSync(dir); return dir; };
  const unexpected = async (): Promise<never> => { throw new Error("No model is called"); };
  const synthesis = new SynthesisService(data, {projects, models: {listAllModels: unexpected}, loadModel: unexpected, llm: {generateObject: unexpected, generateText: unexpected}});
  await synthesis.init();
  t.after(async () => { await synthesis.dispose(); fs.rmSync(temp, {recursive: true, force: true}); });
  const logged: unknown[] = [];
  const control = createWebTargetsControl({ projects: () => projects, synthesis: () => synthesis, logger: { info: (...args: unknown[]) => { logged.push(args); } } as never });
  return {temp, projects, synthesis, folder, control, logged};
}

test("web-targets: list by default, allow a project with urls, deny; nothing else", () => {
  const parse = (...args: string[]) => parseServerArgs(["web-targets", ...args, "--data-dir", "/srv/lc"], {}).webTargets;
  assert.deepEqual(parse(), {action: "list"});
  assert.deepEqual(parse("allow", "review", "https://staging.example.com", "https://api.example.com/v1"),
    {action: "allow", project: "review", targets: ["https://staging.example.com", "https://api.example.com/v1"]});
  assert.deepEqual(parse("deny", "/srv/lc/projects/review"), {action: "deny", project: "/srv/lc/projects/review"});
  assert.throws(() => parse("allow", "review"), /web-targets allow <project> <url>/);
  assert.throws(() => parse("allow"), /web-targets allow <project> <url>/);
  assert.throws(() => parse("list", "x"), /web-targets allow <project> <url>/);
  assert.throws(() => parseServerArgs(["web-targets"], {}), /--data-dir/);
});

test("allow stores a normalized, deduped list for the running server; deny clears it; bad targets and an archived project are refused", async t => {
  const f = await fixture(t);
  const review = await f.projects.create({name: "Review", rootPath: f.folder("review"), origin: "device"});
  assert.deepEqual((await f.control({})).projects.map(item => [item.name, item.targets]), [["Review", []]]);
  const allowed = await f.control({project: "Review", targets: ["https://API.Example.com:443/v1/", "https://api.example.com/v1", "https://staging.example.com"]});
  assert.deepEqual(allowed.changed?.targets, ["https://api.example.com/v1", "https://staging.example.com"], "normalized and deduped");
  assert.deepEqual((await f.synthesis.webTargets(review.id)).targets, ["https://api.example.com/v1", "https://staging.example.com"], "the Synthesis service sees it at once");
  assert.equal(f.logged.length, 1);
  await assert.rejects(f.control({project: "Review", targets: ["https://user:pass@x.com"]}), (error: {code?: string}) => error.code === "unsupported");
  await assert.rejects(f.control({project: "Review", targets: ["ftp://example.com"]}), (error: {code?: string}) => error.code === "unsupported");
  const denied = await f.control({project: review.id, targets: []});
  assert.deepEqual(denied.changed?.targets, []);
  assert.deepEqual((await f.synthesis.webTargets(review.id)).targets, []);
  await f.projects.update(review.id, {archived: true});
  await assert.rejects(f.control({project: review.id, targets: ["https://staging.example.com"]}), (error: {code?: string}) => error.code === "unsupported");
  await assert.rejects(f.control({project: "Missing", targets: []}), (error: {code?: string}) => error.code === "project_unknown");
});

test("the control socket checks the request and the CLI prints targets safely", { skip: process.platform === "win32", timeout: 30_000 }, async t => {
  const base = fs.mkdtempSync("/tmp/lcw-");
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, "d");
  fs.mkdirSync(path.join(root, "app", "runtime"), {recursive: true});
  const socket = controlSocketPathFor(dataDirectories(root).app);
  const evil = "Mallory\u001b]52;c;cm0gLXJmIC8=\u0007";
  const requests: unknown[] = [];
  const view = {id: "11111111-1111-4111-8111-111111111111", name: evil, rootPath: `/srv/${evil}`, origin: "device", archived: false, targets: ["https://staging.example.com"]};
  const server = await ControlServer.listen(socket, {status: () => ({}), drain: async () => ({drained: true, remaining: 0, elapsedMs: 0}),
    webTargets: async request => { requests.push(request);
      if (request.project === "Missing") throw Object.assign(new Error("No project on this server has that id, name or folder."), {code: "project_unknown"});
      return {projects: [view], ...(request.project ? {changed: view} : {})}; }}, new Logger());
  t.after(() => server.close());

  // Too many targets, or a non-string, are refused before they reach the server.
  assert.equal((await controlRequest(socket, {op: "web-targets", project: "Review", targets: Array(21).fill("https://x.com")})).ok, false);
  assert.equal((await controlRequest(socket, {op: "web-targets", project: "", targets: []})).ok, false);
  assert.equal(requests.length, 0, "nothing invalid reaches the server");

  const env = {PATH: process.env.PATH ?? "", HOME: base};
  const listed = await run(process.execPath, [cli, "web-targets", "--data-dir", root], {env});
  assert.equal(listed.stdout.includes("\u001b"), false, "a name from a computer never reaches the terminal as escape codes");
  assert.match(listed.stdout, /https:\/\/staging\.example\.com/);
  const allowed = await run(process.execPath, [cli, "web-targets", "allow", "Review", "https://staging.example.com", "--data-dir", root], {env});
  assert.match(allowed.stdout, /may reach: https:\/\/staging\.example\.com/);
  assert.equal(allowed.stdout.includes("\u001b"), false);
  assert.deepEqual(requests, [{}, {project: "Review", targets: ["https://staging.example.com"]}], "the project is one token; the rest are urls");
  await assert.rejects(run(process.execPath, [cli, "web-targets", "deny", "Missing", "--data-dir", root], {env}),
    (error: {code?: number; stderr?: string}) => error.code === 1 && /No project on this server/.test(error.stderr ?? ""));
});
