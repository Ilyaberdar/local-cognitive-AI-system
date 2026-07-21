import type { Edge, Node } from "@xyflow/react";
import type {
  WorkflowDefinition,
  WorkflowNodeDefinition,
  WorkflowTransitionDefinition
} from "./types";

export type FsmNodeData = Record<string, unknown> & {
  definition: WorkflowNodeDefinition;
  isEntry: boolean;
};

export type FsmEdgeData = Record<string, unknown> & {
  transition: WorkflowTransitionDefinition;
};

export const toFlowNodes = (workflow: WorkflowDefinition): Node<FsmNodeData>[] =>
  workflow.nodes.map((definition) => ({
    id: definition.id,
    type: "fsmNode",
    position: definition.position,
    data: {
      definition,
      isEntry: workflow.entryNodeId === definition.id
    }
  }));

export const toFlowEdges = (workflow: WorkflowDefinition): Edge<FsmEdgeData>[] =>
  workflow.transitions.map((transition) => ({
    id: transition.id,
    source: transition.from,
    target: transition.to,
    type: "guardEdge",
    data: { transition }
  }));

export const uniqueId = (prefix: string, existing: string[]): string => {
  const normalized = prefix.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "item";
  let candidate = normalized;
  let suffix = 2;

  while (existing.includes(candidate)) {
    candidate = `${normalized}-${suffix}`;
    suffix += 1;
  }

  return candidate;
};
