import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WorkflowEventStore } from "../src/workflows/WorkflowEventStore";
import { WorkflowRunStore } from "../src/workflows/WorkflowRunStore";
import { WorkflowRunner } from "../src/workflows/WorkflowRunner";
import { WorkflowStore } from "../src/workflows/WorkflowStore";
import { TaskStore } from "../src/tasks/TaskStore";
import { FsmEngine } from "../src/workflows/FsmEngine";
import { defaultTaskWorkflow } from "../src/workflows/defaultWorkflows";
import { NodeExecutorRegistry } from "../src/workflows/nodes/NodeExecutor";
import { EntryNodeExecutor } from "../src/workflows/nodes/EntryNodeExecutor";
import { TerminalNodeExecutor } from "../src/workflows/nodes/TerminalNodeExecutor";
import { runCommand } from "../src/utils/runCommand";
import { createWorkflowEventsController } from "../src/api/workflowControllers";
import { RuntimeManager } from "../src/app/RuntimeManager";

async function temporary(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-events-"));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}

test("event journal orders concurrent stores, isolates runs and resumes across restart", async t => {
  const root = await temporary(t);
  const a = new WorkflowEventStore(root), b = new WorkflowEventStore(root);
  const observed: number[] = [];
  const unsubscribe = b.subscribe("run", event => observed.push(event.sequence));
  await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).append({ runId: "run", type: "node.progress", level: "info", message: String(i) })));
  unsubscribe();
  await b.append({ runId: "another", type: "run.status", level: "info", message: "Other run" });
  const restarted = new WorkflowEventStore(root);
  await restarted.append({ runId: "run", type: "run.status", level: "info", message: "done" });
  assert.deepEqual(observed, Array.from({ length: 30 }, (_, i) => i + 1));
  assert.deepEqual((await restarted.list("run", 29)).events.map(event => event.sequence), [30, 31]);
  assert.equal((await restarted.list("another")).events.length, 1);
});

test("journal bounds output and repairs an incomplete final append without resetting sequence", async t => {
  const root = await temporary(t), store = new WorkflowEventStore(root);
  for (let i = 0; i < 270; i++) await store.append({ runId: "large", type: "node.output", level: "info", message: "stdout", detail: "x".repeat(9000) });
  const history = await store.list("large");
  assert.equal(history.lastSequence, 270); assert.ok(history.truncated); assert.ok(history.firstSequence > 1);
  assert.ok(history.events.every(event => event.detail!.length <= 8192));
  const file = path.join(root, "events", (await fs.readdir(path.join(root, "events")))[0]);
  assert.ok((await fs.stat(file)).size <= 2 * 1024 * 1024);
  await fs.appendFile(file, '{"sequence":');
  await new WorkflowEventStore(root).append({ runId: "large", type: "run.status", level: "info", message: "recovered" });
  assert.equal((await store.list("large", 270)).events[0].sequence, 271);
});

test("runner retains rapid progress, output, repeated invocations and the actual selected transitions", async t => {
  const root = await temporary(t), tasks = new TaskStore(root), definitions = new WorkflowStore(root), runs = new WorkflowRunStore(root);
  const definition = defaultTaskWorkflow();
  definition.id = "repeat-test";
  definition.transitions.push({ id: "retry", from: "execute", to: "execute", priority: 500, guard: { type: "event", equals: "again" } });
  await definitions.create(definition);
  let calls = 0;
  const runner = new WorkflowRunner(tasks, definitions, runs, new FsmEngine(), new NodeExecutorRegistry([
    new EntryNodeExecutor(), new TerminalNodeExecutor(), { type: "agent", execute: async context => {
      for (const label of ["file.read", "file.search", "file.write"]) context.onProgress?.({ phase: "tools", label, at: new Date().toISOString() });
      context.onProgress?.({ phase: "tools", label: "command", at: new Date().toISOString(), output: { stream: "stdout", text: "hello" } });
      return { status: "ok", event: ++calls === 1 ? "again" : "agent.completed", summary: "ok", data: {} };
    } }
  ]));
  const task = await tasks.create({ title: "Repeat", description: "test", workflowId: definition.id });
  const run = await runner.startTask(task.id);
  assert.equal((await runner.runUntilStopped(run.id)).status, "done");
  const history = (await runs.events.list(run.id)).events;
  assert.deepEqual(history.filter(event => event.type === "node.progress").map(event => event.message), ["file.read", "file.search", "file.write", "file.read", "file.search", "file.write"]);
  assert.equal(history.filter(event => event.type === "node.output").length, 2);
  assert.ok(history.filter(event => event.type === "node.progress").every(event => event.phase === "tools"));
  const attempts = (await runs.listNodeRuns(run.id)).filter(node => node.nodeId === "execute");
  assert.equal(attempts.length, 2); assert.notEqual(attempts[0].id, attempts[1].id);
  assert.deepEqual(attempts.map(node => node.transitionId), ["retry", "execute-done"]);
  assert.ok(history.some(event => event.type === "transition" && event.transitionId === "retry"));
  for (const attempt of attempts) {
    const rows = history.filter(event => event.nodeRunId === attempt.id);
    assert.ok(rows.findIndex(event => event.type === "node.output") < rows.findIndex(event => event.type === "node.completed"));
  }
});

test("command stdout streams before close and preserves split UTF-8 bytes", async () => {
  const observed: string[] = []; let completed = false;
  const script = "const b=Buffer.from('Привет 🌍');process.stdout.write(b.subarray(0,3));setTimeout(()=>process.stdout.write(b.subarray(3)),20);setTimeout(()=>process.stderr.write('warning'),80);setTimeout(()=>{},550)";
  const result = await runCommand(process.execPath, ["-e", script], os.tmpdir(), 3000, undefined, (stream, text) => {
    assert.equal(completed, false); observed.push(`${stream}:${text}`);
  }).then(result => { completed = true; return result; });
  assert.equal(result.stdout, "Привет 🌍"); assert.equal(result.stderr, "warning");
  assert.equal(observed.filter(text => text.startsWith("stdout:")).map(text => text.slice(7)).join(""), result.stdout);
  assert.ok(observed.includes("stderr:warning"));
});

test("SSE replays then follows a rebuilt store without duplicate sequences and closes its listener", async t => {
  const root = await temporary(t), store = new WorkflowEventStore(root);
  await store.append({ runId: "run", type: "run.status", level: "info", message: "queued" });
  const detail = { run: { id: "run" }, nodeRuns: [] };
  let inject = true;
  const runtime = { workflowRunStore: { getRun: async () => detail.run, events: store }, taskService: { getRunDetail: async () => {
    if (inject) { inject = false; await store.append({ runId: "run", type: "node.started", level: "info", message: "start during replay" }); }
    return detail;
  } } };
  const controller = createWorkflowEventsController({ getRuntime: () => runtime } as unknown as RuntimeManager);
  const chunks: string[] = [];
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, writableLength: 0, headersSent: false,
    status() { return this; }, set() { return this; }, flushHeaders() { this.headersSent = true; }, write(value: string) { chunks.push(value); }, end() { this.writableEnded = true; response.emit("close"); } });
  await controller({ params: { runId: "run" }, query: {}, get: () => undefined } as never, response as never, error => { throw error; });
  await new WorkflowEventStore(root).append({ runId: "run", type: "run.status", level: "info", message: "done" });
  const text = chunks.join("");
  assert.equal((text.match(/id: 1\n/g) ?? []).length, 1); assert.equal((text.match(/id: 2\n/g) ?? []).length, 1); assert.equal((text.match(/id: 3\n/g) ?? []).length, 1);
  response.end();
  const count = chunks.length;
  await store.append({ runId: "run", type: "run.status", level: "info", message: "later" });
  assert.equal(chunks.length, count);
});
