import { ActivityEntry, ProcessProgressEvent } from "../types";

/** A bounded presentation trace, not an execution log or a source of tool instructions. */
export class ActivityTrace {
  private entries: ActivityEntry[] = [];
  private sequence = 0;

  record(event: ProcessProgressEvent): ActivityEntry[] {
    if (event.output) return this.snapshot();
    event = { ...event, phase: event.phase.toLowerCase() };
    const terminal = ["complete", "failed", "cancelled"].includes(event.phase);
    const error = ["failed", "tool_error", "cancelled"].includes(event.phase);
    const previous = event.operationId
      ? [...this.entries].reverse().find(item => item.operationId === event.operationId)
      : this.entries.at(-1);
    const same = previous && (event.operationId || previous.phase === event.phase && previous.label === event.label && previous.agentRunId === event.agentRunId && previous.model === event.model);
    for (const item of this.entries) {
      if (item.status === "active" && (terminal || item.agentRunId === event.agentRunId || !item.agentRunId) && item !== (same ? previous : undefined)) {
        item.status = terminal && error ? "error" : "complete";
        item.updatedAt = event.at;
      }
    }
    if (same && previous) {
      Object.assign(previous, { updatedAt: event.at, status: error ? "error" : event.phase === "tool_result" ? "complete" : previous.status });
      // Preserve the tool's target instead of replacing it with a wall of output.
      if (!event.operationId && event.detail) previous.detail = event.detail.slice(0, 600);
      if (event.note) previous.note = event.note.slice(-6000);
    } else {
      this.entries.push({ id: String(++this.sequence), phase: event.phase, label: event.label.slice(0, 160),
        detail: event.detail?.slice(0, 600), note: event.note?.slice(-6000), model: event.model,
        agentRunId: event.agentRunId, operationId: event.operationId, at: event.at, updatedAt: event.at,
        status: error ? "error" : terminal || event.phase === "tool_result" ? "complete" : "active" });
      this.entries = this.entries.slice(-48);
    }
    return this.snapshot();
  }

  snapshot(): ActivityEntry[] { return this.entries.map(item => ({ ...item })); }
}
