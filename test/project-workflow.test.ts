import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import test, { TestContext } from "node:test";
import { CognitiveEngine } from "../src/core/CognitiveEngine";
import { ProjectStore } from "../src/projects/ProjectStore";
import { ScheduleService } from "../src/schedules/ScheduleService";
import { ScheduleStore } from "../src/schedules/ScheduleStore";
import { SessionIndexStore } from "../src/session/SessionIndexStore";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { TaskService } from "../src/tasks/TaskService";
import { TaskStore } from "../src/tasks/TaskStore";
import { OperationExecutor } from "../src/tools/OperationExecutor";
import { ProcessInput } from "../src/types";
import { WorkspaceResolver } from "../src/workspace/WorkspaceResolver";
import { FsmEngine } from "../src/workflows/FsmEngine";
import { WorkflowRunStore } from "../src/workflows/WorkflowRunStore";
import { WorkflowRunner } from "../src/workflows/WorkflowRunner";
import { WorkflowStore } from "../src/workflows/WorkflowStore";
import { AgentNodeExecutor } from "../src/workflows/nodes/AgentNodeExecutor";
import { CommandNodeExecutor } from "../src/workflows/nodes/CommandNodeExecutor";
import { EntryNodeExecutor } from "../src/workflows/nodes/EntryNodeExecutor";
import { FileSearchNodeExecutor } from "../src/workflows/nodes/FileSearchNodeExecutor";
import { HumanReviewNodeExecutor } from "../src/workflows/nodes/HumanReviewNodeExecutor";
import { NodeExecutor, NodeExecutorRegistry } from "../src/workflows/nodes/NodeExecutor";
import { SaveFileNodeExecutor } from "../src/workflows/nodes/SaveFileNodeExecutor";
import { TerminalNodeExecutor } from "../src/workflows/nodes/TerminalNodeExecutor";
import { WorkflowDefinition, WorkflowNode, WorkflowRun } from "../src/workflows/types";

const node = (id: string, type: WorkflowNode["type"], config: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type, label: id, config, position: { x: 0, y: 0 } });

const graph = (steps: WorkflowNode[]): WorkflowDefinition => {
  const nodes = [node("entry", "entry"), ...steps, node("done", "terminal", { runStatus: "done" })];
  return { id: "workspace-flow", name: "Workspace flow", version: 1, entryNodeId: "entry", nodes,
    transitions: nodes.slice(0, -1).map((current, i) => ({ id: `${current.id}-next`, from: current.id,
      to: nodes[i + 1].id, priority: 100, guard: { type: "status", equals: "ok" } })),
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
};

async function fixture(t: TestContext, steps: WorkflowNode[], extra: NodeExecutor[] = []) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "project-workflow-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDataDir = path.join(root, "data");
  const projectDir = path.join(root, "project");
  const unrelatedDir = path.join(root, "other");
  await fs.mkdir(projectDir); await fs.mkdir(unrelatedDir);
  const projectStore = new ProjectStore(appDataDir);
  const project = await projectStore.create({ name: "Project", rootPath: projectDir });
  const resolver = new WorkspaceResolver({ appDataDir }, projectStore, new SessionIndexStore(appDataDir));
  const taskStore = new TaskStore(path.join(appDataDir, "tasks"));
  const runStore = new WorkflowRunStore(path.join(appDataDir, "runs"));
  const workflows = new WorkflowStore(path.join(appDataDir, "workflows"));
  const workflow = await workflows.create(graph(steps));
  const operations = new OperationExecutor(appDataDir);
  const settings = new SessionSettingsStore({ baseDir: path.join(appDataDir, "settings") }, { providerId: "test", model: "default" }, {});
  const registry = new NodeExecutorRegistry([
    new EntryNodeExecutor(), new TerminalNodeExecutor(), new HumanReviewNodeExecutor(),
    new SaveFileNodeExecutor({ accessMode: "full", allowedDirectories: [unrelatedDir], outputDir: unrelatedDir }, operations),
    new FileSearchNodeExecutor({ accessMode: "full", allowedDirectories: [unrelatedDir], workspaceDir: unrelatedDir }, operations),
    new CommandNodeExecutor({ accessMode: "full", allowedDirectories: [unrelatedDir], workspaceDir: unrelatedDir }, operations),
    ...extra
  ]);
  const runner = new WorkflowRunner(taskStore, workflows, runStore, new FsmEngine(), registry, resolver, settings);
  const tasks = new TaskService(taskStore, runStore, runner, resolver);
  return { root, appDataDir, projectDir, unrelatedDir, project, projectStore, resolver, taskStore, runStore,
    workflows, workflow, operations, registry, settings, runner, tasks };
}

function approval(run: WorkflowRun): string {
  const results = run.state.nodeResults as Record<string, { data: { approvalId: string } }>;
  return results[run.currentNodeId!].data.approvalId;
}

test("project workflow searches, writes and runs commands only in its saved workspace", async t => {
  const f = await fixture(t, [
    node("search", "file_search", { root: ".", queryTemplate: "PROJECT-MARKER", include: ["**/*.txt"] }),
    node("save", "file_write", { approval: "inherit", path: "result.json", contentTemplate: "{{nodes.search.data.results}}" }),
    node("command", "command", { approval: "inherit", executable: process.execPath, args: ["-e", "console.log(process.cwd())"], cwd: "." })
  ]);
  await fs.writeFile(path.join(f.projectDir, "input.txt"), "PROJECT-MARKER\n");
  const task = await f.tasks.create({ title: "Project work", description: "", workflowId: f.workflow.id, projectId: f.project.id, accessMode: "full", sessionId: "unrelated-chat" });
  const result = await f.tasks.runTask(task.id);
  const run = (await f.runStore.getRun(result.runId))!;
  assert.equal(run.status, "done");
  assert.equal(run.workspace?.rootPath, f.projectDir);
  assert.equal(run.executionSessionId, `workflow-${run.id}`);
  assert.notEqual(run.executionSessionId, task.sessionId);
  assert.match(await fs.readFile(path.join(f.projectDir, "result.json"), "utf8"), /PROJECT-MARKER/);
  await assert.rejects(fs.stat(path.join(f.unrelatedDir, "result.json")), { code: "ENOENT" });
  const nodeRuns = await f.runStore.listNodeRuns(run.id);
  assert.equal(nodeRuns.find(item => item.nodeId === "command")?.output?.data.stdout, `${f.projectDir}\n`);
});

test("tasks without a project retain independent output across runs and task deletion", async t => {
  const f = await fixture(t, [node("save", "file_write", { approval: "inherit", path: "report.txt", contentTemplate: "saved" })]);
  const first = await f.tasks.create({ title: "One", description: "", workflowId: f.workflow.id });
  const second = await f.tasks.create({ title: "Two", description: "", workflowId: f.workflow.id });
  const a = await f.tasks.runTask(first.id); const b = await f.tasks.runTask(second.id);
  const firstRoot = (await f.runStore.getRun(a.runId))!.workspace!.rootPath;
  const secondRoot = (await f.runStore.getRun(b.runId))!.workspace!.rootPath;
  assert.notEqual(firstRoot, secondRoot);
  const repeated = await f.tasks.runTask(first.id);
  assert.equal((await f.runStore.getRun(repeated.runId))!.workspace!.rootPath, firstRoot);
  assert.equal(await f.tasks.delete(first.id), true);
  assert.equal(await fs.readFile(path.join(firstRoot, "report.txt"), "utf8"), "saved");
  assert.ok((await f.resolver.managedWorkspaces.list()).some(item => item.taskId === first.id));
});

test("active run freezes task settings and rejects binding edits under its task lock", async t => {
  const f = await fixture(t, [node("save", "file_write", { approval: "always", path: "report.txt", contentTemplate: "{{task.description}}" })]);
  const task = await f.tasks.create({ title: "Freeze", description: "original", workflowId: f.workflow.id, projectId: f.project.id });
  const run = await f.runner.startTask(task.id);
  await assert.rejects(f.tasks.update(task.id, { projectId: null }), /Cancel or finish/);
  await assert.rejects(f.tasks.update(task.id, { accessMode: "full" }), /Cancel or finish/);
  await f.tasks.update(task.id, { description: "later edit" });
  const waiting = await f.runner.runUntilStopped(run.id);
  assert.equal(waiting.status, "waiting");
  await assert.rejects(f.tasks.update(task.id, { projectId: null }), /Cancel or finish/);
  await assert.rejects(f.runStore.updateRun(run.id, { workspace: { ...run.workspace!, rootPath: f.unrelatedDir } }), /cannot be changed/);
  await f.runner.review(run.id, true, "", false, { approvalId: approval(waiting) });
  assert.equal(await fs.readFile(path.join(f.projectDir, "report.txt"), "utf8"), "original");
  assert.equal((await f.tasks.update(task.id, { projectId: null }))?.projectId, undefined);
  assert.equal((await f.runStore.getRun(run.id))!.workspace!.rootPath, f.projectDir);
});

test("node full access never bypasses the task policy and stale approvals cannot authorize the next operation", async t => {
  const f = await fixture(t, [
    node("one", "file_write", { access: "full", path: "one.txt", contentTemplate: "one" }),
    node("two", "file_write", { access: "full", path: "two.txt", contentTemplate: "two" })
  ]);
  const task = await f.tasks.create({ title: "Ask", description: "", workflowId: f.workflow.id, projectId: f.project.id, accessMode: "ask" });
  const initial = await f.tasks.runTask(task.id);
  const waiting = (await f.runStore.getRun(initial.runId))!;
  const firstId = approval(waiting);
  await assert.rejects(fs.stat(path.join(f.projectDir, "one.txt")), { code: "ENOENT" });
  await assert.rejects(f.runner.review(waiting.id, true), /stale or missing/);
  const second = await f.runner.review(waiting.id, true, "", false, { approvalId: firstId });
  assert.equal(second.status, "waiting");
  await assert.rejects(f.runner.review(second.id, true, "", false, { approvalId: firstId }), /stale or missing/);
  await assert.rejects(fs.stat(path.join(f.projectDir, "two.txt")), { code: "ENOENT" });
  const rejected = await f.runner.review(second.id, false, "", false, { approvalId: approval(second) });
  assert.equal(rejected.status, "failed");
  assert.equal(await fs.readFile(path.join(f.projectDir, "one.txt"), "utf8"), "one");
});

test("workflow approvals reject file version changes", async t => {
  const f = await fixture(t, [node("save", "file_write", { approval: "always", path: "report.txt", contentTemplate: "new" })]);
  await fs.writeFile(path.join(f.projectDir, "report.txt"), "old");
  const task = await f.tasks.create({ title: "Conflict", description: "", workflowId: f.workflow.id, projectId: f.project.id });
  const { runId } = await f.tasks.runTask(task.id); const waiting = (await f.runStore.getRun(runId))!;
  await fs.writeFile(path.join(f.projectDir, "report.txt"), "edited elsewhere");
  const result = await f.runner.review(runId, true, "", false, { approvalId: approval(waiting) });
  assert.equal(result.status, "failed");
  assert.match(JSON.stringify(result.state), /version conflict/);
  assert.equal(await fs.readFile(path.join(f.projectDir, "report.txt"), "utf8"), "edited elsewhere");
});

test("workflow approval executes the rendered operation shown before mutable run state changed", async t => {
  const f = await fixture(t, [node("save", "file_write", { approval: "always", path: "snapshot.txt",
    contentTemplate: "{{run.updatedAt}} {{run.state}}" })]);
  const task = await f.tasks.create({ title: "Frozen render", description: "", workflowId: f.workflow.id, projectId: f.project.id });
  const { runId } = await f.tasks.runTask(task.id); const waiting = (await f.runStore.getRun(runId))!;
  const id = approval(waiting); const operation = (await f.operations.store.get(id))!;
  const preparedContent = String(operation.originalAction.arguments.content);
  const result = await f.runner.review(runId, true, "", false, { approvalId: id });
  assert.equal(result.status, "done");
  assert.equal(await fs.readFile(path.join(f.projectDir, "snapshot.txt"), "utf8"), preparedContent);
});

test("explicit resume reuses a completed node effect even when its run template changed", async t => {
  const f = await fixture(t, [node("save", "file_write", { approval: "inherit", mode: "append", path: "snapshot.txt",
    contentTemplate: "{{run.updatedAt}} {{run.state}}" })]);
  const task = await f.tasks.create({ title: "Crash after effect", description: "", workflowId: f.workflow.id, projectId: f.project.id, accessMode: "full" });
  const start = await f.runner.startTask(task.id);
  const queued = await f.runner.runNextStep(start.id);
  assert.equal(queued.currentNodeId, "save");
  // Simulate a crash after the durable operation completes but before the node result is committed.
  const invocation = "saved-invocation";
  const agentRunId = `workflow-${start.id}:save:${invocation}`;
  const operationId = `${agentRunId}:operation`;
  await f.operations.execute({ id: operationId, agentRunId, workspace: queued.workspace!, accessMode: "full",
    tool: "file.append", arguments: { path: "snapshot.txt", content: "exact approved content\n" }, captureVersion: true });
  await f.runStore.updateRun(start.id, { status: "running", state: { ...queued.state,
    activeNodeId: "save", nodeInvocationId: invocation, activeAgentRunId: agentRunId, activeOperationId: operationId } });
  await f.runner.recoverInterruptedRuns();
  assert.equal((await f.runner.resume(start.id)).status, "done");
  assert.equal(await fs.readFile(path.join(f.projectDir, "snapshot.txt"), "utf8"), "exact approved content\n");
});

test("a symlink cannot redirect an approved workflow write outside its shown path", async t => {
  const f = await fixture(t, [node("save", "file_write", { approval: "always", path: "report.txt", contentTemplate: "new" })]);
  const target = path.join(f.projectDir, "report.txt"); const outside = path.join(f.unrelatedDir, "report.txt");
  await fs.writeFile(target, "old"); await fs.writeFile(outside, "external");
  const task = await f.tasks.create({ title: "Path swap", description: "", workflowId: f.workflow.id, projectId: f.project.id });
  const { runId } = await f.tasks.runTask(task.id); const waiting = (await f.runStore.getRun(runId))!;
  await fs.unlink(target); await fs.symlink(outside, target);
  const result = await f.runner.review(runId, true, "", false, { approvalId: approval(waiting) });
  assert.equal(result.status, "failed");
  assert.match(JSON.stringify(result.state), /path changed/);
  assert.equal(await fs.readFile(outside, "utf8"), "external");
});

test("searching outside a task project requests an exact operation approval", async t => {
  const f = await fixture(t, [node("search", "file_search", { root: "../other", queryTemplate: "outside" })]);
  await fs.writeFile(path.join(f.unrelatedDir, "input.txt"), "outside marker");
  const task = await f.tasks.create({ title: "External search", description: "", workflowId: f.workflow.id, projectId: f.project.id });
  const { runId } = await f.tasks.runTask(task.id); const waiting = (await f.runStore.getRun(runId))!;
  assert.equal(waiting.status, "waiting");
  assert.match(JSON.stringify(waiting.state), /file.search/);
  const done = await f.runner.review(runId, true, "", false, { approvalId: approval(waiting) });
  assert.equal(done.status, "done");
  assert.match(JSON.stringify(done.state), /outside marker/);
});

test("agent approval resumes the same checkpoint after restart and sends rejection back to the agent", async t => {
  const received: ProcessInput[] = [];
  const engine = { process: async (request: ProcessInput) => {
    received.push(request);
    const resumed = Boolean(request.execution?.approval);
    return { input: request.input, mode: "code", providerId: "test", tools: [], memory: [], conversationSize: 0,
      sessionSettings: { defaultTarget: { providerId: "test" } },
      result: { response: resumed ? "Chose a safe alternative" : "Awaiting operation", provider: "test" },
      ...(!resumed ? { pendingApproval: { id: "agent-operation-1", tool: "file", operation: "file.write",
        summary: "Write report", details: "report.txt", requestedAt: new Date().toISOString() } } : {}) };
  } } as unknown as CognitiveEngine;
  const f = await fixture(t, [node("agent", "agent", { approval: "always", promptTemplate: "{{task.title}} {{run.updatedAt}} {{run.state}}" })], [new AgentNodeExecutor(engine)]);
  const task = await f.tasks.create({ title: "Inspect", description: "", workflowId: f.workflow.id, projectId: f.project.id, sessionId: "active-chat" });
  const { runId } = await f.tasks.runTask(task.id);
  const restarted = new WorkflowRunner(f.taskStore, f.workflows, new WorkflowRunStore(path.join(f.appDataDir, "runs")), new FsmEngine(), f.registry, f.resolver, f.settings);
  await restarted.recoverInterruptedRuns();
  const final = await restarted.review(runId, false, "Use another action", false, { approvalId: "agent-operation-1" });
  assert.equal(final.status, "done");
  assert.equal(received.length, 2);
  assert.equal(received[0].execution?.agentRunId, received[1].execution?.agentRunId);
  assert.equal(received[0].input, received[1].input);
  assert.equal(received[1].execution?.requireApproval, true);
  assert.equal(received[1].execution?.approval?.approved, false);
  assert.equal(received[1].actor?.sessionId, `workflow-${runId}`);
  assert.equal(received[1].execution?.workspace.rootPath, f.projectDir);
});

test("a workflow freezes model targets for its waiting and future nodes before provider defaults change", async t => {
  const received: ProcessInput[] = [];
  const engine = { process: async (request: ProcessInput) => {
    received.push(request);
    const waiting = request.metadata?.nodeId === "first" && !request.execution?.approval;
    return { input: request.input, mode: "code", providerId: request.providerId, tools: [], memory: [], conversationSize: 0,
      sessionSettings: request.execution?.settings,
      result: { response: waiting ? "Waiting" : "Done", provider: request.providerId, model: request.model },
      ...(waiting ? { pendingApproval: { id: "frozen-target-operation", tool: "file", operation: "file.write",
        summary: "Write report", details: "report.txt", requestedAt: new Date().toISOString() } } : {}) };
  } } as unknown as CognitiveEngine;
  const firstExecutor = new AgentNodeExecutor(engine, { test: "runtime-default", another: "another-v1" });
  const f = await fixture(t, [node("first", "agent", { providerId: "test" }), node("future", "agent", { providerId: "another" })], [firstExecutor]);
  const task = await f.tasks.create({ title: "Frozen models", description: "", workflowId: f.workflow.id, projectId: f.project.id });
  const { runId } = await f.tasks.runTask(task.id);
  const waiting = (await f.runStore.getRun(runId))!;
  assert.deepEqual(waiting.executionSnapshot?.nodeTargets, {
    first: { providerId: "test", model: "default" }, future: { providerId: "another", model: "another-v1" }
  });
  await f.settings.update(waiting.executionSessionId!, { defaultTarget: { providerId: "test", model: "changed-session-model" } });
  const registry = new NodeExecutorRegistry([new EntryNodeExecutor(), new TerminalNodeExecutor(),
    new AgentNodeExecutor(engine, { test: "runtime-default-v2", another: "another-v2" })]);
  const restarted = new WorkflowRunner(f.taskStore, f.workflows, f.runStore, new FsmEngine(), registry, f.resolver, f.settings);
  assert.equal((await restarted.review(runId, true, "", false, { approvalId: "frozen-target-operation" })).status, "done");
  assert.deepEqual(received.map(request => ({ providerId: request.providerId, model: request.model })), [
    { providerId: "test", model: "default" }, { providerId: "test", model: "default" }, { providerId: "another", model: "another-v1" }
  ]);
  assert.equal(received[0].execution?.agentRunId, received[1].execution?.agentRunId);
  assert.equal(received[2].execution?.settings?.defaultTarget.model, "default");
});

test("human review requires the exact waiting node run", async t => {
  const f = await fixture(t, [node("review", "human_review")]);
  const task = await f.tasks.create({ title: "Review", description: "", workflowId: f.workflow.id });
  const { runId } = await f.tasks.runTask(task.id);
  await assert.rejects(f.runner.review(runId, true, "", false, { waitingNodeRunId: "old" }), /stale or missing/);
  const waitingNode = (await f.runStore.listNodeRuns(runId)).find(item => item.status === "waiting")!;
  assert.equal((await f.runner.review(runId, true, "", false, { waitingNodeRunId: waitingNode.id })).status, "done");
});

test("lost workspace blocks a run without falling back to the application folder", async t => {
  const f = await fixture(t, [node("save", "file_write", { approval: "inherit", path: "report.txt", contentTemplate: "output" })]);
  const task = await f.tasks.create({ title: "Missing", description: "", workflowId: f.workflow.id, projectId: f.project.id });
  const run = await f.runner.startTask(task.id);
  await fs.rename(f.projectDir, `${f.projectDir}-moved`);
  const blocked = await f.runner.runUntilStopped(run.id);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.error!, /missing or has moved/);
  await assert.rejects(fs.stat(path.join(f.unrelatedDir, "report.txt")), { code: "ENOENT" });
});

test("interrupted command is explicitly resumed and an unknown effect is not repeated", async t => {
  const f = await fixture(t, [node("command", "command", { approval: "inherit", executable: process.execPath,
    args: ["-e", "require('fs').appendFileSync('counter.txt','x')"], cwd: "." })]);
  const task = await f.tasks.create({ title: "Crash", description: "", workflowId: f.workflow.id, projectId: f.project.id });
  const { runId } = await f.tasks.runTask(task.id);
  const waiting = (await f.runStore.getRun(runId))!;
  const id = approval(waiting); const saved = (await f.operations.store.get(id))!;
  saved.status = "executing"; await f.operations.store.save(saved);
  await fs.writeFile(path.join(f.projectDir, "counter.txt"), "x");
  await f.runStore.updateRun(runId, { status: "running", state: { ...waiting.state,
    approvedNodeId: "command", approvedOperation: { approvalId: id, approved: true } } });
  await f.runner.recoverInterruptedRuns();
  assert.equal((await f.runStore.getRun(runId))?.status, "interrupted");
  const recovered = await f.runner.resume(runId);
  assert.equal(recovered.status, "blocked");
  assert.match(JSON.stringify(recovered.state), /outcome is unknown/);
  assert.equal(await fs.readFile(path.join(f.projectDir, "counter.txt"), "utf8"), "x");
});

test("unknown effects hard-stop even when a workflow graph has failure and blocked retry edges", async t => {
  const f = await fixture(t, [node("command", "command", { approval: "inherit", executable: process.execPath,
    args: ["-e", "require('fs').appendFileSync('counter.txt','x')"], cwd: "." })]);
  const workflow = structuredClone(f.workflow);
  workflow.transitions.push({ id: "retry-failed", from: "command", to: "command", priority: 200,
    guard: { type: "status", equals: "failed" } }, { id: "retry-blocked", from: "command", to: "command", priority: 200,
    guard: { type: "status", equals: "blocked" } });
  await f.workflows.update(workflow.id, workflow);
  const task = await f.tasks.create({ title: "No auto retry", description: "", workflowId: workflow.id, projectId: f.project.id });
  const { runId } = await f.tasks.runTask(task.id); const waiting = (await f.runStore.getRun(runId))!;
  const id = approval(waiting); const saved = (await f.operations.store.get(id))!;
  saved.status = "executing"; await f.operations.store.save(saved);
  await fs.writeFile(path.join(f.projectDir, "counter.txt"), "x");
  const blocked = await f.runner.review(runId, true, "", false, { approvalId: id });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.currentNodeId, "command");
  assert.equal(blocked.state.nodeInvocationId, waiting.state.nodeInvocationId);
  assert.equal(blocked.state.activeOperationId, id);
  await assert.rejects(f.runner.resume(runId), /Only an interrupted run/);
  assert.equal((await f.runner.runNextStep(runId)).status, "blocked");
  assert.equal(await fs.readFile(path.join(f.projectDir, "counter.txt"), "utf8"), "x");
  assert.equal((await f.runStore.listNodeRuns(runId)).filter(item => item.nodeId === "command").length, 2);
});

test("legacy unfinished runs are blocked at recovery instead of assigned a new workspace", async t => {
  const f = await fixture(t, [node("save", "file_write", { approval: "inherit", path: "report.txt", contentTemplate: "legacy" })]);
  const task = await f.tasks.create({ title: "Legacy", description: "", workflowId: f.workflow.id });
  const legacy = await f.runStore.createRun({ task, workflow: f.workflow });
  await f.taskStore.setStatus(task.id, "in_progress", { lastRunId: legacy.id });
  await f.runner.recoverInterruptedRuns();
  const blocked = (await f.runStore.getRun(legacy.id))!;
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.workspace, undefined);
  assert.match(blocked.error!, /legacy run has no workspace snapshot/);
  assert.equal((await f.resolver.managedWorkspaces.list()).length, 0);
});

test("schedule claims freeze project/access and edits apply to future occurrences", async t => {
  const f = await fixture(t, [node("save", "file_write", { approval: "inherit", path: "report.txt", contentTemplate: "scheduled" })]);
  const store = new ScheduleStore(path.join(f.appDataDir, "schedules"));
  const service = new ScheduleService(store, f.tasks, f.resolver);
  const schedule = await service.create({ title: "Daily", description: "", workflowId: f.workflow.id,
    projectId: f.project.id, accessMode: "full", time: "09:00", timezone: "UTC" }, new Date("2026-09-23T08:00:00Z"));
  await store.claimDispatch(schedule.id, schedule.nextRunAt, "2026-09-24T09:00:00.000Z");
  await service.update(schedule.id, { projectId: null, accessMode: "ask" }, new Date("2026-09-23T09:00:01Z"));
  const dispatch = await service.runDue(new Date("2026-09-23T09:00:01Z"));
  assert.equal(dispatch.length, 1);
  const task = (await f.tasks.get(dispatch[0].taskId!))!;
  assert.equal(task.projectId, f.project.id);
  assert.equal(task.accessMode, "full");
  assert.equal((await service.get(schedule.id))?.projectId, undefined);
  assert.equal((await service.get(schedule.id))?.accessMode, "ask");
  assert.equal(await fs.readFile(path.join(f.projectDir, "report.txt"), "utf8"), "scheduled");
});

test("concurrent schedule services dispatch a claimed occurrence once", async t => {
  const f = await fixture(t, [node("save", "file_write", { approval: "inherit", path: "report.txt", contentTemplate: "scheduled" })]);
  const scheduleDir = path.join(f.appDataDir, "schedules");
  const one = new ScheduleService(new ScheduleStore(scheduleDir), f.tasks, f.resolver);
  const two = new ScheduleService(new ScheduleStore(scheduleDir), f.tasks, f.resolver);
  await one.create({ title: "Daily", description: "", workflowId: f.workflow.id,
    projectId: f.project.id, accessMode: "full", time: "09:00", timezone: "UTC" }, new Date("2026-09-23T08:00:00Z"));
  await Promise.all([one.runDue(new Date("2026-09-23T09:00:01Z")), two.runDue(new Date("2026-09-23T09:00:01Z"))]);
  assert.equal((await f.tasks.list()).length, 1);
  assert.equal((await f.runStore.listRuns()).length, 1);
});
