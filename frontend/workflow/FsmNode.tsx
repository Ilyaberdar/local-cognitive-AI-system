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

  return (
    <div className={`fsm-node fsm-node--${node.type} ${selected ? "is-selected" : ""}`}>
      {!isEntry && <Handle type="target" position={Position.Left} />}
      <div className="fsm-node__eyebrow">
        <span>{TYPE_LABELS[node.type] ?? node.type}</span>
        {nodeData.isEntry && node.type !== "entry" ? <span>start</span> : null}
      </div>
      <strong>{node.label || node.id}</strong>
      <div className="fsm-node__meta">
        {provider || model ? [provider, model].filter(Boolean).join(" · ") : node.id}
      </div>
      {!isTerminal && <Handle type="source" position={Position.Right} />}
    </div>
  );
}
