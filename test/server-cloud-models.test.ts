import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { promisify } from "node:util";
import { ProjectStore } from "../src/projects/ProjectStore";
import { parseServerArgs } from "../src/server/args";
import { createCloudModelsControl, findProject } from "../src/server/cloudModels";
import { ControlServer, controlRequest } from "../src/server/ControlServer";
import { controlSocketPathFor, dataDirectories } from "../src/server/dataRoot";
import type { Project } from "../src/projects/types";
import { SynthesisService } from "../src/synthesis/SynthesisService";
import { Logger } from "../src/utils/Logger";

const cli = path.resolve(__dirname, "..", "src", "server", "cli.js");
const run = promisify(execFile);

async function fixture(t: TestContext) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lc-cloud-")));
  const data = path.join(temp, "data");
  const projects = new ProjectStore(data);
  const folder = (name: string) => { const dir = path.join(temp, name); fs.mkdirSync(dir); return dir; };
  const unexpected = async (): Promise<never> => { throw new Error("No model is called"); };
  const synthesis = new SynthesisService(data, {projects, models: {listAllModels: unexpected}, loadModel: unexpected, llm: {generateObject: unexpected, generateText: unexpected}});
  await synthesis.init();
  t.after(async () => { await synthesis.dispose(); fs.rmSync(temp, {recursive: true, force: true}); });
  const logged: unknown[] = [];
  const control = createCloudModelsControl({ projects: () => projects, synthesis: () => synthesis, logger: { info: (...args: unknown[]) => { logged.push(args); } } as never });
  return {temp, projects, synthesis, folder, control, logged};
}

test("cloud-models: list by default, allow or deny a project named with spaces; nothing else", () => {
  const parse = (...args: string[]) => parseServerArgs(["cloud-models", ...args, "--data-dir", "/srv/lc"], {}).cloudModels;
  assert.deepEqual(parse(), {action: "list"});
  assert.deepEqual(parse("list"), {action: "list"});
  assert.deepEqual(parse("allow", "Rate", "limiter"), {action: "allow", project: "Rate limiter"});
  assert.deepEqual(parse("deny", "/srv/lc/projects/review"), {action: "deny", project: "/srv/lc/projects/review"});
  assert.throws(() => parse("allow"), /cloud-models allow <project>/);
  assert.throws(() => parse("enable", "x"), /cloud-models allow <project>/);
  assert.throws(() => parse("list", "x"), /cloud-models allow <project>/);
  assert.throws(() => parseServerArgs(["cloud-models"], {}), /--data-dir/);
});

test("a project is found by its id, its name or its folder, never by a guess", { skip: process.platform === "win32" && "the server runs on Linux; its folders are POSIX paths" }, t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lc-find-")));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  fs.mkdirSync(path.join(temp, "a")); fs.symlinkSync(path.join(temp, "a"), path.join(temp, "link"));
  const project = (id: string, name: string, rootPath: string): Project => ({id, name, rootPath, createdAt: "", updatedAt: ""});
  const list = [project("11111111-1111-4111-8111-111111111111", "Review", path.join(temp, "a")), project("22222222-2222-4222-8222-222222222222", "Twin", "/srv/b"),
    project("33333333-3333-4333-8333-333333333333", "Twin", "/srv/c"), project("44444444-4444-4444-8444-444444444444", "review", "/srv/d")];
  assert.equal(findProject(list, "22222222-2222-4222-8222-222222222222").rootPath, "/srv/b");
  assert.equal(findProject(list, `${path.join(temp, "a")}/`).id, list[0]!.id, "a folder with a trailing slash");
  // Names and folders come from computers: none is preferred to another that looks like it.
  assert.throws(() => findProject(list, "Review"), (error: {code?: string}) => error.code === "ambiguous", "an exact name is not preferred to one in another case");
  assert.throws(() => findProject(list, "REVIEW"), (error: {code?: string}) => error.code === "ambiguous");
  assert.throws(() => findProject(list, path.join(temp, "link")), (error: Error & {code?: string}) => error.code === "ambiguous" && /leads to/.test(error.message), "a folder through a link");
  assert.equal(findProject(list.slice(0, 3), "REVIEW").id, list[0]!.id, "a name in another case, when only one project has it");
  // Each form names one thing: a project named like a folder or an id is not reached by that text.
  const posing = [...list, project("55555555-5555-4555-8555-555555555555", "/srv/b", "/srv/e"), project("66666666-6666-4666-8666-666666666666", "11111111-1111-4111-8111-111111111111", "/srv/f")];
  assert.equal(findProject(posing, "/srv/b").id, list[1]!.id, "an absolute path is a folder, never a name");
  assert.equal(findProject(posing, "11111111-1111-4111-8111-111111111111").id, list[0]!.id, "an id is an id, never a name");
  assert.equal(findProject(posing, "11111111-1111-4111-8111-111111111111".toUpperCase()).id, list[0]!.id);
  assert.throws(() => findProject(posing, "99999999-9999-4999-8999-999999999999"), (error: {code?: string}) => error.code === "project_unknown");
  assert.throws(() => findProject(posing, "/srv/nothing"), (error: {code?: string}) => error.code === "project_unknown");
  assert.throws(() => findProject(list, "Twin"), (error: Error & {code?: string}) => error.code === "ambiguous" && /\/srv\/b/.test(error.message) && /\/srv\/c/.test(error.message));
  assert.throws(() => findProject(list, "a"), (error: {code?: string}) => error.code === "project_unknown", "a relative path is a name, not a folder");
  assert.throws(() => findProject(list, "Nothing"), (error: {code?: string}) => error.code === "project_unknown");
});

test("allow and deny are saved for the running server; an archived project can only be denied", async t => {
  const f = await fixture(t);
  const review = await f.projects.create({name: "Review", rootPath: f.folder("review"), origin: "device"});
  const old = await f.projects.create({name: "Old", rootPath: f.folder("old")});
  assert.deepEqual((await f.control({})).projects.map(item => [item.name, item.origin, item.allowed]).sort(), [["Old", "host", false], ["Review", "device", false]]);
  const allowed = await f.control({project: "Review", allowed: true});
  assert.deepEqual(allowed.changed && [allowed.changed.id, allowed.changed.allowed], [review.id, true]);
  assert.deepEqual(await f.synthesis.cloudModels(review.id), {allowed: true}, "the Synthesis service sees it at once");
  assert.equal(f.logged.length, 1);
  await f.projects.update(old.id, {cloudModels: true});
  await f.projects.update(old.id, {archived: true});
  await assert.rejects(f.control({project: old.id, allowed: true}), (error: {code?: string}) => error.code === "unsupported");
  const denied = await f.control({project: old.id, allowed: false});
  assert.equal(denied.changed?.allowed, false, "consent is withdrawn from an archived project too");
  await f.projects.update(old.id, {archived: false});
  assert.deepEqual(await f.synthesis.cloudModels(old.id), {allowed: false}, "restoring it brings no cloud models back");
  assert.deepEqual((await f.control({project: review.id, allowed: false})).changed?.allowed, false);
  await assert.rejects(f.control({project: "Missing", allowed: false}), (error: {code?: string}) => error.code === "project_unknown");
});

test("the control socket checks the request; the CLI prints names safely and says when the server is not running", { skip: process.platform === "win32", timeout: 30_000 }, async t => {
  // A short path: macOS limits socket paths to 103 bytes.
  const base = fs.mkdtempSync("/tmp/lcm-");
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, "d");
  fs.mkdirSync(path.join(root, "app", "runtime"), {recursive: true});
  const socket = controlSocketPathFor(dataDirectories(root).app);
  const evil = "Mallory\u001b]52;c;cm0gLXJmIC8=\u0007\u001b[2J";
  const requests: unknown[] = [];
  const view = {id: "11111111-1111-4111-8111-111111111111", name: evil, rootPath: `/srv/${evil}`, origin: "device", archived: false, allowed: true};
  const server = await ControlServer.listen(socket, {status: () => ({}), drain: async () => ({drained: true, remaining: 0, elapsedMs: 0}),
    cloudModels: async request => {
      requests.push(request);
      if (request.project === "Missing") throw Object.assign(new Error("No project on this server has that id, name or folder."), {code: "project_unknown"});
      return {projects: [view], ...(request.project ? {changed: view} : {})};
    }}, new Logger());
  t.after(() => server.close());

  assert.deepEqual(await controlRequest(socket, {op: "cloud-models", project: "Review"}), {v: 1, ok: false, error: {code: "bad_request", message: "Say whether cloud models are allowed."}});
  assert.equal((await controlRequest(socket, {op: "cloud-models", project: "", allowed: true})).ok, false);
  assert.equal(requests.length, 0, "nothing invalid reaches the server");

  const env = {PATH: process.env.PATH ?? "", HOME: base};
  const listed = await run(process.execPath, [cli, "cloud-models", "--data-dir", root], {env});
  assert.match(listed.stdout, /^allowed {5}Mallory�\]52;c;cm0gLXJmIC8=��\[2J {2}11111111-1111-4111-8111-111111111111 {2}\/srv\/Mallory/m);
  assert.equal(listed.stdout.includes("\u001b"), false, "a name from a computer never reaches the terminal as escape codes");
  const allowed = await run(process.execPath, [cli, "cloud-models", "allow", "My", "review", "--data-dir", root], {env});
  assert.match(allowed.stdout, /^Cloud models allowed for Mallory.* \(11111111-1111-4111-8111-111111111111, \/srv\/Mallory.*, made from a computer\)\. .*hidden tests stay on this server\.$/m);
  assert.equal(allowed.stdout.includes("\u001b"), false);
  assert.deepEqual(requests, [{}, {project: "My review", allowed: true}]);
  const json = await run(process.execPath, [cli, "cloud-models", "--json", "--data-dir", root], {env});
  assert.equal(JSON.parse(json.stdout).projects[0].id, view.id);
  await assert.rejects(run(process.execPath, [cli, "cloud-models", "deny", "Missing", "--data-dir", root], {env}),
    (error: {code?: number; stderr?: string}) => error.code === 1 && /No project on this server/.test(error.stderr ?? ""));
  await server.close();
  await assert.rejects(run(process.execPath, [cli, "cloud-models", "--data-dir", root], {env}),
    (error: {code?: number; stderr?: string}) => error.code === 69 && /The server is not running/.test(error.stderr ?? ""));
});
