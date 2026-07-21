export type WorkflowNodeType =
  | "entry"
  | "agent"
  | "file_search"
  | "web_search"
  | "file_write"
  | "command"
  | "decision"
  | "tool"
  | "human_review"
  | "terminal";

export type TransitionGuard =
  | { type: "always" }
  | { type: "status"; equals: "ok" | "failed" | "blocked" | "needs_input" }
  | { type: "event"; equals: string }
  | { type: "json_path"; path: string; op: "eq" | "exists" | "contains"; value?: unknown };

export interface WorkflowNodeDefinition {
  id: string;
  type: WorkflowNodeType;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

export interface WorkflowTransitionDefinition {
  id: string;
  from: string;
  to: string;
  label?: string;
  priority: number;
  guard: TransitionGuard;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: number;
  description?: string;
  entryNodeId: string;
  nodes: WorkflowNodeDefinition[];
  transitions: WorkflowTransitionDefinition[];
  createdAt: string;
  updatedAt: string;
}

export interface ProviderOption {
  id: string;
  name: string;
  models: string[];
  defaultModel?: string;
}

export interface WorkflowEditorProps {
  workflow: WorkflowDefinition;
  providers: ProviderOption[];
  validation?: { ok: boolean; errors: string[] } | null;
  colorMode: "light" | "dark";
  onChange: (workflow: WorkflowDefinition) => void;
}
