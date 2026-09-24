import { Handle, NodeToolbar, Position, type NodeProps } from "@xyflow/react";
import type { FsmNodeData } from "./workflowAdapter";

const TYPE_LABELS: Record<string, string> = {
  entry: "Entry",
  agent: "Agent",
  file_search: "Search files",
  web_search: "Search web",
  web_fetch: "Read webpage",
  file_read: "Read file",
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
    <div className={`fsm-node fsm-node--${node.type} ${selected ? "is-selected" : ""} ${run ? `fsm-node--status-${run.status}` : ""}`} data-run-status={run?.status}>
      {nodeData.review ? <NodeToolbar isVisible position={Position.Top} offset={14}>
        <section className="fsm-approval nodrag nopan nowheel" aria-label={`Approval for ${node.label || node.id}`} aria-busy={nodeData.review.busy} onClick={event => event.stopPropagation()}>
          <strong>{run?.output?.data?.permissionRequired ? "Permission required" : "Review required"}</strong>
          <p>{run?.output?.summary || "Review this step before continuing."}</p>
          {typeof run?.output?.data?.details === "string" ? <details><summary>Request details</summary><pre>{run.output.data.details}</pre></details> : null}
          {nodeData.review.error ? <p className="fsm-field-error" role="alert">{nodeData.review.error}</p> : null}
          <div className="fsm-approval__actions">
            <button type="button" disabled={nodeData.review.busy} onClick={() => nodeData.review!.decide(false)}>Reject</button>
            <button type="button" className="fsm-approval__approve" disabled={nodeData.review.busy} onClick={() => nodeData.review!.decide(true)}>{nodeData.review.busy ? "Applying…" : "Approve"}</button>
          </div>
        </section>
      </NodeToolbar> : null}
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
        <span>{active ? run.progress?.label || (run.status === "queued" ? "Queued" : "Running") : ({ ok: "✓ Completed", failed: "Failed", cancelled: "Cancelled", waiting: "Awaiting approval", interrupted: "Interrupted", blocked: "Blocked" } as Record<string, string>)[run.status] || run.status}</span>
      </div> : null}
      {!isTerminal && <Handle type="source" position={Position.Right} />}
    </div>
  );
}
