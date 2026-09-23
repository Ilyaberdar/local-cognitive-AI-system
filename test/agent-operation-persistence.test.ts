import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentLoopRunner } from "../src/agents/runtime/AgentLoopRunner";
import { LLMService } from "../src/llm/LLMService";
import { ProjectStore } from "../src/projects/ProjectStore";
import { SessionIndexStore } from "../src/session/SessionIndexStore";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { TaskStore } from "../src/tasks/TaskStore";
import { OperationExecutor } from "../src/tools/OperationExecutor";
import { ExecutionContext } from "../src/types";
import { WorkspaceResolver } from "../src/workspace/WorkspaceResolver";
import { WorkspaceSnapshot } from "../src/workspace/types";
import { FsmEngine } from "../src/workflows/FsmEngine";
import { WorkflowRunStore } from "../src/workflows/WorkflowRunStore";
import { WorkflowRunner } from "../src/workflows/WorkflowRunner";
import { WorkflowStore } from "../src/workflows/WorkflowStore";
import { CommandNodeExecutor } from "../src/workflows/nodes/CommandNodeExecutor";
import { EntryNodeExecutor } from "../src/workflows/nodes/EntryNodeExecutor";
import { NodeExecutorRegistry } from "../src/workflows/nodes/NodeExecutor";
import { TerminalNodeExecutor } from "../src/workflows/nodes/TerminalNodeExecutor";
import { WorkflowDefinition, WorkflowNode } from "../src/workflows/types";

const command = {
  executable: process.execPath,
  args: ["-e", 'require("fs").appendFileSync("effects.txt", "x")'],
  cwd: "."
};

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-effect-journal-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("agent stops on a result-journal failure after a command effect instead of retrying a new operation", async t => {
  const root = await temporaryRoot(t);
  const work = path.join(root, "work");
  await fs.mkdir(work);
  const settings = await new SessionSettingsStore({ baseDir: path.join(root, "settings") }, { providerId: "fixture", model: "fixture" }, {}).get("chat");
  settings.defaultAccessMode = "full";
  const workspace: WorkspaceSnapshot = { version: 1, kind: "project", rootPath: work, outputDir: work,
    allowedDirectories: [work], memoryScope: "project:fixture" };
  const context: ExecutionContext = { actor: { sessionId: "chat", channel: "http" }, memory: [], conversation: [],
    providerId: "fixture", activeTarget: settings.defaultTarget, sessionSettings: settings, workspace };
  const operations = new OperationExecutor(root);
  const persist = operations.store.save.bind(operations.store);
  let injected = false;
  operations.store.save = async operation => {
    if (!injected && operation.status === "completed") {
      injected = true;
      throw new Error("Simulated disk failure saving command result");
    }
    await persist(operation);
  };
  let modelCalls = 0;
  const llm = { generateObject: async () => {
    modelCalls++;
    // A model commonly retries on tool errors. The first command already ran,
    // so this second identical action must never even be requested.
    const data = { type: "tool_call", tool: "command.run", arguments: command };
    return { data, response: { provider: "fixture", model: "fixture", text: JSON.stringify(data) } };
  } } as unknown as LLMService;
  const outcome = await new AgentLoopRunner(llm, operations, root).run({
    id: "agent", input: "Append once", instructions: "", context, target: settings.defaultTarget
  });
  assert.equal(modelCalls, 1);
  assert.match(outcome.error!, /outcome is unknown/i);
  assert.equal(outcome.tools[0].metadata?.unknown, true);
  assert.equal(await fs.readFile(path.join(work, "effects.txt"), "utf8"), "x");
  const id = String(outcome.tools[0].metadata?.operationId);
  assert.equal((await operations.store.get(id))?.status, "unknown");
  const replay = await new OperationExecutor(root).execute({ id, agentRunId: "agent", workspace,
    accessMode: "full", tool: "command.run", arguments: command });
  assert.equal(replay.result?.metadata?.unknown, true);
  assert.equal(await fs.readFile(path.join(work, "effects.txt"), "utf8"), "x");
});

test("Workflow hard-stops after an effect even when result and unknown journal writes both fail", async t => {
  const root = await temporaryRoot(t);
  const operations = new OperationExecutor(root);
  const persist = operations.store.save.bind(operations.store);
  operations.store.save = async operation => {
    if (operation.status === "completed" || operation.status === "unknown") throw new Error("Simulated full disk");
    await persist(operation);
  };
  const nodes = (id: string, type: WorkflowNode["type"], config: Record<string, unknown> = {}): WorkflowNode =>
    ({ id, type, config, label: id, position: { x: 0, y: 0 } });
  const definition: WorkflowDefinition = {
    id: "journal-failure", name: "Journal failure", version: 1, entryNodeId: "entry",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: [nodes("entry", "entry"), nodes("command", "command", { ...command, approval: "inherit" }),
      nodes("done", "terminal", { runStatus: "done" })],
    transitions: [
      { id: "begin", from: "entry", to: "command", priority: 100, guard: { type: "status", equals: "ok" } },
      { id: "done", from: "command", to: "done", priority: 100, guard: { type: "status", equals: "ok" } },
      { id: "retry-failure", from: "command", to: "command", priority: 100, guard: { type: "status", equals: "failed" } },
      { id: "retry-blocked", from: "command", to: "command", priority: 100, guard: { type: "status", equals: "blocked" } }
    ]
  };
  const tasks = new TaskStore(path.join(root, "tasks"));
  const workflows = new WorkflowStore(path.join(root, "workflows"));
  const runStore = new WorkflowRunStore(path.join(root, "runs"));
  const resolver = new WorkspaceResolver({ appDataDir: root }, new ProjectStore(root), new SessionIndexStore(root));
  const workflow = await workflows.create(definition);
  const runner = new WorkflowRunner(tasks, workflows, runStore, new FsmEngine(), new NodeExecutorRegistry([
    new EntryNodeExecutor(), new TerminalNodeExecutor(),
    new CommandNodeExecutor({ accessMode: "full", allowedDirectories: [root], workspaceDir: root }, operations)
  ]), resolver);
  const task = await tasks.create({ title: "Append once", description: "", workflowId: workflow.id, accessMode: "full" });
  const started = await runner.startTask(task.id);
  const stopped = await runner.runUntilStopped(started.id);
  assert.equal(stopped.status, "blocked");
  assert.match(stopped.error!, /outcome is unknown/i);
  assert.equal((await runStore.listNodeRuns(started.id)).filter(node => node.nodeId === "command").length, 1);
  const work = started.workspace!.rootPath;
  assert.equal(await fs.readFile(path.join(work, "effects.txt"), "utf8"), "x");
  const id = String(stopped.state.activeOperationId);
  const agentRunId = String(stopped.state.activeAgentRunId);
  // No later journal write succeeded; executing is itself sufficient to fence
  // the effect when a fresh executor recovers after disk access is restored.
  assert.equal((await operations.store.get(id))?.status, "executing");
  const stillUnavailable = await operations.execute({ id, agentRunId, workspace: started.workspace!,
    accessMode: "full", tool: "command.run", arguments: command, resumePrepared: true });
  assert.equal(stillUnavailable.result?.metadata?.unknown, true);
  assert.equal((await operations.store.get(id))?.status, "executing");
  const recovered = await new OperationExecutor(root).execute({ id, agentRunId, workspace: started.workspace!,
    accessMode: "full", tool: "command.run", arguments: command, resumePrepared: true });
  assert.equal(recovered.result?.metadata?.unknown, true);
  assert.equal(await fs.readFile(path.join(work, "effects.txt"), "utf8"), "x");
});
