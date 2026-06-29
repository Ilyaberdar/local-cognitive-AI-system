import { ProcessProgressEvent } from "../types";

interface ProcessRunState {
  id: string;
  status: "running" | "completed" | "cancelled" | "failed";
  controller: AbortController;
  progress?: ProcessProgressEvent;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

export class ProcessRunRegistry {
  private readonly runs = new Map<string, ProcessRunState>();

  start(id: string): ProcessRunState {
    const now = new Date().toISOString();
    const run: ProcessRunState = {
      id,
      status: "running",
      controller: new AbortController(),
      startedAt: now,
      updatedAt: now
    };

    this.runs.set(id, run);
    this.prune();
    return run;
  }

  update(id: string, progress: ProcessProgressEvent): void {
    const run = this.runs.get(id);
    if (!run || run.status !== "running") {
      return;
    }

    run.progress = progress;
    run.updatedAt = progress.at;
  }

  complete(id: string): void {
    this.setStatus(id, "completed");
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
    run.status = status;
    run.updatedAt = new Date().toISOString();
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
