import { withFileLock } from "../utils/fileStore";
import { randomUUID } from "crypto";
import { WorkspaceResolver } from "../workspace/WorkspaceResolver";
import { SessionSettingsStore } from "../session/SessionSettingsStore";
import { TaskStore } from "../tasks/TaskStore";
import { Task, TaskStatus } from "../tasks/types";
import { FsmEngine } from "./FsmEngine";
import { NodeExecutorRegistry } from "./nodes/NodeExecutor";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowStore } from "./WorkflowStore";
import { buildAgentInput } from "./template";
import { validateRunOptions } from "./runOptions";
import { ProviderTarget } from "../types";
import {
  NodeResult,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunConflictError,
  WorkflowRunOptions
} from "./types";

const stopped = (run: WorkflowRun): boolean => ["done", "failed", "cancelled", "waiting", "blocked", "interrupted"].includes(run.status);

export interface WorkflowReviewIdentity { approvalId?: string; waitingNodeRunId?: string; }

export class WorkflowRunner {
  private static readonly steps = new Map<string, Promise<WorkflowRun>>();
  private static readonly loops = new Map<string, Promise<WorkflowRun>>();
  private static readonly controllers = new Map<string, AbortController>();
  constructor(
    private readonly taskStore: TaskStore,
    private readonly workflowStore: WorkflowStore,
    private readonly runStore: WorkflowRunStore,
    private readonly fsmEngine: FsmEngine,
    private readonly executors: NodeExecutorRegistry,
    private readonly workspaceResolver?: Pick<WorkspaceResolver, "forTask" | "validate"> & Partial<Pick<WorkspaceResolver, "forWorkflowRun">>,
    private readonly sessionSettingsStore?: Pick<SessionSettingsStore, "get">
  ) {}

  /** Recovery is explicit: a previous process's in-flight effects are never replayed at startup. */
  async recoverInterruptedRuns(): Promise<void> {
    for (const candidate of await this.runStore.listRuns()) {
      if (WorkflowRunner.controllers.has(candidate.id) || !["running", "queued", "waiting"].includes(candidate.status)) continue;
      await withFileLock(`workflow-run:${candidate.id}`, async () => {
        const run = await this.requireRun(candidate.id);
        if (WorkflowRunner.controllers.has(run.id)) return;
        if (this.workspaceResolver && (!run.workspace || !run.executionSnapshot)) {
          await this.blockRun(run, "This legacy run has no workspace snapshot. Cancel it and start a new run with a selected project or managed task workspace.");
        } else if (run.status === "running") {
          await this.runStore.updateRun(run.id, { status: "interrupted", error: "Execution was interrupted. Resume to recover its saved operation; uncertain effects will not be repeated." });
          await this.setTaskStatus(run.taskId, "interrupted");
        }
      });
    }
  }

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
      const id = randomUUID();
      const executionSessionId = `workflow-${id}`;
      const workspace = await this.workspaceResolver?.forTask(task);
      const settings = await this.sessionSettingsStore?.get(executionSessionId);
      const nodeTargets: Record<string, ProviderTarget> = {};
      for (const node of workflow.nodes.filter(node => node.type === "agent")) {
        const target = this.executors.get(node.type).snapshotTarget?.(node, settings);
        if (target) nodeTargets[node.id] = target;
      }
      const run = await this.runStore.createRun({ task, workflow, workspace, settings, nodeTargets, executionSessionId, id });
      await this.setTaskStatus(task?.id, "in_progress", { workflowVersion: workflow.version, lastRunId: run.id });
      return run;
    });
  }

  async startStandalone(workflow: WorkflowDefinition, options: WorkflowRunOptions = {}): Promise<WorkflowRun> {
    const validation = this.workflowStore.validate(workflow);
    if (!validation.ok) throw Object.assign(new Error(validation.errors.join("; ")), { statusCode: 400 });
    const errors = validateRunOptions(options);
    if (errors.length) throw Object.assign(new Error(errors.join("; ")), { statusCode: 400 });
    if (!this.workspaceResolver?.forWorkflowRun) throw new Error("Standalone workspaces are unavailable.");
    const id = randomUUID();
    const executionSessionId = `workflow-${id}`;
    const workspace = await this.workspaceResolver.forWorkflowRun(id, options);
    const settings = await this.sessionSettingsStore?.get(executionSessionId);
    const nodeTargets: Record<string, ProviderTarget> = {};
    for (const node of workflow.nodes.filter(node => node.type === "agent")) {
      const target = this.executors.get(node.type).snapshotTarget?.(node, settings);
      if (target) nodeTargets[node.id] = target;
    }
    return this.runStore.createRun({ id, workflow, workspace, settings, nodeTargets, executionSessionId,
      input: { title: workflow.name, description: options.description ?? "" },
      accessMode: options.accessMode ?? "default", maxSteps: options.maxSteps ?? 25 });
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
      let run = await this.requireRun(runId);
      if (stopped(run)) return { run };
      if (controller.signal.aborted) return { run: { ...run, status: "cancelled" as const } };
      if (this.workspaceResolver && (!run.workspace || !run.executionSnapshot)) {
        return { run: await this.blockRun(run, "This legacy run has no workspace snapshot. Cancel it and start a new run with a selected project or managed task workspace.") };
      }
      if (run.workspace && this.workspaceResolver) {
        try { await this.workspaceResolver.validate(run.workspace); }
        catch (error) { return { run: await this.blockRun(run, error instanceof Error ? error.message : "Workspace is unavailable.") }; }
      }
      const task = run.executionSnapshot?.task ?? (run.taskId ? await this.requireTask(run.taskId) : undefined);
      const workflow = await this.workflowForRun(run);
      const node = this.requireNode(workflow, run.currentNodeId);
      const stepLimit = run.executionSnapshot?.maxSteps ?? 25;
      if (Number(run.state.completedSteps ?? 0) >= stepLimit) return { run: await this.blockRun(run, `Workflow exceeded max step limit (${stepLimit}).`) };
      const previousNodeRuns = await this.runStore.listNodeRuns(run.id);
      if (run.status === "running" && previousNodeRuns.some((item) => item.status === "running")) {
        const interrupted = (await this.runStore.updateRun(run.id, {
          status: "interrupted", error: "The previous execution was interrupted. Resume to recover the saved operation; an uncertain command will not be repeated."
        }))!;
        await this.setTaskStatus(run.taskId, "interrupted");
        return { run: interrupted };
      }
      const invocationId = typeof run.state.nodeInvocationId === "string" && run.state.activeNodeId === node.id
        ? run.state.nodeInvocationId : randomUUID();
      const agentRunId = `workflow-${run.id}:${node.id}:${invocationId}`;
      const operationId = `${agentRunId}:operation`;
      const agentInput = node.type === "agent" ? (
        run.state.activeNodeId === node.id && typeof run.state.activeAgentInput === "string" ? run.state.activeAgentInput :
          buildAgentInput({
            task, workflow, run, node, previousNodeRuns, workspace: run.workspace
          })
      ) : undefined;
      run = (await this.runStore.updateRun(runId, { status: "running", state: {
        ...run.state, activeNodeId: node.id, nodeInvocationId: invocationId, activeAgentRunId: agentRunId, activeOperationId: operationId,
        activeAgentInput: agentInput
      } }))!;
      const nodeRun = await this.runStore.appendNodeRun({
        runId, taskId: task?.id, workflowId: workflow.id, nodeId: node.id, status: "running",
        agentRunId: node.type === "agent" ? agentRunId : undefined,
        operationId: ["file_search", "file_read", "file_write", "command", "web_fetch"].includes(node.type) ? operationId : undefined,
        input: { taskId: task?.id, nodeConfig: node.config }, startedAt: new Date().toISOString()
      });
      await this.setTaskStatus(task?.id, "in_progress");
      return { run, task, workflow, node, previousNodeRuns, nodeRun, agentRunId, operationId, agentInput };
    });
    if (!prepared.nodeRun) return prepared.run;
    const { run, task, workflow, node, previousNodeRuns, nodeRun, agentRunId, operationId, agentInput } = prepared;
    let progressWrite: Promise<unknown> = Promise.resolve();
    let lastProgressAt = 0;
    let lastProgressKey = "";
    let finished = false;
    let result: NodeResult;
    try {
      controller.signal.throwIfAborted();
      result = await this.executors.get(node.type).execute({
        task, workflow, run, node, previousNodeRuns, signal: controller.signal,
        workspace: run.workspace, accessMode: run.executionSnapshot?.accessMode ?? task?.accessMode ?? "default",
        settings: run.executionSnapshot?.settings, agentRunId, operationId, agentInput,
        onProgress: (event) => {
          if (finished || controller.signal.aborted) return;
          const key = JSON.stringify([event.phase, event.label, event.detail, event.agents, event.agentRunId, event.operationId]);
          const now = Date.now();
          if (!event.output && key === lastProgressKey && now - lastProgressAt < 500) return;
          lastProgressKey = key;
          lastProgressAt = now;
          progressWrite = progressWrite.then(async () => {
            await this.runStore.recordEvent({ runId, nodeId: node.id, nodeRunId: nodeRun.id,
              agentRunId: event.agentRunId ?? nodeRun.agentRunId, operationId: event.operationId ?? nodeRun.operationId,
              at: event.at, type: event.output ? "node.output" : "node.progress",
              level: event.phase === "tool_error" ? "error" : event.output?.stream === "stderr" || event.phase === "correction" ? "warning" : "info",
              phase: event.phase,
              message: event.output ? event.output.stream : event.label,
              detail: event.output?.text ?? event.detail, stream: event.output?.stream });
            if (!event.output) await this.runStore.updateNodeRun(nodeRun.id, { progress: event });
          }).catch(error => { console.warn("Could not update workflow progress", error instanceof Error ? error.message : "unknown error"); });
        },
        approval: run.state.approvedNodeId === node.id ? readRecord(run.state.approvedOperation) : undefined
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      result = { status: "failed", event: "node.failed", summary: message, data: {}, error: message };
    }
    finished = true;
    await progressWrite;
    await this.runStore.updateNodeRun(nodeRun.id, {
      status: controller.signal.aborted ? "cancelled" : result.status === "needs_input" ? "waiting" : result.status === "blocked" ? "blocked" : result.status === "failed" ? "failed" : "ok",
      output: result, error: result.error, completedAt: new Date().toISOString()
    });
    return this.advanceAfterNode(runId, task, workflow, node, result);
  }

  runUntilStopped(runId: string, maxSteps?: number): Promise<WorkflowRun> {
    const existing = WorkflowRunner.loops.get(runId);
    if (existing) return existing;
    const operation = this.executeUntilStopped(runId, maxSteps).finally(() => WorkflowRunner.loops.delete(runId));
    WorkflowRunner.loops.set(runId, operation);
    return operation;
  }

  private async executeUntilStopped(runId: string, requestedMaxSteps?: number): Promise<WorkflowRun> {
    let run = await this.requireRun(runId);
    const maxSteps = requestedMaxSteps ?? run.executionSnapshot?.maxSteps ?? 25;
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
      await this.setTaskStatus(run.taskId, "blocked");
      return updated ?? run;
    });
  }

  async cancel(runId: string): Promise<WorkflowRun> {
    WorkflowRunner.controllers.get(runId)?.abort();
    return withFileLock(`workflow-run:${runId}`, async () => {
      const run = await this.requireRun(runId);
      if (["done", "failed", "cancelled"].includes(run.status)) return run;
      const updated = await this.runStore.updateRun(runId, { status: "cancelled", completedAt: new Date().toISOString() });
      await this.setTaskStatus(run.taskId, "cancelled");
      return updated ?? run;
    });
  }

  async review(runId: string, approved: boolean, comment = "", background = false, identity: WorkflowReviewIdentity = {}): Promise<WorkflowRun> {
    const reviewed = await withFileLock(`workflow-run:${runId}`, async () => {
      const run = await this.requireRun(runId);
      if (run.status !== "waiting") throw new WorkflowRunConflictError("Only a waiting run can be reviewed.");
      const task = run.executionSnapshot?.task ?? (run.taskId ? await this.requireTask(run.taskId) : undefined);
      const workflow = await this.workflowForRun(run);
      const node = this.requireNode(workflow, run.currentNodeId);
      const waiting = readRecord(readRecord(run.state.nodeResults)[node.id]);
      const permissionRequired = readRecord(waiting.data).permissionRequired === true;
      const nodeRuns = await this.runStore.listNodeRuns(runId);
      const waitingNodeRun = [...nodeRuns].reverse().find((item) => item.nodeId === node.id && item.status === "waiting");
      const waitingData = readRecord(waiting.data);
      if (run.workspace) {
        const expectedId = permissionRequired ? waitingData.approvalId : waitingNodeRun?.id;
        const suppliedId = permissionRequired ? identity.approvalId : identity.waitingNodeRunId;
        if (typeof expectedId !== "string" || suppliedId !== expectedId) throw new WorkflowRunConflictError("This approval is stale or missing its waiting operation ID. Refresh the run before reviewing it.");
        if (this.workspaceResolver) await this.workspaceResolver.validate(run.workspace);
      }
      const resumableOperation = node.type === "agent" || typeof waitingData.approvalId === "string";
      if (permissionRequired && (approved || resumableOperation)) {
        // Freeze the operation shown to the user; task edits must not change what approval executes.
        if (waitingNodeRun?.output) await this.runStore.updateNodeRun(waitingNodeRun.id, {
          status: "ok",
          output: { ...waitingNodeRun.output, status: "ok", event: `approval.${approved ? "approved" : "rejected"}`,
            summary: comment.trim() || (approved ? "Approved by user." : "Rejected by user."), data: { ...waitingNodeRun.output.data, approved } },
          completedAt: new Date().toISOString()
        });
        return (await this.runStore.updateRun(runId, {
          status: "queued", state: { ...run.state, approvedNodeId: node.id, approvedOperation: { ...waitingData, approved } }
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

  async resume(runId: string, background = false): Promise<WorkflowRun> {
    const resumed = await withFileLock(`workflow-run:${runId}`, async () => {
      const run = await this.requireRun(runId);
      if (run.status !== "interrupted") throw new WorkflowRunConflictError("Only an interrupted run can be resumed.");
      if (!run.workspace || !run.executionSnapshot) throw new WorkflowRunConflictError("This run has no workspace snapshot. Start a new run.");
      await this.workspaceResolver?.validate(run.workspace);
      const updated = (await this.runStore.updateRun(runId, { status: "queued", error: undefined }))!;
      await this.setTaskStatus(run.taskId, "in_progress");
      return updated;
    });
    if (background) { this.runInBackground(runId); return resumed; }
    return this.runUntilStopped(runId);
  }

  runInBackground(runId: string): void {
    void this.runUntilStopped(runId).catch(async (error) => {
      await withFileLock(`workflow-run:${runId}`, async () => {
        const run = await this.requireRun(runId);
        if (stopped(run)) return;
        await this.runStore.updateRun(runId, { status: "failed", error: error instanceof Error ? error.message : "Workflow failed", completedAt: new Date().toISOString() });
        await this.setTaskStatus(run.taskId, "failed");
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
    task: Task | undefined,
    workflow: WorkflowDefinition,
    node: WorkflowNode,
    result: NodeResult
  ): Promise<WorkflowRun> {
    return withFileLock(`workflow-run:${runId}`, () => this.advanceUnlocked(runId, task, workflow, node, result));
  }

  private async advanceUnlocked(runId: string, task: Task | undefined, workflow: WorkflowDefinition, node: WorkflowNode, result: NodeResult): Promise<WorkflowRun> {
    const latestRun = await this.requireRun(runId);
    if (["done", "failed", "cancelled"].includes(latestRun.status)) return latestRun;
    const unknown = result.data.unknown === true || (Array.isArray(result.data.tools) && result.data.tools.some(tool =>
      readRecord(readRecord(tool).metadata).unknown === true));
    const preserveInvocation = result.status === "needs_input" || unknown;
    const state = {
      ...latestRun.state,
      completedSteps: Number(latestRun.state.completedSteps ?? 0) + (preserveInvocation ? 0 : 1),
      approvedNodeId: undefined,
      approvedOperation: undefined,
      activeNodeId: preserveInvocation ? latestRun.state.activeNodeId : undefined,
      nodeInvocationId: preserveInvocation ? latestRun.state.nodeInvocationId : undefined,
      activeAgentRunId: preserveInvocation ? latestRun.state.activeAgentRunId : undefined,
      activeAgentInput: preserveInvocation ? latestRun.state.activeAgentInput : undefined,
      activeOperationId: preserveInvocation ? latestRun.state.activeOperationId : undefined,
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

    // Unknown effects must never enter graph retry/back edges with a fresh operation identity.
    if (unknown) {
      const updated = (await this.runStore.updateRun(runId, { status: "blocked", state,
        error: result.error ?? "An operation's outcome is unknown. Inspect its effects before starting another run; it was not repeated." }))!;
      await this.setTaskStatus(task?.id, "blocked");
      return updated;
    }

    if (node.type === "terminal") {
      const runStatus = result.data.runStatus === "failed" ? "failed" : "done";
      const updated = await this.runStore.updateRun(runId, {
        status: runStatus,
        state,
        completedAt: new Date().toISOString()
      });

      await this.setTaskStatus(task?.id, runStatus);
      return updated ?? latestRun;
    }

    if (result.status === "needs_input") {
      const updated = await this.runStore.updateRun(runId, {
        status: "waiting",
        state
      });
      await this.setTaskStatus(task?.id, "waiting");
      return updated ?? latestRun;
    }

    const transition = this.fsmEngine.selectNextTransition(workflow, node, result, state);

    if (!transition) {
      const status = result.status === "failed" ? "failed" : "blocked";
      const updated = await this.runStore.updateRun(runId, {
        status,
        state,
        error: result.status === "failed" ? result.error || result.summary : `No transition matched from node "${node.id}" after event "${result.event}".`,
        completedAt: status === "failed" ? new Date().toISOString() : undefined
      });
      await this.setTaskStatus(task?.id, status);
      return updated ?? latestRun;
    }

    const nodeRun = (await this.runStore.listNodeRuns(runId)).filter(item => item.nodeId === node.id).at(-1);
    if (nodeRun) await this.runStore.updateNodeRun(nodeRun.id, { transitionId: transition.id });
    await this.runStore.recordEvent({ runId, nodeId: node.id, nodeRunId: nodeRun?.id, transitionId: transition.id,
      type: "transition", level: "info", message: `Next: ${workflow.nodes.find(item => item.id === transition.to)?.label ?? transition.to}`,
      detail: `${node.id} → ${transition.to}${transition.label ? ` · ${transition.label}` : ""}` });
    return (await this.runStore.updateRun(runId, {
      status: "queued",
      currentNodeId: transition.to,
      state
    })) ?? latestRun;
  }

  private async blockRun(run: WorkflowRun, error: string): Promise<WorkflowRun> {
    const updated = (await this.runStore.updateRun(run.id, { status: "blocked", error }))!;
    await this.setTaskStatus(run.taskId, "blocked");
    return updated;
  }

  private async setTaskStatus(taskId: string | undefined, status: TaskStatus, extra?: Partial<Task>): Promise<void> {
    if (taskId) await this.taskStore.setStatus(taskId, status, extra);
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
