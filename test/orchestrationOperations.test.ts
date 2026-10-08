import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import type { RuntimeManager } from "../src/app/RuntimeManager";
import { ProjectStore } from "../src/projects/ProjectStore";
import { RemoteOperationError, type OperationContext } from "../src/remote/host/RemoteHost";
import { CommandLedger } from "../src/runtime/CommandLedger";
import { HostDatabase } from "../src/runtime/db/HostDatabase";
import { hostMigrations } from "../src/runtime/db/hostSchema";
import { OPERATIONS } from "../src/runtime/operationCatalog";
import { createOrchestrationOperations } from "../src/runtime/orchestrationOperations";
import { ScheduleService } from "../src/schedules/ScheduleService";
import { ScheduleStore } from "../src/schedules/ScheduleStore";
import { SessionIndexStore } from "../src/session/SessionIndexStore";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { TaskService } from "../src/tasks/TaskService";
import { TaskStore } from "../src/tasks/TaskStore";
import { OperationExecutor } from "../src/tools/OperationExecutor";
import { FsmEngine } from "../src/workflows/FsmEngine";
import { EntryNodeExecutor } from "../src/workflows/nodes/EntryNodeExecutor";
import { HumanReviewNodeExecutor } from "../src/workflows/nodes/HumanReviewNodeExecutor";
import { NodeExecutorRegistry } from "../src/workflows/nodes/NodeExecutor";
import { TerminalNodeExecutor } from "../src/workflows/nodes/TerminalNodeExecutor";
import type { WorkflowDefinition, WorkflowNode } from "../src/workflows/types";
import { WorkflowRunner } from "../src/workflows/WorkflowRunner";
import { WorkflowRunStore } from "../src/workflows/WorkflowRunStore";
import { WorkflowStore } from "../src/workflows/WorkflowStore";
import { WorkspaceResolver } from "../src/workspace/WorkspaceResolver";

const node = (id: string, type: WorkflowNode["type"], config: Record<string, unknown> = {}): WorkflowNode => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
/** entry → human review → done: a run waits for review and executes nothing. */
const reviewWorkflow = (extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({ id: "review-flow", name: "Review flow", version: 1, entryNodeId: "entry",
  createdAt: "", updatedAt: "", nodes: [node("entry", "entry"), node("review", "human_review"), node("done", "terminal", { runStatus: "done" })],
  transitions: [{ id: "a", from: "entry", to: "review", priority: 1, guard: { type: "always" } }, { id: "b", from: "review", to: "done", priority: 1, guard: { type: "always" } }], ...extra });
const context = (deviceId = "mac"): OperationContext => ({ accountId: "account", deviceId, signal: new AbortController().signal });
const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last ${JSON.stringify(value).slice(0, 200)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const code = (expected: string) => (error: unknown) => error instanceof RemoteOperationError && error.code === expected;

async function setup(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orchestration-ops-")));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const taskStore = new TaskStore(path.join(root, "tasks"));
  const workflowStore = new WorkflowStore(path.join(root, "workflows"));
  const workflowRunStore = new WorkflowRunStore(path.join(root, "runs"));
  const resolver = new WorkspaceResolver({ appDataDir: root }, new ProjectStore(root), new SessionIndexStore(root));
  new OperationExecutor(root);
  const registry = new NodeExecutorRegistry([new EntryNodeExecutor(), new TerminalNodeExecutor(), new HumanReviewNodeExecutor()]);
  const settings = new SessionSettingsStore({ baseDir: path.join(root, "settings") }, { providerId: "fake", model: "model" }, {});
  const workflowRunner = new WorkflowRunner(taskStore, workflowStore, workflowRunStore, new FsmEngine(), registry, resolver, settings);
  const taskService = new TaskService(taskStore, workflowRunStore, workflowRunner, resolver);
  const scheduleService = new ScheduleService(new ScheduleStore(path.join(root, "schedules")), taskService, resolver);
  const host = HostDatabase.open(path.join(root, "host.db"), hostMigrations);
  t.after(() => host.close());
  const state = { draining: false };
  const runtimeManager = { getRuntime: () => ({ taskService, scheduleService, workflowStore, workflowRunStore, workflowRunner }) } as unknown as RuntimeManager;
  const operations = (ledger = new CommandLedger(host)) => createOrchestrationOperations({ runtimeManager, ledger,
    scopeOf: ({ accountId, deviceId }) => `remote:${accountId}:${deviceId}`, isDraining: () => state.draining });
  const ops = operations();
  const call = <T = any>(op: string, payload?: unknown, ctx = context()) => Promise.resolve(ops[op]!(payload, ctx)) as Promise<T>;
  return { root, host, state, ops, operations, call, resolver, taskService, workflowStore, workflowRunStore, workflowRunner };
}

test("every orchestration operation is in the catalog; what creates or starts work is a command", () => {
  const ops = createOrchestrationOperations({ runtimeManager: {} as RuntimeManager, ledger: {} as CommandLedger, scopeOf: () => "", isDraining: () => false });
  for (const name of Object.keys(ops)) assert.ok(OPERATIONS[name], `${name} is missing from the operation catalog`);
  for (const name of ["tasks.create", "tasks.run", "tasks.runNext", "schedules.create", "workflows.save"]) assert.equal(OPERATIONS[name]!.kind, "command", name);
});

test("the snapshot lists the host's work without host internals and is a few bytes when unchanged", async t => {
  const f = await setup(t);
  await f.call("workflows.save", { commandId: "cmd-save-1", workflow: reviewWorkflow(), expectedUpdatedAt: null });
  const task = await f.call("tasks.create", { commandId: "cmd-task-1", title: " Weekly report ", description: "Summarise", workflowId: "review-flow" });
  assert.equal(task.title, "Weekly report");
  await f.call("schedules.create", { commandId: "cmd-schedule-1", title: "Every morning", description: "Summarise", workflowId: "review-flow", time: "09:00", timezone: "UTC" });
  const { runId } = await f.call("tasks.run", { commandId: "cmd-run-1", taskId: task.id });
  await until(() => f.workflowRunStore.getRun(runId), run => run?.status === "waiting");

  const snapshot = await f.call("orchestration.snapshot", {});
  assert.deepEqual(snapshot.tasks.map((item: { id: string }) => item.id), [task.id]);
  assert.equal(snapshot.schedules.length, 1);
  assert.ok(snapshot.workflows.some((item: { id: string }) => item.id === "review-flow"));
  const run = snapshot.workflowRuns.find((item: { id: string }) => item.id === runId);
  assert.equal(run.status, "waiting");
  assert.deepEqual(run.workspace, { kind: "task" });
  for (const field of ["state", "executionSnapshot", "executionSessionId"]) assert.equal(field in run, false, `${field} stays on the host`);
  assert.equal(JSON.stringify(snapshot).includes(f.root), false, "no host directory reaches the device");

  const again = await f.call("orchestration.snapshot", { revision: snapshot.revision });
  assert.deepEqual(again, { revision: snapshot.revision, unchanged: true });
  await f.call("tasks.update", { taskId: task.id, patch: { priority: "high" } });
  const changed = await f.call("orchestration.snapshot", { revision: snapshot.revision });
  assert.notEqual(changed.revision, snapshot.revision);
  assert.equal(changed.tasks[0].priority, "high");
});

test("a resent command acts once; the same command id for another request is refused", async t => {
  const f = await setup(t);
  await f.call("workflows.save", { commandId: "cmd-save-1", workflow: reviewWorkflow(), expectedUpdatedAt: null });
  const request = { commandId: "cmd-task-1", title: "Report", description: "", workflowId: "review-flow" };
  const [first, second] = await Promise.all([f.call("tasks.create", request), f.call("tasks.create", request)]);
  const third = await f.call("tasks.create", request);
  assert.equal(second.id, first.id);
  assert.equal(third.id, first.id);
  assert.equal((await f.taskService.list()).length, 1, "one task for three sends");
  await assert.rejects(f.call("tasks.create", { ...request, title: "Other" }), code("idempotency_conflict"));
  // Another device's command id is its own.
  const other = await f.call("tasks.create", request, context("phone"));
  assert.notEqual(other.id, first.id);

  const run = await f.call("tasks.run", { commandId: "cmd-run-1", taskId: first.id });
  const rerun = await f.call("tasks.run", { commandId: "cmd-run-1", taskId: first.id });
  assert.equal(rerun.runId, run.runId);
  await until(() => f.workflowRunStore.getRun(run.runId), item => item?.status === "waiting");
  assert.equal((await f.workflowRunStore.listRuns()).filter(item => item.taskId === first.id).length, 1);
  await assert.rejects(f.call("tasks.run", { commandId: "cmd-run-2", taskId: "missing" }), code("not_found"));
  await assert.rejects(f.call("tasks.run", { commandId: "cmd-run-2", taskId: "missing" }), code("not_found"), "a refusal is replayed too");
});

test("a command accepted before a restart is never executed again", async t => {
  const f = await setup(t);
  await f.call("workflows.save", { commandId: "cmd-save-1", workflow: reviewWorkflow(), expectedUpdatedAt: null });
  const task = await f.call("tasks.create", { commandId: "cmd-task-1", title: "Report", workflowId: "review-flow" });
  // The first process accepts both commands and stops before finishing them.
  const hung = new Promise<never>(() => undefined);
  const stuck = new CommandLedger(f.host);
  void stuck.run({ scope: "remote:account:mac", key: "cmd-create-lost", operation: "tasks.create", payload: { title: "Lost", workflowId: "review-flow" } }, () => hung);
  void stuck.run({ scope: "remote:account:mac", key: "cmd-run-lost", operation: "tasks.run", payload: { taskId: task.id } }, () => hung);
  // After the restart: an unknown outcome is said so; nothing is created a second time.
  const after = f.operations(new CommandLedger(f.host));
  const call = (op: string, payload: unknown) => Promise.resolve(after[op]!(payload, context()));
  await assert.rejects(call("tasks.create", { commandId: "cmd-create-lost", title: "Lost", workflowId: "review-flow" }), code("unknown_outcome"));
  assert.equal((await f.taskService.list()).some(item => item.title === "Lost"), false);
  await assert.rejects(call("tasks.run", { commandId: "cmd-run-lost", taskId: task.id }), code("not_started"), "no run was created for it");
  assert.equal((await f.workflowRunStore.listRuns()).length, 0, "and none is created now");
  await assert.rejects(call("tasks.run", { commandId: "cmd-run-lost", taskId: task.id }), code("not_started"), "the outcome is kept");

  // The run was created before the restart: the resend gets that run.
  void stuck.run({ scope: "remote:account:mac", key: "cmd-run-created", operation: "tasks.run", payload: { taskId: task.id } }, () => hung);
  const started = await f.taskService.startTask(task.id);
  const replay = await call("tasks.run", { commandId: "cmd-run-created", taskId: task.id }) as { runId: string };
  assert.equal(replay.runId, started.runId);
  await until(() => f.workflowRunStore.getRun(started.runId), item => item?.status === "waiting");
});

test("saving a workflow another device changed meanwhile is a conflict, not an overwrite", async t => {
  const f = await setup(t);
  const created = await f.call("workflows.save", { commandId: "cmd-save-1", workflow: reviewWorkflow(), expectedUpdatedAt: null });
  await assert.rejects(f.call("workflows.save", { commandId: "cmd-save-2", workflow: reviewWorkflow(), expectedUpdatedAt: null }), code("workflow_conflict"));
  const renamed = await f.call("workflows.save", { commandId: "cmd-save-3", workflow: { ...created, name: "Renamed" }, expectedUpdatedAt: created.updatedAt });
  assert.ok(renamed.updatedAt > created.updatedAt);
  // The other device still edits the version it opened.
  await assert.rejects(f.call("workflows.save", { commandId: "cmd-save-4", workflow: { ...created, name: "Mine" }, expectedUpdatedAt: created.updatedAt }),
    (error: unknown) => code("workflow_conflict")(error) && /changed on the server/.test((error as Error).message));
  assert.equal((await f.workflowStore.get("review-flow"))!.name, "Renamed");
  await assert.rejects(f.call("workflows.save", { commandId: "cmd-save-5", workflow: { ...created, entryNodeId: "missing" }, expectedUpdatedAt: renamed.updatedAt }),
    code("invalid_request"));
});

test("what a device may not set on the host yet is refused with the reason", async t => {
  const f = await setup(t);
  const refused = async (op: string, payload: unknown, pattern: RegExp) => assert.rejects(f.call(op, payload),
    (error: unknown) => code("unsupported")(error) && pattern.test((error as Error).message), `${op} ${JSON.stringify(payload).slice(0, 80)}`);
  await refused("tasks.create", { commandId: "cmd-limits-1", title: "x", accessMode: "full" }, /Full access/);
  await refused("tasks.create", { commandId: "cmd-limits-1", title: "x", attachments: [{ name: "a.txt" }] }, /Attachments/);
  await refused("tasks.create", { commandId: "cmd-limits-1", title: "x", projectId: "p1" }, /Projects and folders/);
  await refused("schedules.create", { commandId: "cmd-limits-2", title: "x", time: "09:00", timezone: "UTC", accessMode: "full" }, /Full access/);
  const full = reviewWorkflow({ nodes: [node("entry", "entry"), node("review", "human_review", { approval: "never" }), node("done", "terminal")] });
  await refused("workflows.save", { commandId: "cmd-limits-3", workflow: full, expectedUpdatedAt: null }, /Full access/);
  await refused("workflows.save", { commandId: "cmd-limits-3", workflow: reviewWorkflow({ runDefaults: { rootPath: "/srv/data" } }), expectedUpdatedAt: null }, /folders/);
  const plugins = reviewWorkflow({ nodes: [node("entry", "entry"), node("agent", "agent", { pluginIds: ["github"] }), node("done", "terminal")] });
  await refused("workflows.save", { commandId: "cmd-limits-3", workflow: plugins, expectedUpdatedAt: null }, /Plugins/);
  const check = await f.call("workflows.validate", { workflow: full });
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((message: string) => /Full access/.test(message)));
  assert.deepEqual(await f.call("workflows.validate", { workflow: reviewWorkflow() }), { ok: true, errors: [] });
  await assert.rejects(f.call("tasks.update", { taskId: "x", patch: { title: "y", sessionId: "s" } }), code("invalid_request"));
  assert.equal((await f.taskService.list()).length, 0);
});

test("while the host drains, new work is refused and reads, replays and later sends still work", async t => {
  const f = await setup(t);
  const task = await f.call("tasks.create", { commandId: "cmd-task-1", title: "Report" });
  f.state.draining = true;
  await assert.rejects(f.call("tasks.create", { commandId: "cmd-task-2", title: "Later" }), code("host_draining"));
  await assert.rejects(f.call("tasks.update", { taskId: task.id, patch: { title: "y" } }), code("host_draining"));
  await assert.rejects(f.call("schedules.delete", { scheduleId: "s" }), code("host_draining"));
  assert.equal((await f.call("tasks.create", { commandId: "cmd-task-1", title: "Report" })).id, task.id, "a replay still answers");
  assert.equal((await f.call("orchestration.snapshot")).tasks.length, 1);
  f.state.draining = false;
  assert.equal((await f.call("tasks.create", { commandId: "cmd-task-2", title: "Later" })).title, "Later", "a refused command was not recorded");
});

test("an active task cannot be deleted; a missing one reports so", async t => {
  const f = await setup(t);
  await f.call("workflows.save", { commandId: "cmd-save-1", workflow: reviewWorkflow(), expectedUpdatedAt: null });
  const task = await f.call("tasks.create", { commandId: "cmd-task-1", title: "Report", workflowId: "review-flow" });
  const { runId } = await f.call("tasks.run", { commandId: "cmd-run-1", taskId: task.id });
  await until(() => f.workflowRunStore.getRun(runId), run => run?.status === "waiting");
  await assert.rejects(f.call("tasks.delete", { taskId: task.id }), code("conflict"));
  assert.deepEqual(await f.call("tasks.delete", { taskId: "missing" }), { deleted: false });
  await assert.rejects(f.call("tasks.update", { taskId: "missing", patch: { title: "x" } }), code("not_found"));
  await assert.rejects(f.call("schedules.update", { scheduleId: "missing", patch: { enabled: false } }), code("not_found"));
});

test("a run left queued by an earlier process is interrupted at startup and Resume continues it", async t => {
  const f = await setup(t);
  const workflow = reviewWorkflow({ id: "plain", nodes: [node("entry", "entry"), node("done", "terminal", { runStatus: "done" })],
    transitions: [{ id: "a", from: "entry", to: "done", priority: 1, guard: { type: "always" } }] });
  // Written as an earlier process would have left it: created, never driven.
  const id = "4f1c1b0e-8d5a-4b8e-9c55-0a6b2f1e9d11";
  const left = await f.workflowRunStore.createRun({ id, workflow, workspace: await f.resolver.forWorkflowRun(id, {}), nodeTargets: {},
    executionSessionId: `workflow-${id}`, input: { title: "Plain", description: "" }, accessMode: "default", maxSteps: 25 });
  assert.equal(left.status, "queued");
  // A run this process created and has not driven yet stays as it is.
  const mine = await f.workflowRunner.startStandalone(workflow);
  await f.workflowRunner.recoverInterruptedRuns();
  assert.equal((await f.workflowRunStore.getRun(id))!.status, "interrupted");
  assert.equal((await f.workflowRunStore.getRun(mine.id))!.status, "queued");
  assert.equal((await f.workflowRunner.resume(id)).status, "done");
});
