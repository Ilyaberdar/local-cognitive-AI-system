import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { RuntimeManager } from "../src/app/RuntimeManager";
import { ProjectStore } from "../src/projects/ProjectStore";
import { RemoteOperationError, type OperationContext } from "../src/remote/host/RemoteHost";
import { CommandLedger } from "../src/runtime/CommandLedger";
import { HostDatabase } from "../src/runtime/db/HostDatabase";
import { hostMigrations } from "../src/runtime/db/hostSchema";
import { HostFolders } from "../src/runtime/hostFolders";
import { OPERATIONS } from "../src/runtime/operationCatalog";
import { createProjectAccess } from "../src/runtime/projectOperations";
import { createSynthesisOperations } from "../src/runtime/synthesisOperations";
import { SynthesisService } from "../src/synthesis/SynthesisService";
import { localModel, workingProvider } from "./fixtures/synthesisFixture";

const context: OperationContext = { accountId: "account", deviceId: "mac", signal: new AbortController().signal };
const code = (expected: string) => (error: unknown) => error instanceof RemoteOperationError && error.code === expected;
const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean) => {
  for (let index = 0; index < 400; index++) { const value = await read(); if (done(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("condition not reached");
};

async function setup(t: TestContext) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "synthesis-ops-")));
  const data = path.join(base, "data"), app = path.join(data, "app");
  await fs.mkdir(app, { recursive: true });
  const host = HostDatabase.open(path.join(base, "host.db"), hostMigrations);
  const projectStore = new ProjectStore(app), folders = new HostFolders(data);
  folders.ensureManaged();
  await fs.mkdir(path.join(data, "projects", "calc"));
  await fs.mkdir(path.join(base, "elsewhere"));
  const calls: string[] = [];
  const synthesis = new SynthesisService(app, { projects: projectStore, models: { listAllModels: async () => [localModel("qwen2.5-1.5b", 950_000_000)] },
    loadModel: async () => undefined, llm: workingProvider(calls) });
  await synthesis.init();
  t.after(async () => { await synthesis.dispose(); host.close(); await fs.rm(base, { recursive: true, force: true }); });
  const runtimeManager = { getRuntime: () => ({ synthesis, projectStore }) } as unknown as RuntimeManager;
  const state = { draining: false };
  const projects = createProjectAccess({ runtimeManager, folders });
  const ops = createSynthesisOperations({ runtimeManager, ledger: new CommandLedger(host), projects, scopeOf: () => "remote:account:mac",
    isDraining: () => state.draining, hostDirectories: [data] });
  const call = <T = any>(op: string, payload?: unknown) => Promise.resolve(ops[op]!(payload, context)) as Promise<T>;
  const device = await projectStore.create({ name: "Calc", rootPath: path.join(data, "projects", "calc"), origin: "device" });
  const hostOwned = await projectStore.create({ name: "Host", rootPath: path.join(base, "elsewhere") });
  return { base, data, synthesis, projectStore, call, state, device, hostOwned, calls };
}

test("every synthesis operation is in the catalog; what makes work or writes files is a command", () => {
  const ops = createSynthesisOperations({ runtimeManager: {} as RuntimeManager, ledger: {} as CommandLedger, projects: {} as never, scopeOf: () => "", isDraining: () => false });
  for (const name of Object.keys(ops)) assert.ok(OPERATIONS[name], name);
  for (const name of ["synthesis.modules.create", "synthesis.runs.start", "synthesis.runs.resume", "synthesis.runs.apply"]) assert.equal(OPERATIONS[name]!.kind, "command", name);
});

test("a device makes a module, runs it once per command, follows it, sees its changes and applies them, with no folder of the host", async t => {
  const f = await setup(t);
  const module = await f.call("synthesis.modules.create", { commandId: "cmd-module-1", projectId: f.device.id, template: "calculator" });
  assert.equal(module.valid, true, JSON.stringify(module.diagnostics));
  assert.ok(module.specSource.includes("module Calculator"));
  const listed = await f.call("synthesis.modules.list", { projectId: f.device.id });
  assert.deepEqual(listed.modules.map((item: any) => [item.id, "specSource" in item]), [["Calculator", false]], "a list carries no sources");

  const started = await f.call("synthesis.runs.start", { commandId: "cmd-start-1", projectId: f.device.id, moduleId: "Calculator" });
  const again = await f.call("synthesis.runs.start", { commandId: "cmd-start-1", projectId: f.device.id, moduleId: "Calculator" });
  assert.equal(again.id, started.id, "a resend gets the same run");
  const done = await until(() => f.call("synthesis.runs.get", { runId: started.id }), run => !["queued", "running"].includes(run.status));
  assert.equal(done.status, "accepted", done.error);
  assert.ok(done.events.length > 0 && done.lastSequence >= done.events.at(-1).sequence);
  const later = await f.call("synthesis.runs.get", { runId: started.id, after: done.lastSequence });
  assert.deepEqual(later.events, [], "only events after the cursor");
  assert.deepEqual(Object.keys(done.models[0]).sort(), ["displayName", "id", "providerId", "sizeBytes"]);
  assert.equal((await f.call("synthesis.runs.list", { projectId: f.device.id })).runs.length, 1);

  const diff = await f.call("synthesis.runs.diff", { runId: started.id });
  assert.equal(diff.canApply, true);
  assert.ok(diff.files.every((file: any) => typeof file.after === "string"));
  const applied = await f.call("synthesis.runs.apply", { commandId: "cmd-apply-1", runId: started.id });
  assert.equal(applied.ok, true);
  assert.deepEqual(await f.call("synthesis.runs.apply", { commandId: "cmd-apply-1", runId: started.id }), applied, "a resent apply is the same apply");
  assert.ok((await fs.readFile(path.join(f.data, "projects", "calc", "generated", "Calculator", "calculator.js"), "utf8").catch(() => "")) !== "" ||
    (await fs.readdir(path.join(f.data, "projects", "calc"), { recursive: true })).some(name => String(name).endsWith("calculator.js")), "the files are in the project");

  const everything = JSON.stringify([module, listed, done, diff, await f.call("synthesis.runs.sources", { runId: started.id })]);
  assert.equal(everything.includes(f.base), false, "no folder of the host");
});

test("a project set up on the server keeps its Synthesis there, and errors name no host folder", async t => {
  const f = await setup(t);
  for (const [op, payload] of [["synthesis.modules.list", { projectId: f.hostOwned.id }], ["synthesis.runs.list", { projectId: f.hostOwned.id }],
    ["synthesis.modules.create", { commandId: "cmd-module-h", projectId: f.hostOwned.id, template: "empty" }]] as const) {
    await assert.rejects(f.call(op, payload), code("unsupported"), op);
  }
  // A run in it, made on the host, is not a device's to read or restart.
  await f.synthesis.createModule(f.hostOwned.id, "Calculator", { template: "calculator" });
  const hostRun = await f.synthesis.start(f.hostOwned.id, "Calculator");
  await f.synthesis.wait(hostRun.id);
  await assert.rejects(f.call("synthesis.runs.get", { runId: hostRun.id }), code("unsupported"));
  await assert.rejects(f.call("synthesis.runs.resume", { commandId: "cmd-resume-h", runId: hostRun.id }), code("unsupported"));
  await assert.rejects(f.call("synthesis.modules.list", { projectId: "missing" }), code("project_unknown"));
  await assert.rejects(f.call("synthesis.runs.get", { runId: "4f1c1b0e-8d5a-4b8e-9c55-0a6b2f1e9d11" }), code("not_found"));
  await assert.rejects(f.call("synthesis.folders.list", { projectId: f.device.id, directory: "Nope" }), (error: unknown) =>
    error instanceof RemoteOperationError && error.code === "not_found" && !error.message.includes(f.base));
  await f.projectStore.update(f.device.id, { archived: true });
  await assert.rejects(f.call("synthesis.runs.start", { commandId: "cmd-start-a", projectId: f.device.id, moduleId: "Calculator" }), code("unsupported"), "archived");
  // As on the host's own screen: an archived project's Synthesis is closed until it is restored.
  await assert.rejects(f.call("synthesis.runs.list", { projectId: f.device.id }), code("not_found"));
});

test("while the server drains, new modules and runs are refused; reading still answers", async t => {
  const f = await setup(t);
  f.state.draining = true;
  await assert.rejects(f.call("synthesis.modules.create", { commandId: "cmd-module-d", projectId: f.device.id, template: "calculator" }), code("host_draining"));
  await assert.rejects(f.call("synthesis.runs.start", { commandId: "cmd-start-d", projectId: f.device.id, moduleId: "Calculator" }), code("host_draining"));
  assert.ok(await f.call("synthesis.modules.list", { projectId: f.device.id }));
});
