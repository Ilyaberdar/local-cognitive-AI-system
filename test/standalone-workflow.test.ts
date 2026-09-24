import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { ProjectStore } from "../src/projects/ProjectStore";
import { SessionIndexStore } from "../src/session/SessionIndexStore";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { TaskStore } from "../src/tasks/TaskStore";
import { OperationExecutor } from "../src/tools/OperationExecutor";
import { WorkspaceResolver } from "../src/workspace/WorkspaceResolver";
import { WorkflowRunner } from "../src/workflows/WorkflowRunner";
import { WorkflowRunStore } from "../src/workflows/WorkflowRunStore";
import { WorkflowStore } from "../src/workflows/WorkflowStore";
import { FsmEngine } from "../src/workflows/FsmEngine";
import { EntryNodeExecutor } from "../src/workflows/nodes/EntryNodeExecutor";
import { TerminalNodeExecutor } from "../src/workflows/nodes/TerminalNodeExecutor";
import { HumanReviewNodeExecutor } from "../src/workflows/nodes/HumanReviewNodeExecutor";
import { ReadFileNodeExecutor } from "../src/workflows/nodes/ReadFileNodeExecutor";
import { SaveFileNodeExecutor } from "../src/workflows/nodes/SaveFileNodeExecutor";
import { CommandNodeExecutor } from "../src/workflows/nodes/CommandNodeExecutor";
import { NodeExecutor, NodeExecutorRegistry } from "../src/workflows/nodes/NodeExecutor";
import { WorkflowDefinition, WorkflowNode } from "../src/workflows/types";
import { createStartWorkflowRunController } from "../src/api/workflowControllers";
import { RuntimeManager } from "../src/app/RuntimeManager";
import { renameNodeBindings } from "../frontend/workflow/workflowAdapter";

const node = (id: string, type: WorkflowNode["type"], config: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const graph = (steps: WorkflowNode[]): WorkflowDefinition => {
  const nodes = [node("entry", "entry"), ...steps, node("done", "terminal")];
  return { id: "direct", name: "Direct workflow", version: 1, entryNodeId: "entry", createdAt: "", updatedAt: "", nodes,
    transitions: nodes.slice(0, -1).map((item, i) => ({ id: item.id + "-next", from: item.id, to: nodes[i + 1].id, priority: 1, guard: { type: "status", equals: "ok" } })) };
};
async function fixture(t: TestContext, extra: NodeExecutor[] = []) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "standalone-workflow-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const taskStore = new TaskStore(path.join(root, "tasks"));
  const workflows = new WorkflowStore(path.join(root, "workflows"));
  const runs = new WorkflowRunStore(path.join(root, "runs"));
  const projects = new ProjectStore(root);
  const resolver = new WorkspaceResolver({ appDataDir: root }, projects, new SessionIndexStore(root));
  const operations = new OperationExecutor(root);
  const registry = new NodeExecutorRegistry([new EntryNodeExecutor(), new TerminalNodeExecutor(), new HumanReviewNodeExecutor(),
    new ReadFileNodeExecutor(operations), new SaveFileNodeExecutor({ accessMode: "restricted", allowedDirectories: [], outputDir: root }, operations),
    new CommandNodeExecutor({ accessMode: "restricted", allowedDirectories: [], workspaceDir: root }, operations), ...extra]);
  const settings = new SessionSettingsStore({ baseDir: path.join(root, "settings") }, { providerId: "fake", model: "model" }, {});
  const runner = new WorkflowRunner(taskStore, workflows, runs, new FsmEngine(), registry, resolver, settings);
  return { root, taskStore, workflows, runs, projects, resolver, runner };
}

test("standalone draft snapshots input, writes and reads files, and never creates a Task", async t => {
  const f = await fixture(t);
  const draft = graph([
    node("save", "file_write", { path: "research/findings.md", contentTemplate: "{{input.title}}: {{input.description}} / {{task.description}}", approval: "inherit" }),
    node("read", "file_read", { path: "{{nodes.save.data.path}}" }),
    node("report", "file_write", { path: "report.md", contentTemplate: "{{nodes.read.data.content}}", approval: "inherit" })
  ]);
  const run = await f.runner.startStandalone(draft, { description: "ORIGINAL" });
  draft.nodes[1].config.contentTemplate = "CHANGED";
  const final = await f.runner.runUntilStopped(run.id);
  assert.equal(final.status, "done"); assert.equal(final.taskId, undefined); assert.equal(final.source, "standalone");
  assert.equal(final.executionSnapshot?.task, undefined);
  assert.match(final.workspace!.rootPath, /workspaces\/workflow-runs\//);
  assert.equal(await fs.readFile(path.join(final.workspace!.rootPath, "report.md"), "utf8"), "Direct workflow: ORIGINAL / ORIGINAL");
  assert.deepEqual(await f.taskStore.list(), []);
  assert.ok((await f.runs.listNodeRuns(run.id)).every(item => item.taskId === undefined));
  await assert.rejects(f.runs.updateRun(run.id, { source: "task" }), /cannot be changed/);
});

test("direct runs support project, explicit folder and separate managed workspaces", async t => {
  const f = await fixture(t);
  const folder = path.join(f.root, "project"); await fs.mkdir(folder);
  const project = await f.projects.create({ name: "Project", rootPath: folder });
  const direct = await f.runner.startStandalone(graph([]), { rootPath: folder });
  const bound = await f.runner.startStandalone(graph([]), { projectId: project.id });
  assert.equal(direct.workspace!.rootPath, folder); assert.equal(bound.workspace!.projectId, project.id);
  const a = await f.runner.startStandalone(graph([])); const b = await f.runner.startStandalone(graph([]));
  assert.notEqual(a.workspace!.rootPath, b.workspace!.rootPath);
  await fs.rename(folder, folder + "-moved");
  assert.equal((await f.runner.runUntilStopped(direct.id)).status, "blocked");
});

test("invalid direct run settings are rejected before a run is created", async t => {
  const f = await fixture(t);
  for (const options of [{ rootPath: "relative" }, { rootPath: "" }, { rootPath: "/missing-workflow-dir" }, { maxSteps: 0 }, { maxSteps: 251 }, { accessMode: "unsafe" }, { description: 1 }, { rootPath: f.root, projectId: "project" }]) {
    await assert.rejects(f.runner.startStandalone(graph([]), options as never));
  }
  assert.equal((await f.runs.listRuns()).length, 0);
});

test("direct run API validates drafts and starts the current graph with saved defaults", async t => {
  const f = await fixture(t);
  const controller = createStartWorkflowRunController({ getRuntime: () => ({ workflowStore: f.workflows, workflowRunner: f.runner }) } as unknown as RuntimeManager);
  let status = 0; let payload: any;
  const response = { status(code: number) { status = code; return this; }, json(value: unknown) { payload = value; } };
  await controller({ body: { workflow: {} } } as never, response as never, error => { throw error; });
  assert.equal(status, 400); assert.match(payload.error, /Workflow requires/);
  const workflow = graph([]); workflow.runDefaults = { description: "Saved defaults", accessMode: "ask" };
  await controller({ body: { workflow } } as never, response as never, error => { throw error; });
  assert.equal(status, 201); assert.equal(payload.executionSnapshot.input.description, "Saved defaults");
  assert.equal(payload.executionSnapshot.accessMode, "ask");
  assert.equal((await f.runner.runUntilStopped(payload.id)).status, "done");
  assert.deepEqual(await f.taskStore.list(), []);
});

test("read file bindings preserve JSON and original line numbering in file contents", async t => {
  const f = await fixture(t);
  const contents = '{"count": 3}\n1: original user text\n';
  const run = await f.runner.startStandalone(graph([
    node("write", "file_write", { path: "input.txt", contentTemplate: contents, approval: "inherit" }),
    node("read", "file_read", { path: "{{nodes.write.data.path}}" }),
    node("copy", "file_write", { path: "copy.txt", contentTemplate: "{{nodes.read.data.content}}", approval: "inherit" })
  ]));
  assert.equal((await f.runner.runUntilStopped(run.id)).status, "done");
  assert.equal(await fs.readFile(path.join(run.workspace!.rootPath, "copy.txt"), "utf8"), contents);
  const read = (await f.runs.listNodeRuns(run.id)).find(item => item.nodeId === "read")!;
  const inputPath = path.join(run.workspace!.rootPath, "input.txt");
  assert.equal(read.output?.data.path, inputPath);
  assert.equal(read.output?.summary, `Read ${inputPath}`);
});

test("renaming a step preserves nested bindings and decision paths without touching similar IDs", () => {
  assert.deepEqual(renameNodeBindings({ promptTemplate: "Use {{ nodes.agent.data.response }} and {{nodes.agent2.summary}}",
    inputFiles: ["{{nodes.agent.data.path}}"], path: "nodes.agent.data.exitCode" }, "agent", "research"), {
    promptTemplate: "Use {{nodes.research.data.response}} and {{nodes.agent2.summary}}",
    inputFiles: ["{{nodes.research.data.path}}"], path: "nodes.research.data.exitCode"
  });
});

test("validation catches deleted or mistyped source bindings instead of writing an empty result", async t => {
  const f = await fixture(t);
  const workflow = graph([node("save", "file_write", { path: "result.txt", contentTemplate: "{{nodes.missing.data.response}}" })]);
  await assert.rejects(f.runner.startStandalone(workflow), /references missing step missing/);
});

test("a binding from a skipped branch fails before creating an empty output file", async t => {
  const f = await fixture(t);
  const workflow = graph([
    node("source", "file_write", { path: "source.txt", contentTemplate: "value", approval: "inherit" }),
    node("sink", "file_write", { path: "result.txt", contentTemplate: "{{nodes.source.data.path}}", approval: "inherit" })
  ]);
  workflow.transitions[0].to = "sink";
  const run = await f.runner.startStandalone(workflow);
  assert.equal((await f.runner.runUntilStopped(run.id)).status, "failed");
  const last = (await f.runs.listNodeRuns(run.id)).at(-1)!;
  assert.match(last.error!, /Input nodes.source.data.path is unavailable/);
  await assert.rejects(fs.stat(path.join(run.workspace!.rootPath, "result.txt")));
});

test("combined agent prompt and model target remain frozen across approval and definition edits", async t => {
  const prompts: string[] = [];
  const f = await fixture(t, [{ type: "agent", snapshotTarget: () => ({ providerId: "fake", model: "frozen" }), async execute(context) {
    prompts.push(context.agentInput!);
    if (!context.approval) return { status: "needs_input", event: "agent.approval_required", summary: "Approve", data: { permissionRequired: true, approvalId: "agent-approval" } };
    return { status: "ok", event: "agent.completed", summary: "done", data: { response: context.agentInput } };
  } }]);
  const draft = graph([node("save", "file_write", { path: "input.txt", contentTemplate: "EVIDENCE", approval: "inherit" }),
    node("agent", "agent", { promptTemplate: "Do {{input.description}}", contextTemplate: "{{nodes.save.summary}}", inputFiles: ["{{nodes.save.data.path}}"] })]);
  const run = await f.runner.startStandalone(draft, { description: "ORIGINAL" });
  assert.equal((await f.runner.runUntilStopped(run.id)).status, "waiting");
  draft.nodes[2].config.promptTemplate = "changed";
  await assert.rejects(f.runner.review(run.id, true, "", false, { approvalId: "stale" }), /stale/);
  assert.equal((await f.runner.review(run.id, true, "", false, { approvalId: "agent-approval" })).status, "done");
  assert.equal(prompts.length, 2); assert.equal(prompts[0], prompts[1]);
  assert.match(prompts[0], /Do ORIGINAL/); assert.match(prompts[0], /INPUT FILES/); assert.match(prompts[0], /REFERENCE DATA/);
  assert.equal(run.executionSnapshot!.nodeTargets!.agent.model, "frozen");
});

test("standalone review, rejection and interruption resume do not require a Task", async t => {
  const f = await fixture(t);
  const run = await f.runner.startStandalone(graph([node("review", "human_review")]));
  assert.equal((await f.runner.runUntilStopped(run.id)).status, "waiting");
  const waiting = (await f.runs.listNodeRuns(run.id)).at(-1)!;
  assert.equal((await f.runner.review(run.id, false, "No", false, { waitingNodeRunId: waiting.id })).status, "failed");
  const resume = await f.runner.startStandalone(graph([]));
  await f.runner.runNextStep(resume.id);
  await f.runs.updateRun(resume.id, { status: "running" });
  await f.runner.recoverInterruptedRuns();
  assert.equal((await f.runs.getRun(resume.id))!.status, "interrupted");
  assert.equal((await f.runner.resume(resume.id)).status, "done");
});

test("Stop cancels an active standalone command without late output or a subsequent file", async t => {
  const f = await fixture(t);
  const run = await f.runner.startStandalone(graph([
    node("command", "command", { executable: process.execPath, args: ["-e", "console.log('START');setTimeout(()=>console.log('LATE'),5000)"], approval: "inherit" }),
    node("save", "file_write", { path: "must-not-exist.txt", contentTemplate: "bad", approval: "inherit" })
  ]), { accessMode: "full" });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const unsubscribe = f.runs.events.subscribe(run.id, event => { if (event.type === "node.output" && event.detail?.includes("START")) started(); });
  const work = f.runner.runUntilStopped(run.id);
  await ready; await f.runner.cancel(run.id); await work; unsubscribe();
  assert.equal((await f.runs.getRun(run.id))!.status, "cancelled");
  assert.equal((await f.runs.events.list(run.id)).events.some(event => event.type === "node.output" && event.detail?.includes("LATE")), false);
  await assert.rejects(fs.stat(path.join(run.workspace!.rootPath, "must-not-exist.txt")));
});

test("step limits survive review boundaries in looping graphs", async t => {
  const f = await fixture(t);
  const draft = graph([node("review", "human_review")]);
  draft.transitions.unshift({ id: "loop", from: "review", to: "review", priority: 10, guard: { type: "status", equals: "ok" } });
  const run = await f.runner.startStandalone(draft, { maxSteps: 2 });
  await f.runner.runUntilStopped(run.id);
  const waiting = (await f.runs.listNodeRuns(run.id)).at(-1)!;
  assert.equal((await f.runner.review(run.id, true, "", false, { waitingNodeRunId: waiting.id })).status, "blocked");
  assert.match((await f.runs.getRun(run.id))!.error!, /step limit/);
});

test("explicit step access overrides run policy, rejection prevents writes, and full access stays scoped to its step", async t => {
  const f = await fixture(t);
  const run = await f.runner.startStandalone(graph([
    node("auto", "file_write", { path: "auto.txt", contentTemplate: "allowed", approval: "never" }),
    node("ask", "file_write", { path: "denied.txt", contentTemplate: "denied", approval: "always" })
  ]), { accessMode: "ask" });
  assert.equal((await f.runner.runUntilStopped(run.id)).status, "waiting");
  assert.equal(await fs.readFile(path.join(run.workspace!.rootPath, "auto.txt"), "utf8"), "allowed");
  const pending = (await f.runs.listNodeRuns(run.id)).at(-1)!;
  assert.equal(pending.nodeId, "ask");
  const rejected = await f.runner.review(run.id, false, "", false, { approvalId: String(pending.output!.data.approvalId) });
  assert.equal(rejected.status, "failed");
  await assert.rejects(fs.access(path.join(run.workspace!.rootPath, "denied.txt")));
  const fullRun = await f.runner.startStandalone(graph([
    node("ask", "file_write", { path: "approved.txt", contentTemplate: "approved", approval: "always" })
  ]), { accessMode: "full" });
  assert.equal((await f.runner.runUntilStopped(fullRun.id)).status, "waiting");
  const approval = (await f.runs.listNodeRuns(fullRun.id)).at(-1)!;
  assert.equal((await f.runner.review(fullRun.id, true, "", false, { approvalId: String(approval.output!.data.approvalId) })).status, "done");
  assert.equal(await fs.readFile(path.join(fullRun.workspace!.rootPath, "approved.txt"), "utf8"), "approved");
});
