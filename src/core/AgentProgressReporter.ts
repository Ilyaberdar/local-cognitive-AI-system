import { ProcessAgentProgress, ProcessProgressEvent } from "../types";

export class AgentProgressReporter {
  constructor(
    private readonly agents: ProcessAgentProgress[],
    private readonly onProgress?: (event: ProcessProgressEvent) => void
  ) {}

  update(id: string, status: ProcessAgentProgress["status"], phase: string, error?: string): void {
    const agent = this.agents.find((item) => item.id === id);
    if (!agent) return;
    Object.assign(agent, { status, phase, error });
    const active = this.agents.find((item) => item.status === "running") ?? this.agents.find((item) => item.status === "queued");
    this.onProgress?.({
      phase: active?.phase ?? phase,
      label: active?.phase ?? phase,
      detail: `${active?.name ?? agent.name} · ${active?.phase ?? phase}`,
      completed: this.agents.filter((item) => ["completed", "degraded", "cancelled"].includes(item.status)).length,
      total: this.agents.length,
      agents: this.agents.map((item) => ({ ...item })),
      at: new Date().toISOString()
    });
  }
}
