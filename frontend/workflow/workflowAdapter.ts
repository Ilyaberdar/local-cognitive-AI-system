import type { Edge, Node } from "@xyflow/react";
import type {
  WorkflowDefinition,
  WorkflowNodeDefinition,
  WorkflowNodeProgress,
  WorkflowTransitionDefinition
} from "./types";

export type FsmNodeData = Record<string, unknown> & {
  definition: WorkflowNodeDefinition;
  isEntry: boolean;
  run?: WorkflowNodeProgress;
  review?: { busy: boolean; error: string; decide: (approved: boolean) => void };
};

export type FsmEdgeData = Record<string, unknown> & {
  transition: WorkflowTransitionDefinition;
  visited?: boolean;
  active?: boolean;
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

/** Keep explicit data bindings intact when the user renames a step. */
export function renameNodeBindings(value: unknown, previousId: string, nextId: string): unknown {
  const replacePath = (text: string) => {
    const prefix = `nodes.${previousId}`;
    return text === prefix || text.startsWith(`${prefix}.`) ? `nodes.${nextId}${text.slice(prefix.length)}` : text;
  };
  if (typeof value === "string") return replacePath(value).replace(/{{\s*([^{}]+?)\s*}}/g, (original, path: string) => {
    const replacement = replacePath(path.trim());
    return replacement === path.trim() ? original : `{{${replacement}}}`;
  });
  if (Array.isArray(value)) return value.map(item => renameNodeBindings(item, previousId, nextId));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renameNodeBindings(item, previousId, nextId)]));
  return value;
}
