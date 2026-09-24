export type WorkflowNodeType =
  | "entry"
  | "agent"
  | "file_search"
  | "web_search"
  | "web_fetch"
  | "file_read"
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
  runDefaults?: WorkflowRunOptions;
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

export interface WorkflowRunOptions {
  description?: string;
  projectId?: string;
  rootPath?: string;
  accessMode?: "ask" | "default" | "full";
  maxSteps?: number;
}

export interface ProviderOption {
  id: string;
  name: string;
  models: string[];
  defaultModel?: string;
  installedOnly?: boolean;
  modelLabels?: Record<string, string>;
}

export interface WorkflowNodeProgress {
  id?: string;
  transitionId?: string;
  startedAt?: string;
  completedAt?: string;
  nodeId: string;
  status: string;
  progress?: { phase: string; label: string };
  output?: { summary?: string; error?: string; data?: Record<string, unknown>; artifacts?: Array<{name: string; path?: string}> };
}

export interface WorkflowLogEvent {
  sequence: number; at: string; type: string; level: string; message: string;
  phase?: string; detail?: string; nodeId?: string; nodeRunId?: string; stream?: string; transitionId?: string;
}

export interface WorkflowExecution {
  run: { id: string; status: string; currentNodeId?: string; createdAt: string; updatedAt?: string; completedAt?: string; error?: string; workflowSnapshot?: WorkflowDefinition };
  nodeRuns: WorkflowNodeProgress[];
  events: WorkflowLogEvent[];
  connection: "connecting" | "live" | "reconnecting";
  truncated?: boolean;
}

export interface WorkflowConsoleViewState {
  view?: "both" | "console" | "activity";
  split?: number;
  activityScrollTop?: number;
  activityFollow?: boolean;
  clearedRuns?: Record<string, { sequence: number; legacyCount: number }>;
  collapsed: boolean;
  height: number;
  problemsOnly: boolean;
  follow: boolean;
  scrollTop: number;
}

export interface WorkflowEditorViewState {
  selected: { kind: "node" | "edge"; id: string } | null;
  inspectorOpen: boolean;
  mapOpen: boolean;
  consoleNodeId: string;
  followActive: boolean;
  viewport: { x: number; y: number; zoom: number };
  runSettingsOpen: boolean;
  inspectorScrollTop: number;
  console?: WorkflowConsoleViewState;
}

export interface WorkflowEditorProps {
  onReview?: (runId: string, decision: { approved: boolean; approvalId?: string; waitingNodeRunId?: string }) => Promise<void>;
  projects?: Array<{ id: string; name: string; rootPath: string; archivedAt?: string }>;
  onRun?: (workflow: WorkflowDefinition) => Promise<void>;
  onStop?: (runId: string) => Promise<void>;
  onChooseFolder?: () => Promise<string | null>;
  execution?: WorkflowExecution;
  starting?: boolean;
  initialViewState?: WorkflowEditorViewState;
  onCaptureState?: (capture: () => WorkflowEditorViewState) => void;
  onResume?: (runId: string) => Promise<void>;
  workflow: WorkflowDefinition;
  providers: ProviderOption[];
  validation?: { ok: boolean; errors: string[] } | null;
  colorMode: "light" | "dark";
  nodeRuns?: WorkflowNodeProgress[];
  onChange: (workflow: WorkflowDefinition) => void;
}
