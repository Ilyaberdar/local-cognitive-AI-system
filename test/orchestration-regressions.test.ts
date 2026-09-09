import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../src/tasks/TaskStore";
import { TaskService } from "../src/tasks/TaskService";
import { WorkflowStore } from "../src/workflows/WorkflowStore";
import { WorkflowRunStore } from "../src/workflows/WorkflowRunStore";
import { WorkflowRunner } from "../src/workflows/WorkflowRunner";
import { FsmEngine } from "../src/workflows/FsmEngine";
import { defaultTaskWorkflow } from "../src/workflows/defaultWorkflows";
import { NodeExecutor, NodeExecutorRegistry } from "../src/workflows/nodes/NodeExecutor";
import { EntryNodeExecutor } from "../src/workflows/nodes/EntryNodeExecutor";
import { TerminalNodeExecutor } from "../src/workflows/nodes/TerminalNodeExecutor";
import { HumanReviewNodeExecutor } from "../src/workflows/nodes/HumanReviewNodeExecutor";
import { SaveFileNodeExecutor } from "../src/workflows/nodes/SaveFileNodeExecutor";
import { CommandNodeExecutor } from "../src/workflows/nodes/CommandNodeExecutor";
import { AgentNodeExecutor } from "../src/workflows/nodes/AgentNodeExecutor";
import { CognitiveEngine } from "../src/core/CognitiveEngine";
import { withFileLock } from "../src/utils/fileStore";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const ok = { status: "ok" as const, event: "agent.completed", summary: "done", data: {} };
const fixture = async (executor: NodeExecutor = { type: "agent", execute: async () => ok }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-workflow-regression-"));
  const tasks = new TaskStore(path.join(root, "tasks"));
  const workflows = new WorkflowStore(root);
  const runs = new WorkflowRunStore(root);
  const runner = new WorkflowRunner(tasks, workflows, runs, new FsmEngine(), new NodeExecutorRegistry([
    new EntryNodeExecutor(), new TerminalNodeExecutor(), new HumanReviewNodeExecutor(),
    new SaveFileNodeExecutor({ accessMode: "restricted", allowedDirectories: [root], outputDir: root }), executor
  ]));
  const service = new TaskService(tasks, runs, runner);
  const task = await tasks.create({ title: "Test", description: "Test execution", workflowId: defaultTaskWorkflow().id });
  return { root, tasks, workflows, runs, runner, service, task };
};

test("concurrent workflow/run/trace writes survive across multiple store instances", async () => {
  const f = await fixture();
  const other = new WorkflowRunStore(f.root);
  const definitions = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    new WorkflowStore(f.root).create({ ...defaultTaskWorkflow(), id: `parallel-${index}` })));
  assert.equal((await f.workflows.list()).length, 13);
  const runs = await Promise.all(definitions.map((workflow, index) =>
    (index % 2 ? f.runs : other).createRun({ task: f.task, workflow })));
  assert.equal((await f.runs.listRuns()).length, 12);
  await Promise.all(runs.map((run) => f.runs.appendNodeRun({
    runId: runs[0].id, taskId: f.task.id, workflowId: run.workflowId, nodeId: "execute", input: {}, status: "ok", startedAt: new Date().toISOString()
  })));
  assert.equal((await other.listNodeRuns(runs[0].id)).length, 12);
  await Promise.all(runs.map((run) => f.runs.updateRun(run.id, { status: "done" })));
  assert.ok((await f.runs.listRuns()).every((run) => run.status === "done"));
});

test("malformed workflow and trace stores are preserved", async () => {
  for (const name of ["definitions.json", "runs.json", "node-runs.json"]) {
    const f = await fixture();
    const file = path.join(f.root, name);
    await fs.writeFile(file, "{broken");
    const read = name === "definitions.json" ? () => f.workflows.list() : name === "runs.json" ? () => f.runs.listRuns() : () => f.runs.listNodeRuns("run");
    await assert.rejects(read);
    assert.equal(await fs.readFile(file, "utf8"), "{broken");
  }
});

test("concurrent steps execute a slow node once and cancellation remains terminal", async () => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  let signal: AbortSignal | undefined;
  const f = await fixture({ type: "agent", execute: async (context) => {
    calls++; signal = context.signal; entered.resolve(); await release.promise; return ok;
  } });
  const run = await f.runner.startTask(f.task.id);
  await f.runner.runNextStep(run.id);
  const first = f.runner.runNextStep(run.id);
  const second = f.runner.runNextStep(run.id);
  await entered.promise;
  assert.equal(calls, 1);
  assert.equal((await f.runner.cancel(run.id)).status, "cancelled");
  assert.equal(signal?.aborted, true);
  release.resolve();
  assert.equal((await first).status, "cancelled");
  assert.equal((await second).status, "cancelled");
  assert.equal((await f.tasks.get(f.task.id))?.status, "cancelled");
  assert.equal((await f.runs.listNodeRuns(run.id)).length, 2);
});

test("cancel before preparation returns a stopped run without rejecting", async () => {
  const f = await fixture();
  const run = await f.runner.startTask(f.task.id);
  const release = deferred();
  const held = withFileLock(`workflow-run:${run.id}`, () => release.promise);
  const step = f.runner.runNextStep(run.id);
  const cancel = f.runner.cancel(run.id);
  release.resolve();
  await held;
  assert.equal((await step).status, "cancelled");
  assert.equal((await cancel).status, "cancelled");
});

test("task run and run-next deduplicate concurrent requests", async () => {
  const entered = deferred(); const release = deferred(); let calls = 0;
  const f = await fixture({ type: "agent", execute: async () => { calls++; entered.resolve(); await release.promise; return ok; } });
  const first = f.service.runTask(f.task.id);
  const second = f.service.runTask(f.task.id);
  await entered.promise;
  assert.equal(await f.service.runNextQueued(), null);
  await assert.rejects(() => f.service.delete(f.task.id), /Cancel or finish/);
  release.resolve();
  assert.equal((await first).runId, (await second).runId);
  assert.equal(calls, 1);
  assert.equal((await f.runs.listRuns()).length, 1);
});

test("a run keeps its original graph after the saved workflow changes", async () => {
  const f = await fixture(); const run = await f.runner.startTask(f.task.id);
  await f.runner.runNextStep(run.id);
  const definition = defaultTaskWorkflow();
  definition.nodes[1].id = "renamed";
  definition.transitions = definition.transitions.map((edge) => ({ ...edge,
    from: edge.from === "execute" ? "renamed" : edge.from, to: edge.to === "execute" ? "renamed" : edge.to }));
  await f.workflows.update(definition.id, definition);
  await f.tasks.update(f.task.id, { workflowId: "missing" });
  assert.equal((await f.runner.runUntilStopped(run.id)).status, "done");
  assert.ok((await f.runs.listNodeRuns(run.id)).some((node) => node.nodeId === "execute"));
});

test("terminal at the step limit completes, and a blocked run can restart", async () => {
  const f = await fixture();
  const run = await f.runner.startTask(f.task.id);
  assert.equal((await f.runner.runUntilStopped(run.id, 3)).status, "done");
  const blocked = await f.runner.startTask(f.task.id);
  assert.equal((await f.runner.runUntilStopped(blocked.id, 1)).status, "blocked");
  assert.equal((await f.tasks.get(f.task.id))?.status, "blocked");
  const restarted = await f.service.runTask(f.task.id);
  assert.notEqual(restarted.runId, blocked.id);
  assert.equal(restarted.task.status, "done");
});

test("human review approves or rejects without repeating earlier nodes", async () => {
  for (const approved of [true, false]) {
    const f = await fixture(); const definition = defaultTaskWorkflow(); definition.nodes[1].type = "human_review";
    await f.workflows.update(definition.id, definition);
    const run = await f.runner.startTask(f.task.id);
    assert.equal((await f.runner.runUntilStopped(run.id, 2)).status, "waiting");
    assert.equal((await f.runner.review(run.id, approved, "review note")).status, approved ? "done" : "failed");
    const trace = await f.runs.listNodeRuns(run.id);
    assert.equal(trace.filter((node) => node.nodeId === "execute").length, 1);
    assert.equal(trace.find((node) => node.nodeId === "execute")?.output?.summary, "review note");
    await assert.rejects(() => f.runner.review(run.id, true), /Only a waiting/);
  }
});

test("file approval executes only the approved node while preserving path restrictions", async () => {
  const f = await fixture(); const definition = defaultTaskWorkflow();
  definition.nodes[1] = { ...definition.nodes[1], type: "file_write", config: { path: "approved.txt", contentTemplate: "approved output" } };
  await f.workflows.update(definition.id, definition);
  const run = await f.runner.startTask(f.task.id);
  assert.equal((await f.runner.runUntilStopped(run.id)).status, "waiting");
  await assert.rejects(() => fs.access(path.join(f.root, "approved.txt")));
  assert.equal((await f.runner.review(run.id, true)).status, "done");
  assert.equal(await fs.readFile(path.join(f.root, "approved.txt"), "utf8"), "approved output");
  assert.ok((await f.runs.listNodeRuns(run.id)).every((node) => node.status !== "waiting"));
});

test("file approval uses the path and content shown before the task was edited", async () => {
  const f = await fixture(); const definition = defaultTaskWorkflow();
  definition.nodes[1] = { ...definition.nodes[1], type: "file_write", config: { path: "{{task.description}}", contentTemplate: "{{task.title}}" } };
  await f.workflows.update(definition.id, definition);
  await f.tasks.update(f.task.id, { title: "Original content", description: "reviewed.txt" });
  const run = await f.runner.startTask(f.task.id);
  assert.equal((await f.runner.runUntilStopped(run.id)).status, "waiting");
  await f.tasks.update(f.task.id, { title: "Changed content", description: "changed.txt" });
  assert.equal((await f.runner.review(run.id, true)).status, "done");
  assert.equal(await fs.readFile(path.join(f.root, "reviewed.txt"), "utf8"), "Original content");
  await assert.rejects(() => fs.access(path.join(f.root, "changed.txt")));
});

test("command approval uses the arguments shown before the task was edited", async () => {
  const f = await fixture(); const definition = defaultTaskWorkflow();
  definition.nodes[1] = { ...definition.nodes[1], type: "command", config: {
    executable: process.execPath, cwd: ".",
    args: ["-e", "require('fs').writeFileSync('reviewed.txt', JSON.stringify(process.argv.slice(1)))", "{{task.description}}", "{{task.metadata.empty}}"]
  } };
  await f.workflows.update(definition.id, definition);
  const runner = new WorkflowRunner(f.tasks, f.workflows, f.runs, new FsmEngine(), new NodeExecutorRegistry([
    new EntryNodeExecutor(), new TerminalNodeExecutor(),
    new CommandNodeExecutor({ accessMode: "restricted", allowedDirectories: [f.root], workspaceDir: f.root })
  ]));
  const run = await runner.startTask(f.task.id);
  assert.equal((await runner.runUntilStopped(run.id)).status, "waiting");
  await f.tasks.update(f.task.id, { description: "Changed command argument" });
  assert.equal((await runner.review(run.id, true)).status, "done");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, "reviewed.txt"), "utf8")), ["Test execution", ""]);
});

test("malformed graph shapes and missing comparison values are rejected without throwing", async () => {
  const f = await fixture();
  for (const graph of [null, {}, { ...defaultTaskWorkflow(), nodes: null },
    { ...defaultTaskWorkflow(), nodes: [null] }, { ...defaultTaskWorkflow(), transitions: [null] }]) {
    assert.equal(f.workflows.validate(graph).ok, false);
  }
  const definition = defaultTaskWorkflow(); definition.nodes[1].config = null as never;
  assert.equal(f.workflows.validate(definition).ok, false);
  definition.nodes[1].config = {};
  definition.transitions[1].guard = { type: "json_path", path: "data.exitCode", op: "eq" };
  assert.equal(f.workflows.validate(definition).ok, false);
  for (const value of [0, false, "text"]) {
    definition.transitions[1].guard.value = value;
    assert.equal(f.workflows.validate(definition).ok, true);
    await f.workflows.update(definition.id, definition);
    assert.deepEqual((await f.workflows.get(definition.id))?.transitions[1].guard, definition.transitions[1].guard);
  }
});

test("model failure takes the workflow failure branch", async () => {
  const engine = { process: async () => ({ providerId: "ollama", result: { response: "offline", error: "offline", model: "fixture" }, tools: [] }) } as unknown as CognitiveEngine;
  const f = await fixture(new AgentNodeExecutor(engine));
  const { task, runId } = await f.service.runTask(f.task.id);
  assert.equal(task.status, "failed");
  assert.equal((await f.runs.getRun(runId))?.status, "failed");
  assert.equal((await f.runs.listNodeRuns(runId)).find((node) => node.nodeId === "execute")?.output?.error, "offline");
});

test("background task start returns before a model finishes and supports cancellation", async () => {
  const entered = deferred(); const release = deferred();
  const f = await fixture({ type: "agent", execute: async () => { entered.resolve(); await release.promise; return ok; } });
  const started = await f.service.startTask(f.task.id);
  await entered.promise;
  assert.equal((await f.runner.cancel(started.runId)).status, "cancelled");
  release.resolve();
  assert.equal((await f.runner.runUntilStopped(started.runId)).status, "cancelled");
});

test("cancel kills a command that ignores SIGTERM before it can keep writing", { skip: process.platform === "win32" }, async () => {
  const f = await fixture(); const ready = path.join(f.root, "ready"); const output = path.join(f.root, "late");
  const executor = new CommandNodeExecutor({ accessMode: "restricted", allowedDirectories: [f.root], workspaceDir: f.root });
  const controller = new AbortController(); const workflow = defaultTaskWorkflow();
  const node = { ...workflow.nodes[1], type: "command" as const, config: { access: "full", executable: process.execPath, args: ["-e", `const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(output)},'late'),750);setInterval(()=>{},1000);`] } };
  const run = await f.runner.startTask(f.task.id);
  const work = executor.execute({ task: f.task, workflow, node, run, previousNodeRuns: [], signal: controller.signal });
  const rejected = assert.rejects(work, /abort/i);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fs.access(ready).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await fs.access(ready);
  controller.abort();
  await rejected;
  await assert.rejects(() => fs.access(output));
});
