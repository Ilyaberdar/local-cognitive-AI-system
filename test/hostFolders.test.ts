import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { RemoteOperationError } from "../src/remote/host/RemoteHost";
import { createFolderOperations } from "../src/runtime/folderOperations";
import { addAdminFolder, FolderError, HostFolders, listAdminFolders, removeAdminFolder } from "../src/runtime/hostFolders";
import { OPERATIONS } from "../src/runtime/operationCatalog";

const context = { accountId: "account", deviceId: "mac", signal: new AbortController().signal };
const code = (expected: string) => (error: unknown) => error instanceof RemoteOperationError && error.code === expected;

function setup(t: TestContext) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "host-folders-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const data = path.join(base, "data"), shared = path.join(base, "shared"), outside = path.join(base, "outside");
  for (const dir of [data, path.join(shared, "app", "src"), outside]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(shared, "app", "README.md"), "# App");
  fs.writeFileSync(path.join(shared, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(outside, path.join(shared, "escape"));
  fs.symlinkSync(path.join(shared, "app", "src"), path.join(shared, "inner"));
  const folders = new HostFolders(data);
  folders.ensureManaged();
  const ops = createFolderOperations({ folders });
  const call = <T = any>(op: string, payload?: unknown) => Promise.resolve(ops[op]!(payload, context)) as Promise<T>;
  return { base, data, shared, outside, folders, call };
}

test("every folder operation is in the catalog as a request", () => {
  for (const op of ["fs.roots", "fs.browse", "fs.mkdir"]) assert.equal(OPERATIONS[op]?.kind, "request", op);
});

test("an admin shares folders, never the data directory, a folder holding it, or the filesystem root", t => {
  const f = setup(t);
  for (const folder of [f.data, f.base, path.join(f.data, "projects"), "/", path.join(f.base, "missing")]) {
    assert.throws(() => addAdminFolder(f.data, folder), FolderError, folder);
  }
  const added = addAdminFolder(f.data, f.shared, { label: "Work", allowCreate: false });
  assert.throws(() => addAdminFolder(f.data, f.shared), (error: unknown) => (error as FolderError).code === "exists");
  assert.deepEqual(listAdminFolders(f.data).map(item => [item.label, item.path]), [["Work", f.shared]]);
  assert.equal((fs.statSync(path.join(f.data, "folders.json")).mode & 0o077), 0, "the list is private to the server's user");
  assert.ok(removeAdminFolder(f.data, added.id));
  assert.equal(removeAdminFolder(f.data, added.id), false);
});

test("a device sees roots by name and browses inside them; links out and traversal are refused", async t => {
  const f = setup(t);
  const work = addAdminFolder(f.data, f.shared, { label: "Work" });
  const roots = await f.call("fs.roots");
  assert.deepEqual(roots, [{ rootId: "projects", label: "Projects", kind: "managed", canCreate: true }, { rootId: work.id, label: "Work", kind: "admin", canCreate: false }]);
  assert.equal(JSON.stringify(roots).includes(f.base), false, "no folder of the host");
  const top = await f.call("fs.browse", { rootId: work.id });
  assert.deepEqual(top.entries.map((entry: any) => [entry.name, entry.kind]), [["app", "dir"], ["inner", "dir"]], "a link out and hidden files are left out");
  assert.deepEqual((await f.call("fs.browse", { rootId: work.id, hidden: true })).entries.map((entry: any) => entry.name), ["app", "inner", ".env"]);
  assert.deepEqual((await f.call("fs.browse", { rootId: work.id, path: ["app"] })).entries.map((entry: any) => [entry.name, entry.kind, entry.sizeBytes]),
    [["src", "dir", undefined], ["README.md", "file", 5]]);
  for (const [request, expected] of [[{ rootId: work.id, path: ["escape"] }, "forbidden"], [{ rootId: work.id, path: [".."] }, "invalid_path"],
    [{ rootId: work.id, path: ["app/../.."] }, "invalid_path"], [{ rootId: work.id, path: ["a\u0000b"] }, "invalid_path"], [{ rootId: work.id, path: ["a\\b"] }, "invalid_path"],
    [{ rootId: work.id, path: ["missing"] }, "not_found"], [{ rootId: "other", path: [] }, "not_found"], [{ rootId: work.id, path: ["app", "README.md"] }, "invalid_path"],
    [{ rootId: work.id, path: f.outside.split(path.sep).filter(Boolean) }, "not_found"]] as const) {
    await assert.rejects(f.call("fs.browse", request), code(expected), JSON.stringify(request));
  }
  removeAdminFolder(f.data, work.id);
  await assert.rejects(f.call("fs.browse", { rootId: work.id }), code("not_found"), "a folder no longer shared is refused at once");
});

test("folders are made only where the root allows, one at a time", async t => {
  const f = setup(t);
  const work = addAdminFolder(f.data, f.shared);
  assert.deepEqual(await f.call("fs.mkdir", { rootId: "projects", path: [], name: "website" }), { rootId: "projects", path: ["website"] });
  assert.ok(fs.statSync(path.join(f.data, "projects", "website")).isDirectory());
  await assert.rejects(f.call("fs.mkdir", { rootId: "projects", path: [], name: "website" }), code("exists"));
  await assert.rejects(f.call("fs.mkdir", { rootId: "projects", path: [], name: "a/b" }), code("invalid_path"));
  await assert.rejects(f.call("fs.mkdir", { rootId: "projects", path: ["missing"], name: "x" }), code("not_found"));
  await assert.rejects(f.call("fs.mkdir", { rootId: work.id, path: [], name: "new" }), code("forbidden"), "an admin folder without --allow-create");
  assert.deepEqual(f.folders.locate(path.join(f.data, "projects", "website")), { rootId: "projects", label: "Projects", path: ["website"] });
  assert.deepEqual(f.folders.locate(path.join(f.shared, "app", "src")), { rootId: work.id, label: "shared", path: ["app", "src"] });
  assert.equal(f.folders.locate(f.outside), undefined);
});

test("a listing stops at 500 entries", async t => {
  const f = setup(t);
  for (let index = 0; index < 505; index++) fs.writeFileSync(path.join(f.data, "projects", `file-${String(index).padStart(3, "0")}.txt`), "");
  const listing = await f.call("fs.browse", { rootId: "projects" });
  assert.deepEqual([listing.entries.length, listing.truncated], [500, true]);
});
