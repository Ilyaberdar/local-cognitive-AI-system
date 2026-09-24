import { withFileLock, writeJsonAtomically, isMissingFile } from "../utils/fileStore";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { WorkflowEventStore, WorkflowEventInput } from "./WorkflowEventStore";
import {
  CreateWorkflowRunInput,
  NodeRun,
  NodeRunRecord,
  WorkflowRun,
  WorkflowRunRecord
} from "./types";

export class WorkflowRunStore {
  readonly events: WorkflowEventStore;
  private readonly runsPath: string;
  private readonly nodeRunsPath: string;

  constructor(private readonly baseDir: string) {
    this.events = new WorkflowEventStore(baseDir);
    this.runsPath = path.join(baseDir, "runs.json");
    this.nodeRunsPath = path.join(baseDir, "node-runs.json");
  }

  async listRuns(): Promise<WorkflowRun[]> {
    return withFileLock(this.runsPath, async () => {
      const record = await this.readRuns();
      return [...record.runs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
  }

  async createRun(input: CreateWorkflowRunInput): Promise<WorkflowRun> {
    return withFileLock(this.runsPath, async () => {
      const record = await this.readRuns();
      const now = new Date().toISOString();
      const id = input.id ?? randomUUID();
      const run: WorkflowRun = {
        id,
        taskId: input.task?.id,
        source: input.task ? "task" : "standalone",
        workflowId: input.workflow.id,
        workflowVersion: input.workflow.version,
        workflowSnapshot: structuredClone(input.workflow),
        workspace: input.workspace ? structuredClone(input.workspace) : undefined,
        executionSessionId: input.executionSessionId ?? `workflow-${id}`,
        executionSnapshot: {
          task: input.task ? structuredClone(input.task) : undefined,
          input: structuredClone(input.input ?? { title: input.task?.title ?? input.workflow.name, description: input.task?.description ?? "" }),
          maxSteps: input.maxSteps ?? 25,
          settings: input.settings ? structuredClone(input.settings) : undefined,
          nodeTargets: input.nodeTargets ? structuredClone(input.nodeTargets) : undefined,
          accessMode: input.accessMode ?? input.task?.accessMode ?? "default"
        },
        status: "queued",
        currentNodeId: input.workflow.entryNodeId,
        state: {},
        createdAt: now,
        updatedAt: now
      };

      record.runs.unshift(run);
      await this.writeRuns(record);
      await this.recordEvent({ runId: run.id, type: "run.status", level: "info", message: "Workflow queued" });
      return run;
    });
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    return withFileLock(this.runsPath, async () => {
      const record = await this.readRuns();
      return record.runs.find((run) => run.id === runId) ?? null;
    });
  }

  async updateRun(runId: string, patch: Partial<Omit<WorkflowRun, "id" | "createdAt">>): Promise<WorkflowRun | null> {
    return withFileLock(this.runsPath, async () => {
      const record = await this.readRuns();
      const run = record.runs.find((item) => item.id === runId);

      if (!run) {
        return null;
      }

      if (["workspace", "executionSessionId", "executionSnapshot", "workflowSnapshot", "taskId", "source", "workflowId", "workflowVersion"].some((field) => Object.prototype.hasOwnProperty.call(patch, field))) {
        throw new Error("Workflow execution snapshots cannot be changed after run creation.");
      }

      const previousStatus = run.status;
      Object.assign(run, {
        ...patch,
        updatedAt: new Date().toISOString()
      });
      await this.writeRuns(record);
      if (previousStatus !== run.status) await this.recordEvent({ runId, type: "run.status",
        level: run.status === "failed" ? "error" : ["waiting", "blocked", "interrupted", "cancelled"].includes(run.status) ? "warning" : "info",
        message: `Workflow ${run.status}`, detail: run.error, nodeId: run.currentNodeId });
      return run;
    });
  }

  async listNodeRuns(runId: string): Promise<NodeRun[]> {
    return withFileLock(this.runsPath, async () => {
      const record = await this.readNodeRuns();
      return record.nodeRuns
        .filter((run) => run.runId === runId)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    });
  }

  async appendNodeRun(input: Omit<NodeRun, "id">): Promise<NodeRun> {
    return withFileLock(this.runsPath, async () => {
      const record = await this.readNodeRuns();
      const nodeRun: NodeRun = {
        id: randomUUID(),
        ...input
      };

      record.nodeRuns.push(nodeRun);
      await this.writeNodeRuns(record);
      await this.recordEvent({ runId: nodeRun.runId, nodeId: nodeRun.nodeId, nodeRunId: nodeRun.id,
        agentRunId: nodeRun.agentRunId, operationId: nodeRun.operationId,
        type: "node.started", level: "info", message: "Step started" });
      return nodeRun;
    });
  }

  async updateNodeRun(nodeRunId: string, patch: Partial<Omit<NodeRun, "id" | "startedAt">>): Promise<NodeRun | null> {
    return withFileLock(this.runsPath, async () => {
      const record = await this.readNodeRuns();
      const nodeRun = record.nodeRuns.find((run) => run.id === nodeRunId);

      if (!nodeRun) {
        return null;
      }

      if (patch.progress && nodeRun.status !== "running") return nodeRun;

      const previousStatus = nodeRun.status;
      Object.assign(nodeRun, patch);
      await this.writeNodeRuns(record);
      if (patch.status && patch.status !== previousStatus) await this.recordEvent({
        runId: nodeRun.runId, nodeId: nodeRun.nodeId, nodeRunId: nodeRun.id,
        agentRunId: nodeRun.agentRunId, operationId: nodeRun.operationId,
        type: "node.completed", level: patch.status === "failed" ? "error" : ["waiting", "blocked", "cancelled"].includes(patch.status) ? "warning" : "info",
        message: `Step ${patch.status === "ok" ? "completed" : patch.status}`, detail: nodeRun.output?.summary ?? nodeRun.error
      });
      return nodeRun;
    });
  }

  async recordEvent(event: WorkflowEventInput): Promise<void> {
    // Observability is separate from operation checkpoints: logging failure must not replay effects.
    try { await this.events.append(event); }
    catch (error) { console.warn("Could not persist workflow event", error instanceof Error ? error.message : "unknown error"); }
  }

  private async readRuns(): Promise<WorkflowRunRecord> {
    await fs.mkdir(this.baseDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.runsPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WorkflowRunRecord>;
      if (!parsed || !Array.isArray(parsed.runs)) throw new Error("Expected a runs array.");
      return { runs: parsed.runs };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const initial = { runs: [] };
      await this.writeRuns(initial);
      return initial;
    }
  }

  private async writeRuns(record: WorkflowRunRecord): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await writeJsonAtomically(this.runsPath, record);
  }

  private async readNodeRuns(): Promise<NodeRunRecord> {
    await fs.mkdir(this.baseDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.nodeRunsPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<NodeRunRecord>;
      if (!parsed || !Array.isArray(parsed.nodeRuns)) throw new Error("Expected a nodeRuns array.");
      return { nodeRuns: parsed.nodeRuns };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const initial = { nodeRuns: [] };
      await this.writeNodeRuns(initial);
      return initial;
    }
  }

  private async writeNodeRuns(record: NodeRunRecord): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await writeJsonAtomically(this.nodeRunsPath, record);
  }
}
