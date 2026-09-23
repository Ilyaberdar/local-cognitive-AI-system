import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectStore } from "../src/projects/ProjectStore";
import { PROJECT_COLORS } from "../src/projects/types";
import { SessionIndexStore } from "../src/session/SessionIndexStore";
import { WorkspaceResolver } from "../src/workspace/WorkspaceResolver";
import { resolveReviewPath } from "../src/api/workspaceReview";
import { RuntimeManager } from "../src/app/RuntimeManager";
import { createCreateSessionController } from "../src/api/controller";
import { createCreateProjectController, createUpdateProjectController } from "../src/api/projectControllers";
import { Request, Response } from "express";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-projects-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDataDir = path.join(root, "data");
  const firstRoot = path.join(root, "first");
  const secondRoot = path.join(root, "second");
  await Promise.all([fs.mkdir(firstRoot), fs.mkdir(secondRoot)]);
  const projects = new ProjectStore(appDataDir);
  const sessions = new SessionIndexStore(appDataDir);
  const resolver = new WorkspaceResolver({ appDataDir }, projects, sessions);
  return { root, appDataDir, firstRoot, secondRoot, projects, sessions, resolver };
}

test("project store canonicalizes folders, persists archive/restore and refuses duplicate or moved bindings", async t => {
  const f = await fixture(t);
  const project = await f.projects.create({ name: "  First  ", rootPath: f.firstRoot });
  assert.equal(project.name, "First");
  const alias = path.join(f.root, "alias");
  await fs.symlink(f.firstRoot, alias);
  await assert.rejects(f.projects.create({ name: "Duplicate", rootPath: alias }), (error: any) => error.statusCode === 409);
  assert.ok((await f.projects.update(project.id, { archived: true }))?.archivedAt);
  assert.equal((await new ProjectStore(f.appDataDir).get(project.id))?.rootPath, f.firstRoot);
  await f.projects.update(project.id, { name: "Renamed", archived: false });
  assert.equal((await f.projects.get(project.id))?.archivedAt, undefined);
  await assert.rejects(f.projects.update(project.id, { rootPath: f.secondRoot }), (error: any) => error.statusCode === 409);
  await assert.rejects(f.projects.create({ name: "Relative", rootPath: "relative" }), /absolute/);
  await assert.rejects(f.projects.create({ name: "Missing", rootPath: path.join(f.root, "missing") }), /does not exist/);
});

test("session index keeps project bindings during concurrent writes and never resets corrupt data", async t => {
  const f = await fixture(t);
  const sessions = await Promise.all(Array.from({ length: 24 }, (_, index) =>
    (index % 2 ? f.sessions : new SessionIndexStore(f.appDataDir)).create(`Chat ${index}`, "http", "project-one")));
  await Promise.all(sessions.map(session => f.sessions.touch(session.id, { title: `${session.title} updated` })));
  assert.equal((await f.sessions.list()).length, 24);
  assert.ok((await f.sessions.list()).every(session => session.projectId === "project-one"));
  const legacy = await f.sessions.create("Ordinary");
  assert.equal((await f.sessions.get(legacy.id))?.projectId, undefined);
  await fs.writeFile(path.join(f.appDataDir, "sessions.json"), "{broken");
  await assert.rejects(f.sessions.list());
  assert.equal(await fs.readFile(path.join(f.appDataDir, "sessions.json"), "utf8"), "{broken");
  await fs.writeFile(path.join(f.appDataDir, "projects.json"), "{broken");
  await assert.rejects(f.projects.create({ name: "Valid", rootPath: f.firstRoot }));
  assert.equal(await fs.readFile(path.join(f.appDataDir, "projects.json"), "utf8"), "{broken");
});

test("folder colors survive reload and archive/restore, validate before writing, and can return to default", async t => {
  const f = await fixture(t);
  const legacy = await f.projects.create({ name: "Uncolored", rootPath: f.firstRoot });
  assert.equal((await new ProjectStore(f.appDataDir).get(legacy.id))?.color, undefined);
  const project = await f.projects.create({ name: "Colored", rootPath: f.secondRoot, color: "blue" });
  for (const color of PROJECT_COLORS) {
    await f.projects.update(project.id, { color });
    assert.equal((await new ProjectStore(f.appDataDir).get(project.id))?.color, color);
  }
  await f.projects.update(project.id, { archived: true });
  await f.projects.update(project.id, { name: "Restored", archived: false });
  assert.equal((await f.projects.get(project.id))?.color, "purple");
  for (const color of ["pink", "", "#fff", 5, {}, ["blue"]]) {
    await assert.rejects(f.projects.update(project.id, { name: "Must not save", color: color as any }), (error: any) => error.statusCode === 400);
  }
  assert.equal((await f.projects.get(project.id))?.name, "Restored");
  assert.equal((await f.projects.get(project.id))?.color, "purple");
  await f.projects.update(project.id, { color: null });
  const reset = await new ProjectStore(f.appDataDir).get(project.id);
  assert.equal(reset?.color, undefined);
  assert.equal(reset?.rootPath, f.secondRoot);
});

test("workspace snapshots isolate parallel chats/tasks and managed folders survive restarts without silent recreation", async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([
    f.projects.create({ name: "First", rootPath: f.firstRoot }),
    f.projects.create({ name: "Second", rootPath: f.secondRoot })
  ]);
  const [a, b, c] = await Promise.all([
    f.sessions.create("A", "http", first.id), f.sessions.create("B", "http", first.id), f.sessions.create("C", "http", second.id)
  ]);
  const cwd = process.cwd();
  const [wa, wb, wc, wt] = await Promise.all([
    f.resolver.forSession(a.id), f.resolver.forSession(b.id), f.resolver.forSession(c.id), f.resolver.forTask({ id: "task-1" })
  ]);
  assert.equal(wa?.rootPath, f.firstRoot);
  assert.equal(wb?.memoryScope, wa?.memoryScope);
  assert.equal(wc?.rootPath, f.secondRoot);
  assert.notEqual(wc?.memoryScope, wa?.memoryScope);
  assert.equal(process.cwd(), cwd);
  assert.equal(await f.resolver.forSession((await f.sessions.create("Ordinary")).id), undefined);
  await fs.writeFile(path.join(wt.rootPath, "result.txt"), "persisted");
  const restarted = new WorkspaceResolver({ appDataDir: f.appDataDir }, f.projects, f.sessions);
  assert.deepEqual(await restarted.forTask({ id: "task-1" }), wt);
  assert.equal((await restarted.managedWorkspaces.list())[0].taskId, "task-1");
  await assert.rejects(f.resolver.forTask({ id: "../outside" }), /identifier/);
  const escapedTask = path.join(f.appDataDir, "workspaces", "tasks", "escape");
  await fs.symlink(f.secondRoot, escapedTask);
  await assert.rejects(f.resolver.forTask({ id: "escape" }), /outside/);
  await assert.rejects(fs.access(path.join(f.secondRoot, "workspace")));
  await f.projects.update(first.id, { archived: true });
  await assert.rejects(f.resolver.forSession(a.id), /Restore this project/);
  await f.resolver.validate(wa!); // An active snapshot remains valid after archive.
  assert.equal((await f.resolver.forSession(a.id, { allowArchived: true }))?.rootPath, f.firstRoot);
  await fs.rename(wt.rootPath, `${wt.rootPath}-moved`);
  await assert.rejects(restarted.forTask({ id: "task-1" }), /missing or has moved/);
  await assert.rejects(fs.access(wt.rootPath));
});

test("workspace review uses the selected owner even when global directories include other projects", async t => {
  const f = await fixture(t);
  const p = await f.projects.create({ name: "First", rootPath: f.firstRoot });
  const session = await f.sessions.create("A", "http", p.id);
  const own = path.join(f.firstRoot, "own.txt");
  const foreign = path.join(f.secondRoot, "foreign.txt");
  await Promise.all([fs.writeFile(own, "own"), fs.writeFile(foreign, "foreign")]);
  const taskWorkspace = await f.resolver.forTask({ id: "task-2" });
  const taskFile = path.join(taskWorkspace.rootPath, "task.txt");
  await fs.writeFile(taskFile, "task");
  const manager = { getSettings: async () => ({ memory: { localProfileId: "profile" } }), getRuntime: () => ({
    config: { filesystem: { allowedDirectories: [f.root] } }, workspaceResolver: f.resolver,
    memoryService: { recent: async () => [] },
    workflowRunStore: { getRun: async (id: string) => id === "run" ? { id, workspace: taskWorkspace } : null, listNodeRuns: async () => [] }
  }) } as unknown as RuntimeManager;
  assert.equal(await resolveReviewPath(manager, "own.txt", session.id), own);
  await assert.rejects(resolveReviewPath(manager, foreign, session.id), (error: any) => error.statusCode === 403);
  await assert.rejects(resolveReviewPath(manager, own), (error: any) => error.statusCode === 400);
  assert.equal(await resolveReviewPath(manager, taskFile, undefined, "run"), taskFile);
  await assert.rejects(resolveReviewPath(manager, own, undefined, "run"), (error: any) => error.statusCode === 403);
  await assert.rejects(resolveReviewPath(manager, taskFile, undefined, "absent"), (error: any) => error.statusCode === 404);
});

test("project/session API validates project ownership and archive state", async t => {
  const f = await fixture(t);
  const manager = { getSettings: async () => ({}), getRuntime: () => ({ projectStore: f.projects }) } as unknown as RuntimeManager;
  let result: any;
  const response = { status() { return this; }, json(value: unknown) { result = value; } } as unknown as Response;
  const invoke = async (controller: (req: Request, res: Response, next: (error?: any) => void) => Promise<void>, body: unknown, params = {}) =>
    controller({ body, params } as Request, response, error => { if (error) throw error; });
  await assert.rejects(invoke(createCreateProjectController(manager), { name: "Invalid color", rootPath: f.firstRoot, color: "pink" }), (error: any) => error.statusCode === 400);
  assert.equal((await f.projects.list()).length, 0);
  await invoke(createCreateProjectController(manager), { name: "API project", rootPath: f.firstRoot, color: "blue" });
  const projectId = result.id;
  assert.equal(result.color, "blue");
  await invoke(createUpdateProjectController(manager), { color: "green" }, { projectId });
  assert.equal(result.color, "green");
  await assert.rejects(invoke(createUpdateProjectController(manager), { color: { value: "red" } }, { projectId }), (error: any) => error.statusCode === 400);
  await invoke(createUpdateProjectController(manager), { color: null }, { projectId });
  assert.equal(result.color, undefined);
  await invoke(createCreateSessionController(f.sessions, manager), { title: "Project chat", projectId });
  assert.equal(result.projectId, projectId);
  await invoke(createUpdateProjectController(manager), { archived: true }, { projectId });
  await assert.rejects(invoke(createCreateSessionController(f.sessions, manager), { projectId }), (error: any) => error.statusCode === 409);
  await assert.rejects(invoke(createCreateSessionController(f.sessions, manager), { projectId: "missing" }), (error: any) => error.statusCode === 404);
  await assert.rejects(invoke(createCreateProjectController(manager), { name: "Invalid", rootPath: 4 }), (error: any) => error.statusCode === 400);
});
