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

async function setup(t: TestContext, llm = workingProvider()) {
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
    loadModel: async () => undefined, llm });
  await synthesis.init();
  t.after(async () => { await synthesis.dispose(); host.close(); await fs.rm(base, { recursive: true, force: true }); });
  const runtimeManager = { getRuntime: () => ({ synthesis, projectStore }) } as unknown as RuntimeManager;
  const state = { draining: false };
  const projects = createProjectAccess({ runtimeManager, folders });
  const caller = (ledger: CommandLedger) => {
    const ops = createSynthesisOperations({ runtimeManager, ledger, projects, scopeOf: () => "remote:account:mac", isDraining: () => state.draining, hostDirectories: [data] });
    return <T = any>(op: string, payload?: unknown) => Promise.resolve(ops[op]!(payload, context)) as Promise<T>;
  };
  const call = caller(new CommandLedger(host));
  const device = await projectStore.create({ name: "Calc", rootPath: path.join(data, "projects", "calc"), origin: "device" });
  const hostOwned = await projectStore.create({ name: "Host", rootPath: path.join(base, "elsewhere") });
  return { base, data, host, synthesis, projectStore, call, caller, state, device, hostOwned, calls };
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

/** A model that answers only when its run is stopped: the run stays running until then. */
const waitingProvider = () => {
  const until = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return { generateObject: (request: { signal?: AbortSignal }) => until(request.signal), generateText: (request: { signal?: AbortSignal }) => until(request.signal) } as unknown as ReturnType<typeof workingProvider>;
};

test("a device's run stops once its project is archived; a run a device started may be stopped also when its project is no longer shared", async t => {
  const f = await setup(t, waitingProvider());
  f.synthesis.guardIntervalMs = 20;
  // The guard's timer does not hold a process open; this test's does.
  const alive = setInterval(() => undefined, 50); t.after(() => clearInterval(alive));
  await f.call("synthesis.modules.create", { commandId: "cmd-module-g", projectId: f.device.id, template: "calculator" });
  const started = await f.call("synthesis.runs.start", { commandId: "cmd-start-g", projectId: f.device.id, moduleId: "Calculator" });
  await until(() => f.call("synthesis.runs.get", { runId: started.id }), run => run.status === "running");
  await f.projectStore.update(f.device.id, { archived: true });
  const stopped = await f.synthesis.wait(started.id);
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.startedBy, "device");
  assert.match(stopped.error ?? "", /archived/i);

  // A run on the host is the host's: a device stops neither it nor anything it cannot see.
  await f.synthesis.createModule(f.hostOwned.id, "Calculator", { template: "calculator" });
  const hostRun = await f.synthesis.start(f.hostOwned.id, "Calculator");
  await assert.rejects(f.call("synthesis.runs.cancel", { runId: hostRun.id }), code("unsupported"));
  assert.notEqual((await f.synthesis.get(hostRun.id)).status, "cancelled");
  // A run a device started there (its folder since unshared) is still the device's to stop.
  const deviceRun = await f.synthesis.start(f.hostOwned.id, "Calculator", { device: { guard: async () => undefined } });
  const cancelled = await f.call("synthesis.runs.cancel", { runId: deviceRun.id });
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(f.call("synthesis.runs.get", { runId: deviceRun.id }), code("unsupported"), "reading it stays closed");
  await f.synthesis.cancel(hostRun.id);
});

test("events a device reads name no folder outside the project; a failure is its first line", async t => {
  const f = await setup(t);
  await f.call("synthesis.modules.create", { commandId: "cmd-module-e", projectId: f.device.id, template: "calculator" });
  const started = await f.call("synthesis.runs.start", { commandId: "cmd-start-e", projectId: f.device.id, moduleId: "Calculator" });
  await f.synthesis.wait(started.id);
  // A model's process error as the service records it.
  const file = path.join(f.data, "app", "synthesis", "runs", `${started.id}.json`);
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  const sequence = record.events.at(-1).sequence;
  record.events.push({ sequence: sequence + 1, at: record.updatedAt, step: "agent.generate", status: "failed", iteration: 1,
    message: "calculator.js: llama-server exited: /opt/models/secret/qwen.gguf missing\nlog line two /var/log/x/y", detail: "see /Users/someone/notes/plan.md and Source/Abilities/Dash.cpp" },
  { sequence: sequence + 2, at: record.updatedAt, step: "apply", status: "ok", iteration: 1, message: "3 candidate files applied to Source/Abilities/Dash." });
  await fs.writeFile(file, JSON.stringify(record));
  const events = (await f.call("synthesis.runs.get", { runId: started.id, after: sequence })).events;
  assert.equal(events[0].message, "calculator.js: llama-server exited: <path> missing");
  assert.equal(events[0].detail, "see <path> and Source/Abilities/Dash.cpp");
  assert.equal(events[1].message, "3 candidate files applied to Source/Abilities/Dash.", "a path in the project is kept");
});

test("an Apply a restart interrupted is reported by what the project's files hold", async t => {
  const f = await setup(t);
  await f.call("synthesis.modules.create", { commandId: "cmd-module-r", projectId: f.device.id, template: "calculator" });
  // Three accepted runs of one module, all checked out before any Apply; each one's Apply is
  // accepted by a first process that stops before it answers.
  const lost = [];
  for (const key of ["none", "all", "some"]) {
    const started = await f.call("synthesis.runs.start", { commandId: `cmd-start-${key}`, projectId: f.device.id, moduleId: "Calculator" });
    assert.equal((await f.synthesis.wait(started.id)).status, "accepted");
    void new CommandLedger(f.host).run({ scope: "remote:account:mac", key: `cmd-apply-${key}`, operation: "synthesis.runs.apply", payload: { runId: started.id }, target: started.id },
      () => new Promise<never>(() => undefined));
    lost.push({ id: started.id, resend: { commandId: `cmd-apply-${key}`, runId: started.id } });
  }
  const [none, all, some] = lost as [typeof lost[0], typeof lost[0], typeof lost[0]];
  const call = f.caller(new CommandLedger(f.host));

  // Nothing written: it did not start.
  await assert.rejects(call("synthesis.runs.apply", none.resend), code("not_started"));

  // Every file written before the answer: it is reported applied, and the run says so.
  await f.synthesis.apply(all.id);
  const recordFile = path.join(f.data, "app", "synthesis", "runs", `${all.id}.json`);
  const record = JSON.parse(await fs.readFile(recordFile, "utf8")); delete record.appliedAt;
  await fs.writeFile(recordFile, JSON.stringify(record));
  assert.equal((await call("synthesis.runs.apply", all.resend)).ok, true);
  assert.ok((await f.synthesis.get(all.id)).appliedAt);

  // Some written (one file is not there): neither, and said so for every resend.
  const written = (await fs.readdir(path.join(f.data, "projects", "calc"), { recursive: true })).map(String).filter(name => name.endsWith(".css"));
  assert.equal(written.length, 1);
  await fs.rm(path.join(f.data, "projects", "calc", written[0]!));
  await assert.rejects(call("synthesis.runs.apply", some.resend), code("unknown_outcome"));
  await assert.rejects(call("synthesis.runs.apply", some.resend), code("unknown_outcome"), "the answer is kept");
  assert.equal((await f.synthesis.get(some.id)).appliedAt, undefined);
});
