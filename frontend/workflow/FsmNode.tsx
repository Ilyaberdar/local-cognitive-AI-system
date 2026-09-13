import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { FsmNodeData } from "./workflowAdapter";

const TYPE_LABELS: Record<string, string> = {
  entry: "Entry",
  agent: "Agent",
  file_search: "Search files",
  web_search: "Search web",
  file_write: "Save file",
  command: "Run command",
  decision: "Decision",
  tool: "Tool",
  human_review: "Human review",
  terminal: "Terminal"
};

export function FsmNode({ data, selected }: NodeProps) {
  const nodeData = data as FsmNodeData;
  const node = nodeData.definition;
  const isEntry = node.type === "entry";
  const isTerminal = node.type === "terminal";
  const provider = typeof node.config.providerId === "string" ? node.config.providerId : "";
  const model = typeof node.config.model === "string" ? node.config.model : "";
  const run = nodeData.run;
  const active = run?.status === "running" || run?.status === "queued";

  return (
    <div className={`fsm-node fsm-node--${node.type} ${selected ? "is-selected" : ""}`}>
      {!isEntry && <Handle type="target" position={Position.Left} />}
      <div className="fsm-node__eyebrow">
        <span>{TYPE_LABELS[node.type] ?? node.type}</span>
        {nodeData.isEntry && node.type !== "entry" ? <span>start</span> : null}
      </div>
      <strong>{node.label || node.id}</strong>
      <div className="fsm-node__meta">
        {provider || model ? [provider === "llamacpp" ? "Local models" : provider, model].filter(Boolean).join(" · ") : node.id}
      </div>
      {run ? <div className={`fsm-node__progress ${active ? "is-active" : ""}`} title={run.progress?.label}>
        {active ? <span className="activity-scan" aria-hidden="true" /> : null}
        <span>{active ? run.progress?.label || "Waiting" : ({ ok: "Completed", failed: "Failed", cancelled: "Cancelled", needs_input: "Needs review", blocked: "Blocked" } as Record<string, string>)[run.status] || run.status}</span>
      </div> : null}
      {!isTerminal && <Handle type="source" position={Position.Right} />}
    </div>
  );
}
