import { withFileLock, writeJsonAtomically, isMissingFile } from "../utils/fileStore";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import {
  CreateWorkflowRunInput,
  NodeRun,
  NodeRunRecord,
  WorkflowRun,
  WorkflowRunRecord
} from "./types";

export class WorkflowRunStore {
  private readonly runsPath: string;
  private readonly nodeRunsPath: string;

  constructor(private readonly baseDir: string) {
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
      const run: WorkflowRun = {
        id: randomUUID(),
        taskId: input.task.id,
        workflowId: input.workflow.id,
        workflowVersion: input.workflow.version,
        workflowSnapshot: structuredClone(input.workflow),
        status: "queued",
        currentNodeId: input.workflow.entryNodeId,
        state: {},
        createdAt: now,
        updatedAt: now
      };

      record.runs.unshift(run);
      await this.writeRuns(record);
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

      Object.assign(run, {
        ...patch,
        updatedAt: new Date().toISOString()
      });
      await this.writeRuns(record);
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

      Object.assign(nodeRun, patch);
      await this.writeNodeRuns(record);
      return nodeRun;
    });
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
