import { randomUUID } from "crypto";
import { ApprovalOperation, PendingApproval, ProcessProgressEvent } from "../types";

interface ProcessRunState {
  id: string;
  status: "running" | "completed" | "cancelled" | "failed";
  controller: AbortController;
  progress?: ProcessProgressEvent;
  startedAt: string;
  updatedAt: string;
  error?: string;
  sessionId?: string;
  approval?: PendingApproval;
}

export class ProcessRunRegistry {
  private readonly runs = new Map<string, ProcessRunState>();
  private readonly decisions = new Map<string, (approved: boolean) => void>();

  start(id: string, sessionId?: string): ProcessRunState {
    if (this.runs.has(id)) throw new Error("Process request id already exists.");
    const now = new Date().toISOString();
    const run: ProcessRunState = {
      id,
      sessionId,
      status: "running",
      controller: new AbortController(),
      startedAt: now,
      updatedAt: now
    };

    this.runs.set(id, run);
    this.prune();
    return run;
  }

  async requestApproval(id: string, operation: ApprovalOperation): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || run.status !== "running" || run.approval) throw new Error("Run cannot request approval.");
    run.controller.signal.throwIfAborted();
    run.approval = { ...structuredClone(operation), id: randomUUID(), requestedAt: new Date().toISOString() };
    this.update(id, { phase: "approval", label: "Approval required", detail: operation.summary, at: new Date().toISOString() });
    return new Promise<boolean>((resolve, reject) => {
      const cleanup = () => {
        this.decisions.delete(id);
        delete run.approval;
        run.controller.signal.removeEventListener("abort", abort);
      };
      const abort = () => { cleanup(); reject(run.controller.signal.reason); };
      this.decisions.set(id, (approved) => {
        cleanup();
        this.update(id, { phase: "tools", label: approved ? "Executing" : "Cancelled action",
          detail: operation.summary, at: new Date().toISOString() });
        resolve(approved);
      });
      run.controller.signal.addEventListener("abort", abort, { once: true });
    });
  }

  review(id: string, sessionId: string, approvalId: string, approved: boolean): boolean {
    const run = this.runs.get(id);
    const decide = this.decisions.get(id);
    if (!run || run.status !== "running" || run.sessionId !== sessionId ||
        run.approval?.id !== approvalId || !decide) return false;
    decide(approved);
    return true;
  }

  update(id: string, progress: ProcessProgressEvent): void {
    const run = this.runs.get(id);
    if (!run || run.status !== "running") {
      return;
    }

    run.progress = { ...progress, agents: progress.agents ?? run.progress?.agents };
    run.updatedAt = progress.at;
  }

  complete(id: string): void {
    if (this.runs.get(id)?.status === "running") this.setStatus(id, "completed");
  }

  fail(id: string, error: string): void {
    const run = this.runs.get(id);
    if (!run) {
      return;
    }
    run.error = error;
    this.setStatus(id, run.controller.signal.aborted ? "cancelled" : "failed");
  }

  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.status !== "running") {
      return false;
    }

    run.controller.abort();
    this.setStatus(id, "cancelled");
    return true;
  }

  get(id: string): Omit<ProcessRunState, "controller"> | undefined {
    const run = this.runs.get(id);
    if (!run) {
      return undefined;
    }

    const { controller: _controller, ...publicState } = run;
    return publicState;
  }

  private setStatus(id: string, status: ProcessRunState["status"]): void {
    const run = this.runs.get(id);
    if (!run) {
      return;
    }
    if (status !== "running" && run.approval) this.decisions.get(id)?.(false);
    run.status = status;
    run.updatedAt = new Date().toISOString();
    if (status !== "running" && run.progress?.agents) {
      run.progress = { ...run.progress, agents: run.progress.agents.map((agent) =>
        ["queued", "running"].includes(agent.status)
          ? { ...agent, status: status === "cancelled" ? "cancelled" : "degraded", phase: status === "cancelled" ? "Interrupted" : "Stopped" }
          : agent
      ) };
    }
  }

  private prune(): void {
    if (this.runs.size <= 100) {
      return;
    }

    const completed = [...this.runs.values()]
      .filter((run) => run.status !== "running")
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));

    completed.slice(0, this.runs.size - 100).forEach((run) => this.runs.delete(run.id));
  }
}

export const processRunRegistry = new ProcessRunRegistry();
