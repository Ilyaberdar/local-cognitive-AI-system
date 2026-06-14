# Task Board + FSM Logic Driver Investigation

Date: 2026-06-14

## Goal

Add two related capabilities to Local Cognitive AI System:

1. A task board where the user creates tasks with title and description, and an orchestrator takes them into work.
2. A visual FSM / logic driver where tasks are executed through agent states and guarded transitions, instead of a plain sequential loop.

The desired UX is closer to a state-machine editor: nodes represent agent/tool/decision states, edges represent transitions, and runtime status is visible directly on the graph.

## Current Architecture Snapshot

The system is a local TypeScript/Node application with Express API, browser dashboard, Telegram/MCP transports, local/cloud LLM providers, JSON persistence, and a vanilla frontend in `public/assets/app.js`.

Important existing entry points:

- `src/index.ts`: process/server entry.
- `src/app/buildRuntime.ts`: composition root for providers, memory, agents, tools, router, and `CognitiveEngine`.
- `src/core/CognitiveEngine.ts`: atomic input processing pipeline.
- `src/api/routes.ts`: HTTP API surface.
- `src/types/index.ts`: shared contracts.
- `public/assets/app.js`: dashboard route/state/rendering logic.

Execution today:

1. UI/API/Telegram/MCP sends one input.
2. `CognitiveEngine.process()` loads session settings, memory, conversation, and chooses a mode.
3. `Router` dispatches to `general`, `code`, or `hypothesis`.
4. The selected handler calls LLMs/agents.
5. Tools may execute after the LLM result.
6. The result is saved to memory.

Current orchestration exists, but it is fixed:

- `code` mode has `runCodeSwarm()` with subagent selection, parallel advisor runs, fallback, and collector/writer behavior.
- `hypothesis` mode has a fixed debate flow with support/attack/judge roles.
- There are no first-class `Task`, `Workflow`, `StateNode`, `Transition`, `Guard`, `WorkflowRun`, or `NodeRun` entities yet.

## Main Design Decision

Do not put the board/FSM directly inside `CognitiveEngine.process()`.

Use this split:

- `CognitiveEngine`: atomic executor for one prompt-like step.
- `TaskBoard`: backlog/queue and run control.
- `WorkflowRunner`: persisted execution of a graph.
- `FsmEngine`: transition selection and guard evaluation.
- `WorkflowStore`/`TaskStore`: durable definitions and run state.

This keeps the current chat/debate/code modes intact while adding a real orchestration layer above them.

## Proposed Domains

### Tasks

Suggested files:

- `src/tasks/types.ts`
- `src/tasks/TaskStore.ts`
- `src/tasks/TaskRunner.ts` or `src/tasks/TaskQueue.ts`
- API controllers in `src/api/controller.ts`
- routes in `src/api/routes.ts`

Minimal task shape:

```ts
type TaskStatus =
  | "backlog"
  | "queued"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: "low" | "normal" | "high";
  sessionId?: string;
  workflowId?: string;
  lastRunId?: string;
  createdAt: string;
  updatedAt: string;
}
```

MVP persistence can mirror existing JSON stores, for example `data/tasks/tasks.json`. If execution becomes parallel or multi-process, move the queue/run state to SQLite or Redis-backed queueing.

### Workflows

Suggested files:

- `src/workflows/types.ts`
- `src/workflows/WorkflowStore.ts`
- `src/workflows/WorkflowRunner.ts`
- `src/workflows/FsmEngine.ts`
- `src/workflows/guards.ts`

Minimal workflow shape:

```ts
type WorkflowNodeType =
  | "entry"
  | "agent"
  | "decision"
  | "tool"
  | "debate"
  | "human_review"
  | "terminal";

interface WorkflowDefinition {
  id: string;
  name: string;
  version: number;
  entryNodeId: string;
  nodes: WorkflowNode[];
  transitions: WorkflowTransition[];
  createdAt: string;
  updatedAt: string;
}

interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

interface WorkflowTransition {
  id: string;
  from: string;
  to: string;
  label?: string;
  priority: number;
  condition:
    | { type: "always" }
    | { type: "status"; equals: "ok" | "failed" | "needs_input" }
    | { type: "json_path"; path: string; op: "eq" | "contains" | "exists"; value?: unknown }
    | { type: "llm_router"; prompt: string; allowedTargets: string[] };
}
```

Execution run state:

```ts
interface WorkflowRun {
  id: string;
  taskId: string;
  workflowId: string;
  status: "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";
  currentNodeId?: string;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface NodeRun {
  id: string;
  runId: string;
  nodeId: string;
  status: "running" | "ok" | "failed" | "skipped";
  input: unknown;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
}
```

## Node Execution Model

Each node should return structured output, not only natural language:

```ts
interface NodeResult {
  status: "ok" | "failed" | "needs_input" | "blocked";
  summary: string;
  data: Record<string, unknown>;
  artifacts?: Array<{ name: string; path?: string; contentType?: string }>;
  error?: string;
}
```

This is required for reliable transitions. Guards should read `status` and `data`, not parse prose.

Possible node adapters:

- `agent`: call a selected `CodeAgentTarget`/provider/model with a node prompt.
- `decision`: ask an LLM for structured JSON routing output.
- `tool`: call a registered `ToolRegistry` tool.
- `debate`: reuse the existing hypothesis/debate flow.
- `human_review`: pause the run until the user approves/edits state.
- `terminal`: mark run done/failed.

## API Surface

Add routes near existing session/chat routes:

```txt
GET    /tasks
POST   /tasks
PATCH  /tasks/:taskId
POST   /tasks/:taskId/queue
POST   /tasks/:taskId/run
POST   /tasks/:taskId/cancel

GET    /workflows
POST   /workflows
GET    /workflows/:workflowId
PUT    /workflows/:workflowId
POST   /workflows/:workflowId/validate

GET    /workflow-runs/:runId
GET    /workflow-runs/:runId/events
POST   /workflow-runs/:runId/resume
POST   /workflow-runs/:runId/cancel
```

For MVP, polling is enough. For better UX, add Server-Sent Events for run/node status updates.

## UI Plan

Current UI is vanilla JS in `public/assets/app.js`; routes are currently `chat`, `models`, `plugins`, `settings`.

MVP UI:

- Add route `board`.
- Board columns: Backlog, Queued, Running, Blocked, Done, Failed.
- Task editor: title, description, priority, workflow selection.
- Run panel: current status, last run, node log.

FSM editor options:

1. Vanilla SVG/canvas editor in current `public/assets/app.js`.
   - Lowest integration cost.
   - Enough for MVP: drag nodes, connect edges, edit side panel.
   - More custom work for selection, zoom, minimap, edge labels.

2. React Flow (`@xyflow/react`).
   - Best if the frontend is migrated to React/Vite.
   - Strong fit for nodes/edges, custom nodes, handles, edge labels, minimap, save/restore.
   - Higher migration cost because the current frontend is not React.

3. Rete.js.
   - Strong fit for visual programming and graph processing.
   - Supports dataflow/control-flow style editors.
   - More framework/plugin complexity than a simple FSM editor.

Recommendation:

- MVP: implement a small vanilla graph editor to avoid frontend migration.
- Later: migrate dashboard to React/Vite and use React Flow if the visual editor becomes a core product surface.

## Runtime Strategy

MVP runner:

- Single-process local queue.
- JSON store with careful sequential writes.
- One active workflow run at a time by default.
- Step-based execution: after each node, persist `WorkflowRun` and `NodeRun`, then choose the next transition.

Growth path:

- SQLite for locking and run history.
- BullMQ if Redis is acceptable and background processing/concurrency/retries matter.
- Temporal if workflows become long-running, need strong durable execution, cancellation, timers, retries, and worker processes.

## External References Checked

- LangGraph docs describe low-level orchestration for long-running stateful agents, with persistence, human-in-the-loop, durable execution, and graph APIs for nodes/edges/conditional routing: https://docs.langchain.com/oss/javascript/langgraph/overview
- LangGraph workflow examples cover prompt chaining, parallelization, routing, and orchestrator-worker patterns: https://docs.langchain.com/oss/javascript/langgraph/workflows-agents
- LangGraph Graph API documents normal edges, conditional edges, entry points, `Send`, and `Command`: https://docs.langchain.com/oss/javascript/langgraph/graph-api
- LangGraph persistence separates checkpointers for thread graph state and stores for long-term data: https://docs.langchain.com/oss/javascript/langgraph/persistence
- React Flow docs cover visual node/edge editors and custom graph UI components: https://reactflow.dev/learn
- Rete.js docs position it as a framework for visual workflows with dataflow and control-flow processing: https://retejs.org/docs/
- Node-RED editor docs are a useful UX reference for nodes, ports, wires, status, node config, disabled nodes, and visual errors: https://nodered.org/docs/user-guide/editor/workspace/nodes
- BullMQ docs cover Redis-backed job queues, workers, progress, failures, retries, delayed jobs, priorities, and concurrency: https://docs.bullmq.io/
- Temporal TypeScript docs cover workflows, activities, workers, client APIs, timeouts, schedules, cancellation, and durable app structure: https://docs.temporal.io/develop/typescript

## Recommended First Milestone

Build the thin vertical slice:

1. `TaskStore` with JSON persistence and CRUD API.
2. `WorkflowStore` with one default workflow.
3. `WorkflowRunner` that can execute a task through `entry -> agent -> terminal`.
4. Board route in the UI.
5. Run detail view with persisted node log.
6. One deterministic transition guard: `status == ok` / `status == failed`.

Do not start with a full graph UI. First prove that a task can be queued, executed, persisted, inspected, retried, and cancelled. Then add the visual editor.

