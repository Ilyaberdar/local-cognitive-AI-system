import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import { CognitiveEngine } from "../src/core/CognitiveEngine";
import { TaskStore } from "../src/tasks/TaskStore";
import { FsmEngine } from "../src/workflows/FsmEngine";
import { defaultTaskWorkflow } from "../src/workflows/defaultWorkflows";
import { AgentNodeExecutor } from "../src/workflows/nodes/AgentNodeExecutor";
import { EntryNodeExecutor } from "../src/workflows/nodes/EntryNodeExecutor";
import {
  NodeExecutionContext,
  NodeExecutor,
  NodeExecutorRegistry
} from "../src/workflows/nodes/NodeExecutor";
import { TerminalNodeExecutor } from "../src/workflows/nodes/TerminalNodeExecutor";
import { WorkflowRunner } from "../src/workflows/WorkflowRunner";
import { WorkflowRunStore } from "../src/workflows/WorkflowRunStore";
import { WorkflowStore } from "../src/workflows/WorkflowStore";
import { NodeResult } from "../src/workflows/types";

class FakeAgentExecutor implements NodeExecutor {
  readonly type = "agent" as const;

  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    return {
      status: "ok",
      event: "agent.completed",
      summary: `processed:${context.task.title}`,
      data: {
        response: "done"
      }
    };
  }
}

const makeTmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), "lcai-workflows-"));

test("task queue orders queued work by priority, then FIFO", async () => {
  const root = await makeTmpDir();
  const taskStore = new TaskStore(path.join(root, "tasks"));
  const firstNormal = await taskStore.create({
    title: "First normal",
    description: "first",
    workflowId: "workflow-a",
    priority: "normal"
  });
  const high = await taskStore.create({
    title: "High",
    description: "high",
    workflowId: "workflow-a",
    priority: "high"
  });
  const secondNormal = await taskStore.create({
    title: "Second normal",
    description: "second",
    workflowId: "workflow-a",
    priority: "normal"
  });

  assert.equal(firstNormal.status, "todo");
  await taskStore.setStatus(firstNormal.id, "queued");
  await taskStore.setStatus(high.id, "queued");

  const queued = await taskStore.listQueued();
  assert.deepEqual(queued.map((task) => task.id), [high.id, firstNormal.id, secondNormal.id]);
});

test("task store deletes a task", async () => {
  const root = await makeTmpDir();
  const taskStore = new TaskStore(path.join(root, "tasks"));
  const task = await taskStore.create({
    title: "Delete me",
    description: "Temporary task",
    workflowId: "workflow-a"
  });

  assert.equal(await taskStore.delete(task.id), true);
  assert.equal(await taskStore.get(task.id), null);
  assert.equal(await taskStore.delete(task.id), false);
});

test("fsm engine selects the highest-priority matching transition", () => {
  const workflow = defaultTaskWorkflow();
  const engine = new FsmEngine();
  const node = workflow.nodes.find((item) => item.id === "execute");

  assert.ok(node);
  const transition = engine.selectNextTransition(
    workflow,
    node,
    {
      status: "ok",
      event: "agent.completed",
      summary: "done",
      data: {}
    },
    {}
  );

  assert.equal(transition?.id, "execute-done");
});

test("agent node forwards its provider and model overrides to the cognitive engine", async () => {
  const root = await makeTmpDir();
  const taskStore = new TaskStore(path.join(root, "tasks"));
  const task = await taskStore.create({
    title: "Use explicit target",
    description: "Execute with the configured model.",
    workflowId: defaultTaskWorkflow().id
  });
  const workflow = defaultTaskWorkflow();
  const node = workflow.nodes.find((item) => item.id === "execute");
  let receivedRequest: Record<string, unknown> | undefined;
  const engine = {
    process: async (request: Record<string, unknown>) => {
      receivedRequest = request;
      return {
        input: request.input,
        mode: "code",
        providerId: "ollama",
        result: {
          response: "completed",
          provider: "ollama",
          model: "qwen3:8b"
        },
        tools: [],
        memory: [],
        conversationSize: 0,
        sessionSettings: {
          defaultTarget: { providerId: "lmstudio", model: "fallback" }
        }
      };
    }
  } as unknown as CognitiveEngine;

  assert.ok(node);
  node.config.providerId = "ollama";
  node.config.model = "qwen3:8b";
  const result = await new AgentNodeExecutor(engine).execute({
    task,
    workflow,
    node,
    previousNodeRuns: [],
    run: {
      id: "run-target",
      taskId: task.id,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      status: "running",
      currentNodeId: node.id,
      state: {},
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    }
  });

  assert.equal(receivedRequest?.providerId, "ollama");
  assert.equal(receivedRequest?.model, "qwen3:8b");
  assert.deepEqual(result.data.target, {
    providerId: "ollama",
    model: "qwen3:8b"
  });

  delete node.config.model;
  await new AgentNodeExecutor(engine, { ollama: "llama3.2" }).execute({
    task,
    workflow,
    node,
    previousNodeRuns: [],
    run: {
      id: "run-provider-default",
      taskId: task.id,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      status: "running",
      currentNodeId: node.id,
      state: {},
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    }
  });
  assert.equal(receivedRequest?.model, "llama3.2");
});

test("workflow runner executes a task through entry, agent, and terminal nodes", async () => {
  const root = await makeTmpDir();
  const taskStore = new TaskStore(path.join(root, "tasks"));
  const workflowStore = new WorkflowStore(path.join(root, "workflows"));
  const runStore = new WorkflowRunStore(path.join(root, "workflows"));
  const runner = new WorkflowRunner(
    taskStore,
    workflowStore,
    runStore,
    new FsmEngine(),
    new NodeExecutorRegistry([
      new EntryNodeExecutor(),
      new FakeAgentExecutor(),
      new TerminalNodeExecutor()
    ])
  );
  const task = await taskStore.create({
    title: "Run workflow",
    description: "Execute the default flow.",
    workflowId: defaultTaskWorkflow().id,
    priority: "high"
  });

  await taskStore.setStatus(task.id, "queued");
  const run = await runner.startTask(task.id);
  const finalRun = await runner.runUntilStopped(run.id);
  const finalTask = await taskStore.get(task.id);
  const nodeRuns = await runStore.listNodeRuns(run.id);

  assert.equal(finalRun.status, "done");
  assert.equal(finalTask?.status, "done");
  assert.deepEqual(nodeRuns.map((nodeRun) => nodeRun.nodeId), ["entry", "execute", "done"]);
  assert.equal(nodeRuns[1].output?.summary, "processed:Run workflow");
});
