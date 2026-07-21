import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import { Task } from "../src/tasks/types";
import { TaskStore } from "../src/tasks/TaskStore";
import { defaultTaskWorkflow } from "../src/workflows/defaultWorkflows";
import { FsmEngine } from "../src/workflows/FsmEngine";
import { CommandNodeExecutor } from "../src/workflows/nodes/CommandNodeExecutor";
import { DecisionNodeExecutor } from "../src/workflows/nodes/DecisionNodeExecutor";
import { FileSearchNodeExecutor } from "../src/workflows/nodes/FileSearchNodeExecutor";
import { NodeExecutionContext } from "../src/workflows/nodes/NodeExecutor";
import { NodeExecutorRegistry } from "../src/workflows/nodes/NodeExecutor";
import { EntryNodeExecutor } from "../src/workflows/nodes/EntryNodeExecutor";
import { SaveFileNodeExecutor } from "../src/workflows/nodes/SaveFileNodeExecutor";
import { WebSearchNodeExecutor } from "../src/workflows/nodes/WebSearchNodeExecutor";
import { TerminalNodeExecutor } from "../src/workflows/nodes/TerminalNodeExecutor";
import { WorkflowRunner } from "../src/workflows/WorkflowRunner";
import { WorkflowRunStore } from "../src/workflows/WorkflowRunStore";
import { WorkflowStore } from "../src/workflows/WorkflowStore";
import { WorkflowDefinition, WorkflowNode, WorkflowRun } from "../src/workflows/types";

const makeContext = (
  node: WorkflowNode,
  state: Record<string, unknown> = {}
): NodeExecutionContext => {
  const task: Task = {
    id: "task-tools",
    title: "Inspect workflow runtime",
    description: "Find the marker and save a report.",
    workflowId: "workflow-tools",
    workflowVersion: 1,
    priority: "normal",
    status: "in_progress",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  const workflow = defaultTaskWorkflow();
  const run: WorkflowRun = {
    id: "run-tools",
    taskId: task.id,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    status: "running",
    currentNodeId: node.id,
    state,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  return { task, workflow, run, node, previousNodeRuns: [] };
};

test("file search returns bounded structured matches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-file-search-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "sample.ts"), "const marker = 'workflow-needle';\n", "utf8");
  await fs.writeFile(path.join(root, "ignored.md"), "workflow-needle\n", "utf8");
  const executor = new FileSearchNodeExecutor({
    accessMode: "restricted",
    allowedDirectories: [root],
    workspaceDir: root
  });
  const result = await executor.execute(makeContext({
    id: "search",
    type: "file_search",
    label: "Search",
    position: { x: 0, y: 0 },
    config: {
      root: ".",
      queryTemplate: "workflow-needle",
      include: ["**/*.ts"],
      maxResults: 10
    }
  }));

  assert.equal(result.status, "ok");
  assert.deepEqual(result.data.results, [{
    path: "src/sample.ts",
    line: 1,
    text: "const marker = 'workflow-needle';"
  }]);
});

test("save file renders previous node output and enforces explicit full access", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-save-node-"));
  const executor = new SaveFileNodeExecutor({
    accessMode: "restricted",
    allowedDirectories: [root],
    outputDir: root
  });
  const baseNode: WorkflowNode = {
    id: "save",
    type: "file_write",
    label: "Save",
    position: { x: 0, y: 0 },
    config: {
      path: "report.md",
      contentTemplate: "{{nodes.writer.data.response}}"
    }
  };
  const state = {
    nodeResults: {
      writer: { status: "ok", event: "agent.completed", summary: "done", data: { response: "# Report\n" } }
    }
  };

  const blocked = await executor.execute(makeContext(baseNode, state));
  assert.equal(blocked.status, "needs_input");

  baseNode.config.access = "full";
  const saved = await executor.execute(makeContext(baseNode, state));
  assert.equal(saved.status, "ok");
  assert.equal(await fs.readFile(path.join(root, "report.md"), "utf8"), "# Report\n");
  assert.equal(saved.data.bytes, 9);
});

test("command and decision nodes expose branchable outputs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-command-node-"));
  const command = new CommandNodeExecutor({
    accessMode: "restricted",
    allowedDirectories: [root],
    workspaceDir: root
  });
  const commandResult = await command.execute(makeContext({
    id: "command",
    type: "command",
    label: "Command",
    position: { x: 0, y: 0 },
    config: {
      access: "full",
      executable: process.execPath,
      args: ["-e", "console.log('workflow-ok')"],
      cwd: "."
    }
  }));
  assert.equal(commandResult.status, "ok");
  assert.equal(commandResult.data.exitCode, 0);
  assert.match(String(commandResult.data.stdout), /workflow-ok/);

  const decision = await new DecisionNodeExecutor().execute(makeContext({
    id: "decision",
    type: "decision",
    label: "Decision",
    position: { x: 0, y: 0 },
    config: { path: "nodes.command.data.exitCode", operator: "eq", value: 0 }
  }, {
    nodeResults: {
      command: { status: "ok", event: "command.completed", summary: "ok", data: commandResult.data }
    }
  }));

  assert.equal(decision.event, "decision.true");
  assert.equal(decision.data.matched, true);
});

test("web search normalizes SearXNG results", async () => {
  const executor = new WebSearchNodeExecutor({
    searxngUrl: "http://search.local",
    fetchImpl: async () => new Response(JSON.stringify({
      results: [{ title: "Result", url: "https://example.com", content: "Snippet" }]
    }), { status: 200, headers: { "content-type": "application/json" } })
  });
  const result = await executor.execute(makeContext({
    id: "web",
    type: "web_search",
    label: "Web",
    position: { x: 0, y: 0 },
    config: { provider: "searxng", queryTemplate: "{{task.title}}", limit: 3 }
  }));

  assert.equal(result.status, "ok");
  assert.deepEqual(result.data.results, [{
    title: "Result",
    url: "https://example.com",
    snippet: "Snippet"
  }]);
});

test("workflow runner passes structured outputs through search, save, command, and decision nodes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-tool-pipeline-"));
  const workspace = path.join(root, "workspace");
  const output = path.join(root, "output");
  await fs.mkdir(workspace);
  await fs.mkdir(output);
  await fs.writeFile(path.join(workspace, "input.txt"), "pipeline-marker\n", "utf8");
  const now = new Date(0).toISOString();
  const workflow: WorkflowDefinition = {
    id: "tool-pipeline",
    name: "Tool Pipeline",
    version: 1,
    entryNodeId: "entry",
    nodes: [
      { id: "entry", type: "entry", label: "Entry", position: { x: 0, y: 0 }, config: {} },
      {
        id: "search",
        type: "file_search",
        label: "Search",
        position: { x: 200, y: 0 },
        config: { root: ".", queryTemplate: "pipeline-marker", include: ["**/*.txt"] }
      },
      {
        id: "save",
        type: "file_write",
        label: "Save",
        position: { x: 400, y: 0 },
        config: {
          access: "full",
          path: "pipeline.json",
          contentTemplate: "{{nodes.search.data.results}}"
        }
      },
      {
        id: "command",
        type: "command",
        label: "Command",
        position: { x: 600, y: 0 },
        config: {
          access: "full",
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: "."
        }
      },
      {
        id: "decision",
        type: "decision",
        label: "Decision",
        position: { x: 800, y: 0 },
        config: { path: "nodes.command.data.exitCode", operator: "eq", value: 0 }
      },
      { id: "done", type: "terminal", label: "Done", position: { x: 1000, y: 0 }, config: { runStatus: "done" } },
      { id: "failed", type: "terminal", label: "Failed", position: { x: 1000, y: 150 }, config: { runStatus: "failed" } }
    ],
    transitions: [
      { id: "entry-search", from: "entry", to: "search", priority: 100, guard: { type: "always" } },
      { id: "search-save", from: "search", to: "save", priority: 100, guard: { type: "status", equals: "ok" } },
      { id: "save-command", from: "save", to: "command", priority: 100, guard: { type: "status", equals: "ok" } },
      { id: "command-decision", from: "command", to: "decision", priority: 100, guard: { type: "always" } },
      { id: "decision-done", from: "decision", to: "done", priority: 100, guard: { type: "event", equals: "decision.true" } },
      { id: "decision-failed", from: "decision", to: "failed", priority: 90, guard: { type: "event", equals: "decision.false" } }
    ],
    createdAt: now,
    updatedAt: now
  };
  const taskStore = new TaskStore(path.join(root, "tasks"));
  const workflowStore = new WorkflowStore(path.join(root, "workflows"));
  const runStore = new WorkflowRunStore(path.join(root, "runs"));
  await workflowStore.create(workflow);
  const task = await taskStore.create({
    title: "Tool pipeline",
    description: "Exercise structured outputs.",
    workflowId: workflow.id
  });
  const runner = new WorkflowRunner(
    taskStore,
    workflowStore,
    runStore,
    new FsmEngine(),
    new NodeExecutorRegistry([
      new EntryNodeExecutor(),
      new FileSearchNodeExecutor({ accessMode: "restricted", allowedDirectories: [workspace], workspaceDir: workspace }),
      new SaveFileNodeExecutor({ accessMode: "restricted", allowedDirectories: [output], outputDir: output }),
      new CommandNodeExecutor({ accessMode: "restricted", allowedDirectories: [workspace], workspaceDir: workspace }),
      new DecisionNodeExecutor(),
      new TerminalNodeExecutor()
    ])
  );

  const run = await runner.startTask(task.id);
  const completed = await runner.runUntilStopped(run.id);
  const saved = await fs.readFile(path.join(output, "pipeline.json"), "utf8");

  assert.equal(completed.status, "done");
  assert.match(saved, /pipeline-marker/);
  assert.equal(
    (completed.state.nodeResults as Record<string, { data: Record<string, unknown> }>).decision.data.matched,
    true
  );
});
