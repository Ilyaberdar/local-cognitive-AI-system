import { withFileLock } from "../utils/fileStore";
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

const stopped = (run: WorkflowRun): boolean => ["done", "failed", "cancelled", "waiting", "blocked"].includes(run.status);

export class WorkflowRunner {
  private static readonly steps = new Map<string, Promise<WorkflowRun>>();
  private static readonly loops = new Map<string, Promise<WorkflowRun>>();
  private static readonly controllers = new Map<string, AbortController>();
  constructor(
    private readonly taskStore: TaskStore,
    private readonly workflowStore: WorkflowStore,
    private readonly runStore: WorkflowRunStore,
    private readonly fsmEngine: FsmEngine,
    private readonly executors: NodeExecutorRegistry
  ) {}

  async startTask(taskId: string): Promise<WorkflowRun> {
    return withFileLock(`workflow-task:${taskId}`, async () => {
      const task = await this.requireTask(taskId);
      if (task.lastRunId) {
        const existing = await this.runStore.getRun(task.lastRunId);
        if (existing && !["done", "failed", "cancelled", "blocked"].includes(existing.status)) return existing;
      }
      const workflow = await this.requireWorkflow(task);
      const validation = this.workflowStore.validate(workflow);
      if (!validation.ok) throw new Error(`Cannot start invalid workflow: ${validation.errors.join("; ")}`);
      const run = await this.runStore.createRun({ task, workflow });
      await this.taskStore.setStatus(task.id, "in_progress", { workflowVersion: workflow.version, lastRunId: run.id });
      return run;
    });
  }

  runNextStep(runId: string): Promise<WorkflowRun> {
    const existing = WorkflowRunner.steps.get(runId);
    if (existing) return existing;
    const operation = this.executeStep(runId).finally(() => {
      WorkflowRunner.steps.delete(runId);
      WorkflowRunner.controllers.delete(runId);
    });
    WorkflowRunner.steps.set(runId, operation);
    return operation;
  }

  private async executeStep(runId: string): Promise<WorkflowRun> {
    const controller = new AbortController();
    WorkflowRunner.controllers.set(runId, controller);
    const prepared = await withFileLock(`workflow-run:${runId}`, async () => {
      const run = await this.requireRun(runId);
      if (stopped(run)) return { run };
      if (controller.signal.aborted) return { run: { ...run, status: "cancelled" as const } };
      const task = await this.requireTask(run.taskId);
      const workflow = await this.workflowForRun(run);
      const node = this.requireNode(workflow, run.currentNodeId);
      const previousNodeRuns = await this.runStore.listNodeRuns(run.id);
      const nodeRun = await this.runStore.appendNodeRun({
        runId, taskId: task.id, workflowId: workflow.id, nodeId: node.id, status: "running",
        input: { taskId: task.id, nodeConfig: node.config }, startedAt: new Date().toISOString()
      });
      await this.runStore.updateRun(runId, { status: "running" });
      await this.taskStore.setStatus(task.id, "in_progress");
      return { run, task, workflow, node, previousNodeRuns, nodeRun };
    });
    if (!prepared.nodeRun) return prepared.run;
    const { run, task, workflow, node, previousNodeRuns, nodeRun } = prepared;
    let result: NodeResult;
    try {
      controller.signal.throwIfAborted();
      result = await this.executors.get(node.type).execute({
        task, workflow, run, node, previousNodeRuns, signal: controller.signal,
        approval: run.state.approvedNodeId === node.id ? readRecord(run.state.approvedOperation) : undefined
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      result = { status: "failed", event: "node.failed", summary: message, data: {}, error: message };
    }
    await this.runStore.updateNodeRun(nodeRun.id, {
      status: controller.signal.aborted ? "cancelled" : result.status === "needs_input" ? "waiting" : result.status === "failed" ? "failed" : "ok",
      output: result, error: result.error, completedAt: new Date().toISOString()
    });
    return this.advanceAfterNode(runId, task, workflow, node, result);
  }

  runUntilStopped(runId: string, maxSteps = 25): Promise<WorkflowRun> {
    const existing = WorkflowRunner.loops.get(runId);
    if (existing) return existing;
    const operation = this.executeUntilStopped(runId, maxSteps).finally(() => WorkflowRunner.loops.delete(runId));
    WorkflowRunner.loops.set(runId, operation);
    return operation;
  }

  private async executeUntilStopped(runId: string, maxSteps: number): Promise<WorkflowRun> {
    let run = await this.requireRun(runId);
    for (let step = 0; step < maxSteps; step += 1) {
      if (stopped(run)) return run;
      run = await this.runNextStep(run.id);
    }
    return withFileLock(`workflow-run:${runId}`, async () => {
      run = await this.requireRun(runId);
      if (stopped(run)) return run;
      const updated = await this.runStore.updateRun(runId, {
        status: "blocked", error: `Workflow exceeded max step limit (${maxSteps}).`
      });
      await this.taskStore.setStatus(run.taskId, "blocked");
      return updated ?? run;
    });
  }

  async cancel(runId: string): Promise<WorkflowRun> {
    WorkflowRunner.controllers.get(runId)?.abort();
    return withFileLock(`workflow-run:${runId}`, async () => {
      const run = await this.requireRun(runId);
      if (["done", "failed", "cancelled"].includes(run.status)) return run;
      const updated = await this.runStore.updateRun(runId, { status: "cancelled", completedAt: new Date().toISOString() });
      await this.taskStore.setStatus(run.taskId, "cancelled");
      return updated ?? run;
    });
  }

  async review(runId: string, approved: boolean, comment = "", background = false): Promise<WorkflowRun> {
    const reviewed = await withFileLock(`workflow-run:${runId}`, async () => {
      const run = await this.requireRun(runId);
      if (run.status !== "waiting") throw new Error("Only a waiting run can be reviewed.");
      const task = await this.requireTask(run.taskId);
      const workflow = await this.workflowForRun(run);
      const node = this.requireNode(workflow, run.currentNodeId);
      const waiting = readRecord(readRecord(run.state.nodeResults)[node.id]);
      const permissionRequired = readRecord(waiting.data).permissionRequired === true;
      const nodeRuns = await this.runStore.listNodeRuns(runId);
      const waitingNodeRun = [...nodeRuns].reverse().find((item) => item.nodeId === node.id && item.status === "waiting");
      if (permissionRequired && approved) {
        // Freeze the operation shown to the user; task edits must not change what approval executes.
        if (waitingNodeRun?.output) await this.runStore.updateNodeRun(waitingNodeRun.id, {
          status: "ok",
          output: { ...waitingNodeRun.output, status: "ok", event: "approval.approved",
            summary: comment.trim() || "Approved by user.", data: { ...waitingNodeRun.output.data, approved: true } },
          completedAt: new Date().toISOString()
        });
        return (await this.runStore.updateRun(runId, {
          status: "queued", state: { ...run.state, approvedNodeId: node.id, approvedOperation: readRecord(waiting.data) }
        }))!;
      }
      const result: NodeResult = {
        status: approved ? "ok" : "failed",
        event: node.type === "human_review" ? `human_review.${approved ? "approved" : "rejected"}` : "approval.rejected",
        summary: comment.trim() || (approved ? "Approved by user." : "Rejected by user."),
        data: { approved, comment: comment.trim() }, error: approved ? undefined : "Rejected by user."
      };
      if (waitingNodeRun) await this.runStore.updateNodeRun(waitingNodeRun.id, {
        status: approved ? "ok" : "failed", output: result, completedAt: new Date().toISOString()
      });
      return this.advanceUnlocked(runId, task, workflow, node, result);
    });
    if (stopped(reviewed)) return reviewed;
    if (background) { this.runInBackground(runId); return reviewed; }
    return this.runUntilStopped(runId);
  }

  runInBackground(runId: string): void {
    void this.runUntilStopped(runId).catch(async (error) => {
      await withFileLock(`workflow-run:${runId}`, async () => {
        const run = await this.requireRun(runId);
        if (stopped(run)) return;
        await this.runStore.updateRun(runId, { status: "failed", error: error instanceof Error ? error.message : "Workflow failed", completedAt: new Date().toISOString() });
        await this.taskStore.setStatus(run.taskId, "failed");
      });
    }).catch((error) => { console.error("Could not persist workflow failure", error); });
  }

  private async workflowForRun(run: WorkflowRun): Promise<WorkflowDefinition> {
    const workflow = run.workflowSnapshot ?? await this.workflowStore.get(run.workflowId, run.workflowVersion);
    if (!workflow) throw new Error(`Workflow "${run.workflowId}" was not found.`);
    return workflow;
  }

  private async advanceAfterNode(
    runId: string,
    task: Task,
    workflow: WorkflowDefinition,
    node: WorkflowNode,
    result: NodeResult
  ): Promise<WorkflowRun> {
    return withFileLock(`workflow-run:${runId}`, () => this.advanceUnlocked(runId, task, workflow, node, result));
  }

  private async advanceUnlocked(runId: string, task: Task, workflow: WorkflowDefinition, node: WorkflowNode, result: NodeResult): Promise<WorkflowRun> {
    const latestRun = await this.requireRun(runId);
    if (["done", "failed", "cancelled"].includes(latestRun.status)) return latestRun;
    const state = {
      ...latestRun.state,
      approvedNodeId: undefined,
      approvedOperation: undefined,
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
