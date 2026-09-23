import { Task } from "../tasks/types";
import { ProviderTarget, SessionSettings, SubagentAccessMode } from "../types";
import { WorkspaceSnapshot } from "../workspace/types";

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

export type NodeResultStatus = "ok" | "failed" | "blocked" | "needs_input";

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "interrupted"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export type NodeRunStatus = "running" | "ok" | "failed" | "blocked" | "skipped" | "waiting" | "cancelled";

export type TransitionGuard =
  | { type: "always" }
  | { type: "status"; equals: NodeResultStatus }
  | { type: "event"; equals: string }
  | {
      type: "json_path";
      path: string;
      op: "eq" | "exists" | "contains";
      value?: unknown;
    };

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: number;
  description?: string;
  entryNodeId: string;
  nodes: WorkflowNode[];
  transitions: WorkflowTransition[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  position: {
    x: number;
    y: number;
  };
  config: Record<string, unknown>;
}

export interface WorkflowTransition {
  id: string;
  from: string;
  to: string;
  label?: string;
  priority: number;
  guard: TransitionGuard;
}

export interface WorkflowRun {
  id: string;
  taskId: string;
  workflowId: string;
  workflowVersion: number;
  workflowSnapshot?: WorkflowDefinition;
  workspace?: WorkspaceSnapshot;
  executionSessionId?: string;
  executionSnapshot?: {
    task: Task;
    settings?: SessionSettings;
    accessMode: SubagentAccessMode;
    nodeTargets?: Record<string, ProviderTarget>;
  };
  status: WorkflowRunStatus;
  currentNodeId?: string;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}

export interface NodeResult {
  status: NodeResultStatus;
  event: string;
  summary: string;
  data: Record<string, unknown>;
  artifacts?: Array<{
    name: string;
    path?: string;
    contentType?: string;
  }>;
  error?: string;
}

export interface StoredNodeResult {
  status: NodeResultStatus;
  event: string;
  summary: string;
  data: Record<string, unknown>;
  artifacts?: NodeResult["artifacts"];
  error?: string;
}

export interface NodeRun {
  agentRunId?: string;
  operationId?: string;
  progress?: import("../types").ProcessProgressEvent;
  id: string;
  runId: string;
  taskId: string;
  workflowId: string;
  nodeId: string;
  status: NodeRunStatus;
  input: unknown;
  output?: NodeResult;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface CreateWorkflowRunInput {
  id?: string;
  task: Task;
  workflow: WorkflowDefinition;
  workspace?: WorkspaceSnapshot;
  executionSessionId?: string;
  settings?: SessionSettings;
  nodeTargets?: Record<string, ProviderTarget>;
}

export interface WorkflowValidationResult {
  ok: boolean;
  errors: string[];
}

export interface WorkflowDefinitionRecord {
  workflows: WorkflowDefinition[];
}

export interface WorkflowRunRecord {
  runs: WorkflowRun[];
}

export class WorkflowRunConflictError extends Error {
  readonly statusCode = 409;
}

export interface NodeRunRecord {
  nodeRuns: NodeRun[];
}
