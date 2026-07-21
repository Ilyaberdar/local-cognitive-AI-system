import { useCallback, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type EdgeChange,
  type NodeChange
} from "@xyflow/react";
import { FsmNode } from "./FsmNode";
import { GuardEdge } from "./GuardEdge";
import { toFlowEdges, toFlowNodes, uniqueId } from "./workflowAdapter";
import type {
  TransitionGuard,
  WorkflowDefinition,
  WorkflowEditorProps,
  WorkflowNodeDefinition,
  WorkflowNodeType,
  WorkflowTransitionDefinition
} from "./types";

const RUNNABLE_NODE_TYPES: Array<{ type: WorkflowNodeType; label: string }> = [
  { type: "agent", label: "Agent" },
  { type: "file_search", label: "Files" },
  { type: "web_search", label: "Web" },
  { type: "file_write", label: "Save" },
  { type: "command", label: "Command" },
  { type: "decision", label: "Decision" },
  { type: "human_review", label: "Review" },
  { type: "terminal", label: "Terminal" }
];
const nodeTypes = { fsmNode: FsmNode };
const edgeTypes = { guardEdge: GuardEdge };

function cloneWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  return structuredClone(workflow);
}

function flowEdges(workflow: WorkflowDefinition) {
  return toFlowEdges(workflow).map((edge) => ({
    ...edge,
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }
  }));
}

function WorkflowEditorInner(props: WorkflowEditorProps) {
  const [draft, setDraft] = useState(() => cloneWorkflow(props.workflow));
  const draftRef = useRef(draft);
  const [nodes, setNodes, applyNodeChanges] = useNodesState(toFlowNodes(draft));
  const [edges, setEdges, applyEdgeChanges] = useEdgesState(flowEdges(draft));
  const [selected, setSelected] = useState<{ kind: "node" | "edge"; id: string } | null>(null);
  const [configError, setConfigError] = useState("");

  const commit = useCallback((mutate: (next: WorkflowDefinition) => void) => {
    const next = cloneWorkflow(draftRef.current);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    draftRef.current = next;
    setDraft(next);
    setNodes(toFlowNodes(next));
    setEdges(flowEdges(next));
    props.onChange(cloneWorkflow(next));
  }, [props.onChange, setEdges, setNodes]);

  const selectedNode = selected?.kind === "node"
    ? draft.nodes.find((node) => node.id === selected.id) ?? null
    : null;
  const selectedEdge = selected?.kind === "edge"
    ? draft.transitions.find((transition) => transition.id === selected.id) ?? null
    : null;

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const removed = changes.filter((change) => change.type === "remove").map((change) => change.id);

    if (removed.length) {
      commit((next) => {
        next.nodes = next.nodes.filter((node) => !removed.includes(node.id));
        next.transitions = next.transitions.filter(
          (transition) => !removed.includes(transition.from) && !removed.includes(transition.to)
        );
        if (removed.includes(next.entryNodeId)) next.entryNodeId = next.nodes[0]?.id ?? "";
      });
      setSelected((current) => current?.kind === "node" && removed.includes(current.id) ? null : current);
      return;
    }

    applyNodeChanges(changes);
  }, [applyNodeChanges, commit]);

  const onNodeDragStop = useCallback((_: unknown, node: { id: string; position: { x: number; y: number } }) => {
    commit((next) => {
      const definition = next.nodes.find((item) => item.id === node.id);
      if (definition) definition.position = node.position;
    });
  }, [commit]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const removed = changes.filter((change) => change.type === "remove").map((change) => change.id);
    if (removed.length) {
      commit((next) => {
        next.transitions = next.transitions.filter((transition) => !removed.includes(transition.id));
      });
      setSelected((current) => current?.kind === "edge" && removed.includes(current.id) ? null : current);
      return;
    }

    applyEdgeChanges(changes);
  }, [applyEdgeChanges, commit]);

  const isValidConnection = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return false;
    const source = draft.nodes.find((node) => node.id === connection.source);
    const target = draft.nodes.find((node) => node.id === connection.target);
    if (!source || !target || source.type === "terminal" || target.type === "entry") return false;
    return !draft.transitions.some(
      (transition) => transition.from === connection.source && transition.to === connection.target
    );
  }, [draft]);

  const onConnect = useCallback((connection: Connection) => {
    if (!isValidConnection(connection) || !connection.source || !connection.target) return;
    commit((next) => {
      const baseId = `${connection.source}-${connection.target}`;
      next.transitions.push({
        id: uniqueId(baseId, next.transitions.map((transition) => transition.id)),
        from: connection.source!,
        to: connection.target!,
        priority: 100,
        guard: { type: "always" }
      });
    });
  }, [commit, isValidConnection]);

  const addNode = (type: WorkflowNodeType) => {
    commit((next) => {
      const id = uniqueId(type.replace("human_review", "review"), next.nodes.map((node) => node.id));
      const config = defaultNodeConfig(type);
      next.nodes.push({
        id,
        type,
        label: type === "human_review" ? "Human review" : capitalize(type),
        position: { x: 180 + next.nodes.length * 36, y: 120 + next.nodes.length * 28 },
        config
      });
    });
  };

  const deleteSelected = () => {
    if (!selected) return;
    if (selected.kind === "node") {
      onNodesChange([{ type: "remove", id: selected.id }]);
    } else {
      onEdgesChange([{ type: "remove", id: selected.id }]);
    }
    setSelected(null);
  };

  const updateWorkflow = (patch: Partial<WorkflowDefinition>) => commit((next) => Object.assign(next, patch));
  const updateNode = (patch: Partial<WorkflowNodeDefinition>) => {
    if (!selectedNode) return;
    commit((next) => {
      const node = next.nodes.find((item) => item.id === selectedNode.id);
      if (node) Object.assign(node, patch);
    });
  };
  const renameNode = (nextIdValue: string) => {
    if (!selectedNode) return;
    const nextId = nextIdValue.trim();
    if (!nextId || draft.nodes.some((node) => node.id === nextId && node.id !== selectedNode.id)) return;
    const previousId = selectedNode.id;
    commit((next) => {
      const node = next.nodes.find((item) => item.id === previousId);
      if (!node) return;
      node.id = nextId;
      if (next.entryNodeId === previousId) next.entryNodeId = nextId;
      next.transitions.forEach((transition) => {
        if (transition.from === previousId) transition.from = nextId;
        if (transition.to === previousId) transition.to = nextId;
      });
    });
    setSelected({ kind: "node", id: nextId });
  };
  const updateNodeConfig = (patch: Record<string, unknown>) => {
    if (!selectedNode) return;
    updateNode({ config: { ...selectedNode.config, ...patch } });
  };
  const updateEdge = (patch: Partial<WorkflowTransitionDefinition>) => {
    if (!selectedEdge) return;
    commit((next) => {
      const edge = next.transitions.find((item) => item.id === selectedEdge.id);
      if (edge) Object.assign(edge, patch);
    });
  };

  return (
    <div className="fsm-editor">
      <div className="fsm-toolbar">
        <div>
          <strong>{draft.name}</strong>
          <span>{draft.nodes.length} nodes · {draft.transitions.length} transitions</span>
        </div>
        <div className="fsm-toolbar__actions">
          {RUNNABLE_NODE_TYPES.map((item) => (
            <button key={item.type} type="button" onClick={() => addNode(item.type)}>+ {item.label}</button>
          ))}
        </div>
      </div>

      {props.validation ? (
        <div className={`fsm-validation ${props.validation.ok ? "is-valid" : "is-invalid"}`}>
          <strong>{props.validation.ok ? "Workflow valid" : "Validation failed"}</strong>
          {!props.validation.ok ? <span>{props.validation.errors.join(" ")}</span> : null}
        </div>
      ) : null}

      <div className="fsm-workspace">
        <div className="fsm-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode={props.colorMode}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1.15 }}
            minZoom={0.25}
            maxZoom={1.8}
            deleteKeyCode={["Backspace", "Delete"]}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onNodeClick={(_, node) => setSelected({ kind: "node", id: node.id })}
            onEdgeClick={(_, edge) => setSelected({ kind: "edge", id: edge.id })}
            onPaneClick={() => setSelected(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeStrokeWidth={3}
              bgColor="var(--surface-2)"
              maskColor="color-mix(in srgb, var(--bg) 72%, transparent)"
              nodeStrokeColor="var(--line-strong)"
              nodeColor={(node) => {
                const type = String(node.data?.definition?.type ?? "agent");
                if (type === "entry" || type === "terminal") return "var(--success)";
                if (type === "human_review") return "#d3a74d";
                if (type === "file_search" || type === "web_search") return "#4a9ec2";
                if (type === "file_write") return "#4eaa70";
                if (type === "command" || type === "decision" || type === "tool") return "var(--danger)";
                return "var(--accent)";
              }}
            />
          </ReactFlow>
        </div>

        <aside className="fsm-inspector">
          <div className="fsm-inspector__header">
            <div>
              <span>Inspector</span>
              <strong>{selectedNode?.label ?? selectedEdge?.label ?? selectedEdge?.id ?? "Workflow"}</strong>
            </div>
            {selected ? <button type="button" className="danger" onClick={deleteSelected}>Delete</button> : null}
          </div>

          {!selected ? (
            <WorkflowFields draft={draft} onUpdate={updateWorkflow} />
          ) : selectedNode ? (
            <NodeFields
              node={selectedNode}
              entryNodeId={draft.entryNodeId}
              providers={props.providers}
              configError={configError}
              onConfigError={setConfigError}
              onRename={renameNode}
              onUpdate={updateNode}
              onConfigUpdate={updateNodeConfig}
              onSetEntry={() => updateWorkflow({ entryNodeId: selectedNode.id })}
            />
          ) : selectedEdge ? (
            <EdgeFields edge={selectedEdge} onUpdate={updateEdge} />
          ) : null}
        </aside>
      </div>
      <div className="fsm-editor__hint">Connect node handles to create transitions. Select a node or transition to edit it.</div>
    </div>
  );
}

function WorkflowFields({ draft, onUpdate }: {
  draft: WorkflowDefinition;
  onUpdate: (patch: Partial<WorkflowDefinition>) => void;
}) {
  return (
    <div className="fsm-field-list">
      <Field label="ID"><input value={draft.id} onChange={(event) => onUpdate({ id: event.target.value })} /></Field>
      <Field label="Name"><input value={draft.name} onChange={(event) => onUpdate({ name: event.target.value })} /></Field>
      <Field label="Version"><input type="number" min="1" value={draft.version} onChange={(event) => onUpdate({ version: Math.max(1, Number(event.target.value) || 1) })} /></Field>
      <Field label="Description"><textarea rows={4} value={draft.description ?? ""} onChange={(event) => onUpdate({ description: event.target.value })} /></Field>
    </div>
  );
}

function NodeFields({ node, entryNodeId, providers, configError, onConfigError, onRename, onUpdate, onConfigUpdate, onSetEntry }: {
  node: WorkflowNodeDefinition;
  entryNodeId: string;
  providers: WorkflowEditorProps["providers"];
  configError: string;
  onConfigError: (value: string) => void;
  onRename: (id: string) => void;
  onUpdate: (patch: Partial<WorkflowNodeDefinition>) => void;
  onConfigUpdate: (patch: Record<string, unknown>) => void;
  onSetEntry: () => void;
}) {
  const providerId = typeof node.config.providerId === "string" ? node.config.providerId : "";
  const model = typeof node.config.model === "string" ? node.config.model : "";
  const provider = providers.find((item) => item.id === providerId);

  return (
    <div className="fsm-field-list">
      <Field label="Node ID"><input defaultValue={node.id} key={node.id} onBlur={(event) => onRename(event.target.value)} /></Field>
      <Field label="Label"><input value={node.label} onChange={(event) => onUpdate({ label: event.target.value })} /></Field>
      <Field label="Type">
        <select value={node.type} onChange={(event) => onUpdate({ type: event.target.value as WorkflowNodeType })}>
          {["entry", "agent", "file_search", "web_search", "file_write", "command", "decision", "tool", "human_review", "terminal"].map((type) => <option key={type}>{type}</option>)}
        </select>
      </Field>
      {entryNodeId !== node.id ? <button type="button" onClick={onSetEntry}>Set as entry</button> : <div className="fsm-inline-status">Entry node</div>}
      {node.type === "agent" ? (
        <>
          <Field label="Provider">
            <select value={providerId} onChange={(event) => onConfigUpdate({ providerId: event.target.value, model: "" })}>
              <option value="">Task/session default</option>
              {providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </Field>
          <Field label="Model">
            <input list={`fsm-models-${node.id}`} value={model} placeholder={provider?.defaultModel ?? "Provider default"} onChange={(event) => onConfigUpdate({ model: event.target.value })} />
            <datalist id={`fsm-models-${node.id}`}>{(provider?.models ?? []).map((item) => <option key={item} value={item} />)}</datalist>
          </Field>
        </>
      ) : null}
      <Field label="Config JSON">
        <textarea
          key={`${node.id}-${JSON.stringify(node.config)}`}
          rows={8}
          defaultValue={JSON.stringify(node.config, null, 2)}
          onBlur={(event) => {
            try {
              const parsed = JSON.parse(event.target.value) as Record<string, unknown>;
              onConfigError("");
              onUpdate({ config: parsed });
            } catch {
              onConfigError("Config must be valid JSON.");
            }
          }}
        />
      </Field>
      <div className="fsm-output-contract">
        <span>Output bindings</span>
        <code>{nodeOutputBindings(node)}</code>
      </div>
      {configError ? <div className="fsm-field-error">{configError}</div> : null}
      {node.type === "tool" ? <div className="fsm-warning">The generic tool node is stored but has no runtime executor. Use a specific tool node.</div> : null}
    </div>
  );
}

function EdgeFields({ edge, onUpdate }: {
  edge: WorkflowTransitionDefinition;
  onUpdate: (patch: Partial<WorkflowTransitionDefinition>) => void;
}) {
  const updateGuardType = (type: TransitionGuard["type"]) => {
    if (type === "status") onUpdate({ guard: { type, equals: "ok" } });
    else if (type === "event") onUpdate({ guard: { type, equals: "" } });
    else if (type === "json_path") onUpdate({ guard: { type, path: "", op: "exists" } });
    else onUpdate({ guard: { type: "always" } });
  };

  return (
    <div className="fsm-field-list">
      <Field label="Transition ID"><input value={edge.id} readOnly /></Field>
      <div className="fsm-inline-status">{edge.from} → {edge.to}</div>
      <Field label="Label"><input value={edge.label ?? ""} onChange={(event) => onUpdate({ label: event.target.value || undefined })} /></Field>
      <Field label="Priority"><input type="number" value={edge.priority} onChange={(event) => onUpdate({ priority: Number(event.target.value) || 0 })} /></Field>
      <Field label="Guard">
        <select value={edge.guard.type} onChange={(event) => updateGuardType(event.target.value as TransitionGuard["type"])}>
          {["always", "status", "event", "json_path"].map((type) => <option key={type}>{type}</option>)}
        </select>
      </Field>
      {edge.guard.type === "status" ? (
        <Field label="Status">
          <select value={edge.guard.equals} onChange={(event) => onUpdate({ guard: { type: "status", equals: event.target.value as "ok" | "failed" | "blocked" | "needs_input" } })}>
            {["ok", "failed", "blocked", "needs_input"].map((status) => <option key={status}>{status}</option>)}
          </select>
        </Field>
      ) : null}
      {edge.guard.type === "event" ? <Field label="Event"><input value={edge.guard.equals} onChange={(event) => onUpdate({ guard: { type: "event", equals: event.target.value } })} /></Field> : null}
      {edge.guard.type === "json_path" ? (
        <>
          <Field label="JSON path"><input value={edge.guard.path} onChange={(event) => onUpdate({ guard: { ...edge.guard, path: event.target.value } })} /></Field>
          <Field label="Operation">
            <select value={edge.guard.op} onChange={(event) => onUpdate({ guard: { ...edge.guard, op: event.target.value as "eq" | "exists" | "contains" } })}>
              {["exists", "eq", "contains"].map((op) => <option key={op}>{op}</option>)}
            </select>
          </Field>
        </>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="fsm-field"><span>{label}</span>{children}</label>;
}

function defaultNodeConfig(type: WorkflowNodeType): Record<string, unknown> {
  if (type === "agent") return { mode: "code", promptTemplate: "{{task.title}}\n\n{{task.description}}" };
  if (type === "file_search") return {
    root: ".",
    queryTemplate: "{{task.description}}",
    include: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.json", "**/*.md"],
    exclude: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/release/**"],
    maxFiles: 500,
    maxResults: 40
  };
  if (type === "web_search") return {
    provider: "searxng",
    baseUrl: "http://127.0.0.1:8080",
    queryTemplate: "{{task.title}} {{task.description}}",
    limit: 8
  };
  if (type === "file_write") return {
    access: "default",
    path: "workflow-output.md",
    mode: "overwrite",
    contentTemplate: "{{nodes.agent.data.response}}"
  };
  if (type === "command") return {
    access: "default",
    executable: "npm",
    args: ["test"],
    cwd: ".",
    timeoutMs: 120000
  };
  if (type === "decision") return {
    path: "nodes.command.data.exitCode",
    operator: "eq",
    value: 0
  };
  if (type === "human_review") return { prompt: "Review the current result before continuing." };
  if (type === "terminal") return { runStatus: "done" };
  return {};
}

function nodeOutputBindings(node: WorkflowNodeDefinition): string {
  const prefix = `nodes.${node.id}`;

  switch (node.type) {
    case "agent": return `${prefix}.data.response · ${prefix}.data.tools`;
    case "file_search": return `${prefix}.data.results · ${prefix}.data.scannedFiles`;
    case "web_search": return `${prefix}.data.results · ${prefix}.data.query`;
    case "file_write": return `${prefix}.data.path · ${prefix}.data.bytes`;
    case "command": return `${prefix}.data.exitCode · ${prefix}.data.stdout · ${prefix}.data.stderr`;
    case "decision": return `${prefix}.data.matched · events: decision.true / decision.false`;
    default: return `${prefix}.summary · ${prefix}.data`;
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
}

export function WorkflowEditor(props: WorkflowEditorProps) {
  return <ReactFlowProvider><WorkflowEditorInner {...props} /></ReactFlowProvider>;
}
