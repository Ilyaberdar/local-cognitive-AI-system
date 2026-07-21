import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import type { FsmEdgeData } from "./workflowAdapter";

function guardLabel(data: FsmEdgeData): string {
  const transition = data.transition;

  if (transition.label) return transition.label;
  if (transition.guard.type === "always") return "always";
  if (transition.guard.type === "status") return `status = ${transition.guard.equals}`;
  if (transition.guard.type === "event") return `event = ${transition.guard.equals}`;
  return `${transition.guard.path} ${transition.guard.op}`;
}

export function GuardEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath(props);
  const data = props.data as FsmEdgeData | undefined;

  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} className={props.selected ? "is-selected" : ""} />
      {data ? (
        <EdgeLabelRenderer>
          <div
            className="fsm-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {guardLabel(data)}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
