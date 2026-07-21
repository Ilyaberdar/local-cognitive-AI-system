import { TaskStore } from "../tasks/TaskStore";
import { Task } from "../tasks/types";
import { FsmEngine } from "./FsmEngine";
import { NodeExecutorRegistry } from "./nodes/NodeExecutor";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowStore } from "./WorkflowStore";
import {
  NodeResult,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRun
} from "./types";

export class WorkflowRunner {
  constructor(
    private readonly taskStore: TaskStore,
    private readonly workflowStore: WorkflowStore,
    private readonly runStore: WorkflowRunStore,
    private readonly fsmEngine: FsmEngine,
    private readonly executors: NodeExecutorRegistry
  ) {}

  async startTask(taskId: string): Promise<WorkflowRun> {
    const task = await this.requireTask(taskId);
    const workflow = await this.requireWorkflow(task);
    const validation = this.workflowStore.validate(workflow);

    if (!validation.ok) {
      throw new Error(`Cannot start invalid workflow: ${validation.errors.join("; ")}`);
    }

    const run = await this.runStore.createRun({ task, workflow });
    await this.taskStore.setStatus(task.id, "in_progress", {
      workflowVersion: workflow.version,
      lastRunId: run.id
    });

    return run;
  }

  async runNextStep(runId: string): Promise<WorkflowRun> {
    const run = await this.requireRun(runId);

    if (["done", "failed", "cancelled", "waiting", "blocked"].includes(run.status)) {
      return run;
    }

    const task = await this.requireTask(run.taskId);
    const workflow = await this.requireWorkflow(task, run.workflowVersion);
    const node = this.requireNode(workflow, run.currentNodeId);
    const previousNodeRuns = await this.runStore.listNodeRuns(run.id);
    const startedAt = new Date().toISOString();
    const nodeRun = await this.runStore.appendNodeRun({
      runId: run.id,
      taskId: task.id,
      workflowId: workflow.id,
      nodeId: node.id,
      status: "running",
      input: {
        taskId: task.id,
        nodeConfig: node.config
      },
      startedAt
    });

    await this.runStore.updateRun(run.id, { status: "running" });
    await this.taskStore.setStatus(task.id, "in_progress");

    try {
      const executor = this.executors.get(node.type);
      const result = await executor.execute({
        task,
        workflow,
        run,
        node,
        previousNodeRuns
      });

      await this.runStore.updateNodeRun(nodeRun.id, {
        status: result.status === "failed" ? "failed" : "ok",
        output: result,
        completedAt: new Date().toISOString()
      });

      return this.advanceAfterNode(run.id, task, workflow, node, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      const result: NodeResult = {
        status: "failed",
        event: "node.failed",
        summary: message,
        data: {},
        error: message
      };

      await this.runStore.updateNodeRun(nodeRun.id, {
        status: "failed",
        output: result,
        error: message,
        completedAt: new Date().toISOString()
      });

      return this.advanceAfterNode(run.id, task, workflow, node, result);
    }
  }

  async runUntilStopped(runId: string, maxSteps = 25): Promise<WorkflowRun> {
    let run = await this.requireRun(runId);

    for (let step = 0; step < maxSteps; step += 1) {
      if (["done", "failed", "cancelled", "waiting", "blocked"].includes(run.status)) {
        return run;
      }

      run = await this.runNextStep(run.id);
    }

    const updated = await this.runStore.updateRun(run.id, {
      status: "blocked",
      error: `Workflow exceeded max step limit (${maxSteps}).`
    });
    return updated ?? run;
  }

  async cancel(runId: string): Promise<WorkflowRun> {
    const run = await this.requireRun(runId);
    const updated = await this.runStore.updateRun(run.id, {
      status: "cancelled",
      completedAt: new Date().toISOString()
    });

    await this.taskStore.setStatus(run.taskId, "cancelled");
    return updated ?? run;
  }

  private async advanceAfterNode(
    runId: string,
    task: Task,
    workflow: WorkflowDefinition,
    node: WorkflowNode,
    result: NodeResult
  ): Promise<WorkflowRun> {
    const latestRun = await this.requireRun(runId);
    const state = {
      ...latestRun.state,
      nodeResults: {
        ...(readRecord(latestRun.state.nodeResults)),
        [node.id]: {
          status: result.status,
          event: result.event,
          summary: result.summary,
          data: result.data,
          artifacts: result.artifacts,
          error: result.error
        }
      }
    };

    if (node.type === "terminal") {
      const runStatus = result.data.runStatus === "failed" ? "failed" : "done";
      const updated = await this.runStore.updateRun(runId, {
        status: runStatus,
        state,
        completedAt: new Date().toISOString()
      });

      await this.taskStore.setStatus(task.id, runStatus);
      return updated ?? latestRun;
    }

    if (result.status === "needs_input") {
      const updated = await this.runStore.updateRun(runId, {
        status: "waiting",
        state
      });
      await this.taskStore.setStatus(task.id, "waiting");
      return updated ?? latestRun;
    }

    const transition = this.fsmEngine.selectNextTransition(workflow, node, result, state);

    if (!transition) {
      const status = result.status === "failed" ? "failed" : "blocked";
      const updated = await this.runStore.updateRun(runId, {
        status,
        state,
        error: `No transition matched from node "${node.id}" after event "${result.event}".`,
        completedAt: status === "failed" ? new Date().toISOString() : undefined
      });
      await this.taskStore.setStatus(task.id, status);
      return updated ?? latestRun;
    }

    return (await this.runStore.updateRun(runId, {
      status: "queued",
      currentNodeId: transition.to,
      state
    })) ?? latestRun;
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.taskStore.get(taskId);

    if (!task) {
      throw new Error(`Task "${taskId}" was not found.`);
    }

    return task;
  }

  private async requireWorkflow(task: Task, version?: number): Promise<WorkflowDefinition> {
    const workflow = await this.workflowStore.get(task.workflowId, version ?? task.workflowVersion);

    if (!workflow) {
      throw new Error(`Workflow "${task.workflowId}" was not found.`);
    }

    return workflow;
  }

  private async requireRun(runId: string): Promise<WorkflowRun> {
    const run = await this.runStore.getRun(runId);

    if (!run) {
      throw new Error(`Workflow run "${runId}" was not found.`);
    }

    return run;
  }

  private requireNode(workflow: WorkflowDefinition, nodeId: string | undefined): WorkflowNode {
    const node = workflow.nodes.find((item) => item.id === nodeId);

    if (!node) {
      throw new Error(`Workflow node "${nodeId ?? "unknown"}" was not found.`);
    }

    return node;
  }
}

const readRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
