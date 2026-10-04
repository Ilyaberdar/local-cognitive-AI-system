import { LLMRequest, ProcessAgentProgress, ProcessProgressEvent } from "../types";

export class AgentProgressReporter {
  inference(id: string): NonNullable<LLMRequest["onProgress"]> {
    return (event) => this.update(id, event.phase === "queued" ? "queued" : "running",
      event.phase === "queued" ? `Queued${event.queuePosition ? ` · ${event.queuePosition} in queue` : ""}` : event.phase === "loading" ? "Loading model" : event.phase === "thinking" ? "Thinking" : event.phase === "responding" ? "Writing response" : "Waiting for model", undefined,
      { phase: event.phase === "responding" ? "answer" : event.phase === "generating" ? "waiting" : event.phase, note: event.note, model: event.model, agentRunId: id });
  }
  constructor(
    private readonly agents: ProcessAgentProgress[],
    private readonly onProgress?: (event: ProcessProgressEvent) => void
  ) {}

  update(id: string, status: ProcessAgentProgress["status"], phase: string, error?: string, extra?: Partial<ProcessProgressEvent>): void {
    const agent = this.agents.find((item) => item.id === id);
    if (!agent) return;
    Object.assign(agent, { status, phase, error });
    const active = this.agents.find((item) => item.status === "running") ?? this.agents.find((item) => item.status === "queued");
    this.onProgress?.({
      phase: extra?.phase ?? active?.phase ?? phase,
      label: extra ? phase : active?.phase ?? phase,
      detail: this.agents.length > 1 ? extra ? agent.name : `${active?.name ?? agent.name} · ${active?.phase ?? phase}` : undefined,
      completed: this.agents.filter((item) => ["completed", "degraded", "cancelled"].includes(item.status)).length,
      total: this.agents.length,
      agents: this.agents.map((item) => ({ ...item })),
      at: new Date().toISOString(),
      ...extra
    });
  }
}
