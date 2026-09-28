import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { ProjectStore } from "../src/projects/ProjectStore";
import { SynthesisService } from "../src/synthesis/SynthesisService";
import { emptyModuleTemplate } from "../src/synthesis/templates";

async function fixture(t: TestContext) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lc-modules-")));
  const root = path.join(temp, "project"); await fs.mkdir(root);
  const data = path.join(temp, "data");
  const projects = new ProjectStore(data);
  const project = await projects.create({name: "Modules", rootPath: root});
  const unexpected = async (): Promise<never> => { throw new Error("Module authoring must not call a model"); };
  const service = new SynthesisService(data, {projects, models: {listAllModels: unexpected}, loadModel: unexpected, llm: {generateObject: unexpected, generateText: unexpected}});
  await service.init();
  t.after(async () => { await service.dispose(); await fs.rm(temp, {recursive: true, force: true}); });
  const authored = async (folder: string, name: string, only?: "spec" | "flow") => {
    const sources = emptyModuleTemplate(name);
    await fs.mkdir(path.join(root, folder), {recursive: true});
    if (only !== "flow") await fs.writeFile(path.join(root, folder, `${name}.lcspec`), sources.spec);
    if (only !== "spec") await fs.writeFile(path.join(root, folder, `${name}.lcflow`), sources.flow);
  };
  return {temp, root, service, project, authored};
}

test("Refresh discovers externally authored pairs at the root and in nested folders without copying", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.modules(f.project.id), []);
  await f.authored("", "LandingPage");
  await f.authored("contracts/gameplay", "AbilitySystem");
  const modules = await f.service.modules(f.project.id);
  assert.deepEqual(modules.map(item => item.id), ["file:LandingPage", "file:contracts/gameplay/AbilitySystem"]);
  assert.ok(modules.every(item => item.valid));
  assert.equal(await f.service.editorPath(f.project.id, "file:LandingPage"), f.root);
  assert.equal(await f.service.editorPath(f.project.id, modules[1].id, "flow"), path.join(f.root, "contracts/gameplay/AbilitySystem.lcflow"));
  assert.deepEqual(await fs.readdir(f.root), ["LandingPage.lcflow", "LandingPage.lcspec", "contracts"]);
});

test("legacy module identity and history stay intact while duplicate names are distinguished by path", async t => {
  const f = await fixture(t);
  const legacy = await f.service.createModule(f.project.id, "Calculator", {template: "empty"});
  const started = await f.service.start(f.project.id, legacy.id);
  assert.equal((await f.service.wait(started.id)).status, "unresolved");
  await f.authored("examples/demo", "Calculator");
  const modules = await f.service.modules(f.project.id);
  assert.deepEqual(modules.map(item => item.id), ["Calculator", "file:examples/demo/Calculator"]);
  assert.ok(modules.every(item => item.name === "Calculator"));
  assert.equal((await f.service.list(f.project.id))[0].moduleId, "Calculator");
  const nested = await f.service.start(f.project.id, modules[1].id);
  const result = await f.service.wait(nested.id);
  assert.equal(result.status, "unresolved");
  assert.ok(result.events.some(event => event.file === "examples/demo/Calculator.lcflow"));
});

test("New module creates the chosen template in a chosen folder and never overwrites a collision", async t => {
  const f = await fixture(t);
  const created = await f.service.createModule(f.project.id, "AbilitySystem", {template: "empty", directory: "contracts/gameplay"});
  assert.equal(created.specPath, "contracts/gameplay/AbilitySystem/AbilitySystem.lcspec");
  assert.equal(created.valid, true);
  assert.doesNotMatch(created.specSource!, /calculator|JavaScript/);
  assert.match(created.flowSource!, /return unresolved/);
  assert.equal((await f.service.modules(f.project.id))[0].id, created.id);
  await assert.rejects(f.service.createModule(f.project.id, "AbilitySystem", {template: "calculator", directory: "contracts/gameplay"}), /already exists.*contracts\/gameplay/);
  assert.equal(await fs.readFile(path.join(f.root, created.specPath), "utf8"), created.specSource);
  const another = await f.service.createModule(f.project.id, "AnotherCalculator", {template: "calculator", directory: ""});
  assert.equal(another.specPath, "AnotherCalculator/AnotherCalculator.lcspec");
  assert.match(another.flowSource!, /checkout\("generated\/AnotherCalculator"\)/);
});

test("incomplete pairs and mismatched declarations remain visible with actionable diagnostics", async t => {
  const f = await fixture(t);
  await f.authored("contracts", "MissingFlow", "spec");
  await f.authored("contracts", "MissingSpec", "flow");
  const first = await f.service.modules(f.project.id);
  assert.equal(first.length, 2);
  assert.ok(first.every(item => !item.valid && item.diagnostics.some(d => d.code === "SOURCE_READ")));
  await f.authored("contracts", "MissingFlow");
  assert.equal((await f.service.module(f.project.id, "file:contracts/MissingFlow")).valid, true);
  await fs.writeFile(path.join(f.root, "contracts/MissingFlow.lcspec"), emptyModuleTemplate("WrongName").spec);
  assert.ok((await f.service.module(f.project.id, "file:contracts/MissingFlow")).diagnostics.some(d => d.code === "MODULE_NAME"));
});

test("folder browsing and discovery exclude hidden, dependency, build and symlink folders", async t => {
  const f = await fixture(t);
  for (const folder of [".private", "node_modules", "dist", "contracts"]) await f.authored(folder, "Example");
  const outside = path.join(f.temp, "outside"); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.root, "linked"), "dir");
  assert.deepEqual((await f.service.folders(f.project.id)).folders, ["contracts"]);
  assert.deepEqual((await f.service.modules(f.project.id)).map(item => item.id), ["file:contracts/Example"]);
  await assert.rejects(f.service.folders(f.project.id, "linked"), /Symbolic links/);
  await assert.rejects(f.service.createModule(f.project.id, "Outside", {directory: "linked"}), /Symbolic links/);
  await assert.rejects(f.service.createModule(f.project.id, "Outside", {directory: "../outside"}), /relative path/);
  await assert.rejects(f.service.createModule(f.project.id, "Outside", {directory: "dist"}), /excluded/);
  await assert.rejects(f.service.module(f.project.id, "file:../outside/Example"), /relative path/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("concurrent creation resolves one winner without overwriting or mixed templates", async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.service.createModule(f.project.id, "Example", {template: "empty"}),
    f.service.createModule(f.project.id, "Example", {template: "calculator"})
  ]);
  const winners = results.filter(result => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  const module = await f.service.module(f.project.id, "Example");
  assert.equal(module.valid, true);
  assert.equal(module.specSource, winners[0].value.specSource);
  assert.equal(module.flowSource, winners[0].value.flowSource);
});
