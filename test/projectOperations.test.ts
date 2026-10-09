import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { RuntimeManager } from "../src/app/RuntimeManager";
import { ProjectStore } from "../src/projects/ProjectStore";
import { RemoteOperationError } from "../src/remote/host/RemoteHost";
import { CommandLedger } from "../src/runtime/CommandLedger";
import { HostDatabase } from "../src/runtime/db/HostDatabase";
import { hostMigrations } from "../src/runtime/db/hostSchema";
import { addAdminFolder, HostFolders, removeAdminFolder } from "../src/runtime/hostFolders";
import { OPERATIONS } from "../src/runtime/operationCatalog";
import { createProjectAccess, createProjectOperations, PROJECT_ON_HOST } from "../src/runtime/projectOperations";

const context = { accountId: "account", deviceId: "mac", signal: new AbortController().signal };
const code = (expected: string) => (error: unknown) => error instanceof RemoteOperationError && error.code === expected;

function setup(t: TestContext) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "projects-ops-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const data = path.join(base, "data"), app = path.join(data, "app"), shared = path.join(base, "shared"), elsewhere = path.join(base, "elsewhere");
  for (const dir of [app, path.join(shared, "repo"), elsewhere]) fs.mkdirSync(dir, { recursive: true });
  const host = HostDatabase.open(path.join(base, "host.db"), hostMigrations);
  t.after(() => host.close());
  const store = new ProjectStore(app), folders = new HostFolders(data);
  folders.ensureManaged();
  fs.mkdirSync(path.join(data, "projects", "site"));
  const runtimeManager = { getRuntime: () => ({ projectStore: store }) } as unknown as RuntimeManager;
  const ops = createProjectOperations({ runtimeManager, folders, ledger: new CommandLedger(host), scopeOf: () => "remote:account:mac", isDraining: () => false });
  const call = <T = any>(op: string, payload?: unknown) => Promise.resolve(ops[op]!(payload, context)) as Promise<T>;
  return { base, data, shared, elsewhere, store, folders, call, access: createProjectAccess({ runtimeManager, folders }) };
}

test("project operations are in the catalog; creating one is a command", () => {
  assert.equal(OPERATIONS["projects.create"]?.kind, "command");
  for (const op of ["projects.list", "projects.update"]) assert.equal(OPERATIONS[op]?.kind, "request");
});

test("a device creates a project in a shared folder once per command, and sees it without the host's path", async t => {
  const f = setup(t);
  const request = { commandId: "command-site", name: "Site", folder: { rootId: "projects", path: ["site"] }, color: "blue" };
  const created = await f.call("projects.create", request);
  assert.deepEqual({ ...created, id: "<id>", createdAt: "<t>", updatedAt: "<t>" },
    { id: "<id>", name: "Site", color: "blue", archived: false, createdAt: "<t>", updatedAt: "<t>", folder: { rootId: "projects", rootLabel: "Projects", path: ["site"] } });
  assert.deepEqual(await f.call("projects.create", request), created, "a resend gets the same project");
  assert.equal((await f.store.list()).length, 1);
  await assert.rejects(f.call("projects.create", { ...request, commandId: "command-again" }), code("conflict"), "one project per folder");
  await assert.rejects(f.call("projects.create", { ...request, commandId: "command-again" }), code("conflict"), "a resend keeps the refusal's code");
  await assert.rejects(f.call("projects.create", { ...request, commandId: "command-up", folder: { rootId: "projects", path: [".."] } }), code("invalid_path"));
  await assert.rejects(f.call("projects.create", { ...request, commandId: "command-missing", folder: { rootId: "projects", path: ["missing"] } }), code("not_found"));
  assert.equal(JSON.stringify(await f.call("projects.list")).includes(f.base), false, "no folder of the host");
});

test("a project set up on the server is listed by name, may only be archived, and its chats stay there", async t => {
  const f = setup(t);
  const own = await f.store.create({ name: "Host project", rootPath: f.elsewhere });
  const [listed] = await f.call("projects.list");
  assert.deepEqual([listed.name, listed.hostOnly, listed.folder], ["Host project", true, undefined]);
  for (const patch of [{ name: "Mine" }, { color: "red" }, { archived: false }]) {
    await assert.rejects(f.call("projects.update", { projectId: own.id, ...patch }), code("unsupported"), JSON.stringify(patch));
  }
  assert.equal((await f.call("projects.update", { projectId: own.id, archived: true })).archived, true);
  assert.equal((await f.access.usable(own.id)).reason, PROJECT_ON_HOST);
});

test("a project in an admin's folder is usable until the folder is no longer shared, and not while archived", async t => {
  const f = setup(t);
  const work = addAdminFolder(f.data, f.shared, { label: "Work" });
  const project = await f.call("projects.create", { commandId: "command-repo", name: "Repo", folder: { rootId: work.id, path: ["repo"] } });
  assert.deepEqual(project.folder, { rootId: work.id, rootLabel: "Work", path: ["repo"] });
  assert.equal((await f.access.usable(project.id)).reason, undefined);
  assert.equal((await f.call("projects.update", { projectId: project.id, name: "Repository", color: "green" })).name, "Repository");
  await f.call("projects.update", { projectId: project.id, archived: true });
  assert.match(String((await f.access.usable(project.id)).reason), /archived/);
  await f.call("projects.update", { projectId: project.id, archived: false });
  removeAdminFolder(f.data, work.id);
  assert.equal((await f.access.usable(project.id)).reason, PROJECT_ON_HOST, "unshared at once");
  await assert.rejects(f.access.usable("missing"), code("project_unknown"));
});

test("a project the host set up stays the host's even inside a shared folder", async t => {
  const f = setup(t);
  const hostMade = await f.store.create({ name: "Host site", rootPath: path.join(f.data, "projects", "site") });
  const [listed] = await f.call("projects.list");
  assert.deepEqual([listed.id, listed.hostOnly, listed.folder], [hostMade.id, true, undefined]);
  assert.equal((await f.access.usable(hostMade.id)).reason, PROJECT_ON_HOST);
  assert.equal(await f.access.visible(hostMade.id), false, "its chats are not a device's to see");
  await assert.rejects(f.call("projects.update", { projectId: hostMade.id, archived: false }), code("unsupported"));
});

test("a project is not made where the folder resolves elsewhere than checked", async t => {
  const f = setup(t);
  await assert.rejects(f.store.create({ name: "Moved", rootPath: path.join(f.data, "projects", "site"), expectedRoot: path.join(f.base, "elsewhere") }),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409);
});
