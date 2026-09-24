import { NodeConfigFields } from "./NodeConfigFields";
import { ModelPicker } from "./ModelPicker";
import { RunSettings } from "./RunSettings";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  useReactFlow,
  type Connection,
  type Edge,
  type Node
} from "@xyflow/react";
import { FsmNode } from "./FsmNode";
import { GuardEdge } from "./GuardEdge";
import { WorkflowConsole } from "./WorkflowConsole";
import { toFlowEdges, toFlowNodes, uniqueId, renameNodeBindings, type FsmNodeData, type FsmEdgeData } from "./workflowAdapter";
import type {
  TransitionGuard,
  WorkflowDefinition,
  WorkflowConsoleViewState,
  WorkflowEditorProps,
  WorkflowNodeDefinition,
  WorkflowNodeType,
  WorkflowTransitionDefinition
} from "./types";

const RUNNABLE_NODE_TYPES: Array<{ type: WorkflowNodeType; label: string }> = [
  { type: "agent", label: "Agent" },
  { type: "file_search", label: "Files" },
  { type: "web_search", label: "Search web" },
  { type: "web_fetch", label: "Read webpage" },
  { type: "file_read", label: "Read file" },
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

function flowEdges(workflow: WorkflowDefinition): Edge<FsmEdgeData>[] {
  return toFlowEdges(workflow).map((edge) => ({
    ...edge,
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }
  }));
}

const subscribeMotion = (callback: () => void) => {
  window.addEventListener("lcai:motion", callback);
  return () => window.removeEventListener("lcai:motion", callback);
};
const readMotion = () => document.documentElement.dataset.motion !== "off";

function WorkflowEditorInner(props: WorkflowEditorProps) {
  const motion = useSyncExternalStore(subscribeMotion, readMotion);
  const flow = useReactFlow();
  useEffect(() => {
    if (!motion) void flow.setViewport(flow.getViewport(), { duration: 0 });
  }, [motion, flow]);
  const [draft, setDraft] = useState(() => cloneWorkflow(props.workflow));
  const draftRef = useRef(draft);
  const [nodes, setNodes, applyNodeChanges] = useNodesState(toFlowNodes(draft));
  const [edges, setEdges, applyEdgeChanges] = useEdgesState(flowEdges(draft));
  const [selected, setSelected] = useState<{ kind: "node" | "edge"; id: string } | null>(props.initialViewState?.selected ?? null);
  const [configError, setConfigError] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(props.initialViewState?.inspectorOpen ?? true);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState("");
  const [mapOpen, setMapOpen] = useState(props.initialViewState?.mapOpen ?? false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDetailsElement>(null);
  const [consoleNodeId, setConsoleNodeId] = useState(props.initialViewState?.consoleNodeId ?? "");
  const [followActive, setFollowActive] = useState(props.initialViewState?.followActive ?? false);
  const execution = props.execution;
  useEffect(() => {
    if (consoleNodeId && execution?.run.workflowSnapshot && !execution.run.workflowSnapshot.nodes.some(node => node.id === consoleNodeId)) setConsoleNodeId("");
  }, [execution?.run.id, execution?.run.workflowSnapshot, consoleNodeId]);
  const activeRun = Boolean(execution && !["done", "failed", "cancelled"].includes(execution.run.status));
  const readOnly = activeRun || runBusy || props.starting;
  const consoleCapture = useRef<() => WorkflowConsoleViewState>(undefined);
  const runSettingsOpen = useRef(props.initialViewState?.runSettingsOpen ?? false);
  const inspectorRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (inspectorRef.current) inspectorRef.current.scrollTop = props.initialViewState?.inspectorScrollTop ?? 0; }, []);
  useLayoutEffect(() => {
    props.onCaptureState?.(() => ({ selected, inspectorOpen, mapOpen, consoleNodeId, followActive,
      viewport: flow.getViewport(), runSettingsOpen: runSettingsOpen.current,
      inspectorScrollTop: inspectorRef.current?.scrollTop ?? 0, console: consoleCapture.current?.() }));
  });
  const pendingReview = execution?.run.status === "waiting"
    ? execution.nodeRuns.filter(run => run.nodeId === execution.run.currentNodeId && run.status === "waiting").at(-1) : undefined;
  const reviewKey = pendingReview ? `${execution!.run.id}:${pendingReview.id}:${pendingReview.output?.data?.approvalId ?? "review"}` : "";
  const [reviewState, setReviewState] = useState({ key: "", busy: false, error: "" });
  const reviewingRef = useRef("");
  const decideReview = useCallback(async (approved: boolean) => {
    if (!execution || !pendingReview || !props.onReview || reviewingRef.current) return;
    const approval = pendingReview.output?.data;
    if (approval?.permissionRequired && typeof approval.approvalId !== "string") return;
    reviewingRef.current = reviewKey;
    setReviewState({ key: reviewKey, busy: true, error: "" });
    try {
      await props.onReview(execution.run.id, { approved,
        ...(approval?.permissionRequired ? { approvalId: String(approval.approvalId) } : { waitingNodeRunId: pendingReview.id }) });
      setReviewState({ key: reviewKey, busy: false, error: "" });
    } catch (error) {
      setReviewState({ key: reviewKey, busy: false, error: error instanceof Error ? error.message : String(error) });
    } finally { reviewingRef.current = ""; }
  }, [execution, pendingReview, props.onReview, reviewKey]);
  const focusNode = useCallback((id: string) => {
    const node = draft.nodes.find(item => item.id === id);
    if (node) void flow.setCenter(node.position.x + 110, node.position.y + (pendingReview?.nodeId === id ? -70 : 60),
      { zoom: pendingReview?.nodeId === id ? 0.85 : Math.max(0.75, flow.getZoom()), duration: pendingReview?.nodeId === id ? 0 : motion ? 240 : 0 });
  }, [draft.nodes, flow, motion, pendingReview?.nodeId]);
  useEffect(() => {
    if (followActive && execution?.run.currentNodeId) focusNode(execution.run.currentNodeId);
  }, [followActive, execution?.run.currentNodeId, focusNode]);
  useEffect(() => {
    if (!reviewKey || !pendingReview) return;
    const node = draft.nodes.find(item => item.id === pendingReview.nodeId);
    if (!node) return;
    // Leave space above the node for the unscaled approval card, including on small windows.
    let frame = 0;
    const center = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void flow.setCenter(node.position.x + 110, node.position.y - 70, { zoom: 0.85, duration: 0 }));
    };
    const observer = new ResizeObserver(center);
    if (canvasRef.current) observer.observe(canvasRef.current);
    center();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [reviewKey, draft.nodes, flow, motion]);
  const displayedNodes = useMemo(() => {
    const runByNode = new Map((execution?.nodeRuns ?? props.nodeRuns ?? []).map((run) => [run.nodeId, run]));
    if (execution?.run.currentNodeId) {
      const id = execution.run.currentNodeId;
      const previous = runByNode.get(id);
      const status = execution.run.status;
      if (["queued", "waiting", "interrupted", "cancelled", "blocked", "failed"].includes(status) &&
        (!previous || ["running", "waiting"].includes(previous.status) || status === "queued" || status === "failed")) {
        runByNode.set(id, { ...previous, nodeId: id, status, progress: undefined });
      }
    }
    return nodes.map((node) => ({ ...node, selected: selected?.kind === "node" && selected.id === node.id, data: { ...node.data, run: runByNode.get(node.id),
      review: pendingReview?.nodeId === node.id && props.onReview ? {
        busy: reviewState.key === reviewKey && reviewState.busy,
        error: reviewState.key === reviewKey ? reviewState.error : "", decide: decideReview
      } : undefined } }));
  }, [nodes, props.nodeRuns, execution, pendingReview, props.onReview, reviewState, reviewKey, decideReview, selected]);
  const displayedEdges = useMemo(() => {
    const visited = new Set(execution?.nodeRuns.map(run => run.transitionId).filter(Boolean));
    const lastTransition = execution?.events.filter(event => event.type === "transition").at(-1)?.transitionId ??
      execution?.nodeRuns.filter(run => run.transitionId).at(-1)?.transitionId;
    return edges.map(edge => ({ ...edge, selected: selected?.kind === "edge" && selected.id === edge.id, markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16,
      color: visited.has(edge.id) ? "var(--accent)" : "var(--muted)" }, data: { ...edge.data!, visited: visited.has(edge.id),
      active: edge.id === lastTransition && edge.target === execution?.run.currentNodeId && ["running", "queued"].includes(execution.run.status) } }));
  }, [edges, execution, selected]);

  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      const menu = addMenuRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) {
        menu.open = false;
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      const menu = addMenuRef.current;
      if (event.key === "Escape" && menu?.open) {
        menu.open = false;
        menu.querySelector("summary")?.focus();
      }
    };
    // Capture outside presses even when canvas controls stop propagation.
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, []);

  const commit = useCallback((mutate: (next: WorkflowDefinition) => void) => {
    if (readOnly) return;
    const next = cloneWorkflow(draftRef.current);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    draftRef.current = next;
    setDraft(next);
    setNodes(toFlowNodes(next));
    setEdges(flowEdges(next));
    props.onChange(cloneWorkflow(next));
  }, [props.onChange, readOnly, setEdges, setNodes]);

  const selectedNode = selected?.kind === "node"
    ? draft.nodes.find((node) => node.id === selected.id) ?? null
    : null;
  const selectedEdge = selected?.kind === "edge"
    ? draft.transitions.find((transition) => transition.id === selected.id) ?? null
    : null;

  const onNodesChange = useCallback((changes: Parameters<typeof applyNodeChanges>[0]) => {
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

  const onEdgesChange = useCallback((changes: Parameters<typeof applyEdgeChanges>[0]) => {
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

  const isValidConnection = useCallback((connection: Connection | Edge) => {
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
      next.nodes.forEach(item => { item.config = renameNodeBindings(item.config, previousId, nextId) as Record<string, unknown>; });
      if (next.entryNodeId === previousId) next.entryNodeId = nextId;
      next.transitions.forEach((transition) => {
        if (transition.from === previousId) transition.from = nextId;
        if (transition.to === previousId) transition.to = nextId;
        if (transition.guard.type === "json_path") {
          const prefix = `state.nodeResults.${previousId}`;
          if (transition.guard.path === prefix || transition.guard.path.startsWith(`${prefix}.`)) transition.guard.path = `state.nodeResults.${nextId}${transition.guard.path.slice(prefix.length)}`;
        }
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
    <div className={`fsm-editor ${inspectorOpen ? "" : "fsm-editor--inspector-hidden"} ${execution ? "fsm-editor--run" : ""} ${pendingReview ? "fsm-editor--approval" : ""}`}>
      <div className="fsm-toolbar">
        <div>
          <strong>{draft.name}</strong>
          <span>{execution ? `Run ${execution.run.id.slice(0, 8)} · v${draft.version} · ${draft.nodes.length} nodes` : `${draft.nodes.length} nodes · ${draft.transitions.length} transitions`}</span>
        </div>
        <div className="fsm-toolbar__actions">
          {execution && props.onStop && activeRun ? <button type="button" className="danger fsm-stop-button" disabled={runBusy} onClick={async () => {
            setRunBusy(true); try { await props.onStop!(execution.run.id); } catch (error) { setRunError(String(error)); } finally { setRunBusy(false); }
          }}>Stop</button> : null}
          {execution?.run.status === "interrupted" && props.onResume ? <button type="button" disabled={runBusy} onClick={async () => {
            setRunBusy(true); setRunError(""); try { await props.onResume!(execution.run.id); } catch (error) { setRunError(String(error)); } finally { setRunBusy(false); }
          }}>Resume</button> : null}
          {!activeRun && props.onRun ? <button type="button" className="fsm-run-button" disabled={runBusy || props.starting || Boolean(configError)} onClick={async () => {
            setRunBusy(true); setRunError("");
            try { await props.onRun!(cloneWorkflow(draftRef.current)); } catch (error) { setRunError(error instanceof Error ? error.message : String(error)); } finally { setRunBusy(false); }
          }}>{runBusy || props.starting ? "Starting…" : "▶ Run"}</button> : null}
          {execution ? <>
            <button type="button" onClick={() => execution.run.currentNodeId && focusNode(execution.run.currentNodeId)}>Focus active</button>
            <button type="button" aria-pressed={followActive} onClick={() => setFollowActive(value => !value)}>Follow active</button>
          </> : null}
          <details className="fsm-add-menu" ref={addMenuRef}>
            <summary aria-disabled={readOnly} onClick={event => { if (readOnly) event.preventDefault(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>Add step</summary>
            <div className="fsm-add-menu__items" onClick={() => {
              if (addMenuRef.current) addMenuRef.current.open = false;
            }}>
              {RUNNABLE_NODE_TYPES.map((item) => (
                <button key={item.type} type="button" onClick={() => {
                  addNode(item.type);
                  setInspectorOpen(true);
                }}>{item.label}</button>
              ))}
            </div>
          </details>
          <button type="button" aria-pressed={mapOpen} onClick={() => setMapOpen((open) => !open)}>Map</button>
          <button type="button" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen((open) => !open)}>Inspector</button>
        </div>
      </div>

      {runError ? <div className="fsm-field-error" role="alert">{runError}</div> : null}
      <RunSettings key={draft.id} options={draft.runDefaults ?? {}} projects={props.projects} onChooseFolder={props.onChooseFolder}
        hasRun={Boolean(execution)} disabled={readOnly} initiallyOpen={props.initialViewState?.runSettingsOpen} onOpenChange={open => { runSettingsOpen.current = open; }}
        onUpdate={runDefaults => updateWorkflow({ runDefaults })} />
      {props.validation && !props.validation.ok ? (
        <div className={`fsm-validation ${props.validation.ok ? "is-valid" : "is-invalid"}`}>
          <strong>{props.validation.ok ? "Workflow valid" : "Validation failed"}</strong>
          {!props.validation.ok ? <span>{props.validation.errors.join(" ")}</span> : null}
        </div>
      ) : null}

      <div className="fsm-workspace">
        <div className="fsm-canvas" ref={canvasRef}>
          <ReactFlow
            nodes={displayedNodes}
            edges={displayedEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode={props.colorMode}
            proOptions={{ hideAttribution: true }}
            defaultMarkerColor="var(--muted)"
            fitView={!props.initialViewState?.viewport}
            defaultViewport={props.initialViewState?.viewport}
            fitViewOptions={{ padding: 0.25, maxZoom: 1.15 }}
            zoomOnDoubleClick={motion}
            onDoubleClick={event => {
              if (!motion && (event.target as HTMLElement).classList.contains("react-flow__pane")) void flow.zoomIn({ duration: 0 });
            }}
            minZoom={0.25}
            maxZoom={1.8}
            deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            edgesReconnectable={!readOnly}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onNodeClick={(_, node) => { setSelected({ kind: "node", id: node.id }); setInspectorOpen(true); }}
            onEdgeClick={(_, edge) => { setSelected({ kind: "edge", id: edge.id }); setInspectorOpen(true); }}
            onPaneClick={() => setSelected(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} bgColor="var(--bg)" color="var(--line-strong)" />
            <Controls showInteractive={false} fitViewOptions={{ duration: 0 }} />
            {mapOpen ? <MiniMap<Node<FsmNodeData>>
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
            /> : null}
          </ReactFlow>
        </div>

        <aside className="fsm-inspector" ref={inspectorRef} hidden={!inspectorOpen}>
          <div className="fsm-inspector__header">
            <div>
              <span>Inspector</span>
              <strong>{selectedNode?.label ?? selectedEdge?.label ?? selectedEdge?.id ?? "Workflow"}</strong>
            </div>
            {selected ? <button type="button" className="danger" disabled={readOnly} onClick={deleteSelected}>Delete</button> : null}
          </div>

          {readOnly ? <p className="fsm-model-hint">Run in progress. Settings unlock when it finishes or you press Stop.</p> : null}
          <fieldset className="fsm-settings-fields" disabled={readOnly}>
          {!selected ? (
            <WorkflowFields draft={draft} onUpdate={updateWorkflow} />
          ) : selectedNode ? (
            <NodeFields
              disabled={Boolean(readOnly)}
              node={selectedNode}
              nodes={draft.nodes}
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
          </fieldset>
        </aside>
      </div>
      <WorkflowConsole providers={props.providers} execution={execution} workflow={execution?.run.workflowSnapshot ?? draft}
        nodeFilter={consoleNodeId} onFilter={setConsoleNodeId} onFocus={focusNode} initialState={props.initialViewState?.console} onCaptureState={capture => { consoleCapture.current = capture; }} />
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
      <p className="fsm-model-hint">Choose a folder in Run settings, then press Run. The same workflow can also run from a task.</p>
    </div>
  );
}

function NodeFields({ node, nodes, disabled, entryNodeId, providers, configError, onConfigError, onRename, onUpdate, onConfigUpdate, onSetEntry }: {
  node: WorkflowNodeDefinition;
  nodes: WorkflowNodeDefinition[];
  disabled: boolean;
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
          {["entry", "agent", "file_search", "file_read", "web_search", "web_fetch", "file_write", "command", "decision", "tool", "human_review", "terminal"].map((type) => <option key={type}>{type}</option>)}
        </select>
      </Field>
      {entryNodeId !== node.id ? <button type="button" onClick={onSetEntry}>Set as entry</button> : <div className="fsm-inline-status">Entry node</div>}
      {node.type === "agent" ? (
        <>
          <Field label="Provider">
            <select aria-label="Provider" value={providerId} onChange={(event) => onConfigUpdate({ providerId: event.target.value, model: "" })}>
              <option value="">Run default</option>
              {providerId && !provider ? <option value={providerId} disabled>{providerId} · unavailable</option> : null}
              {providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </Field>
          <Field label="Model">
            <ModelPicker key={`${node.id}-${providerId}`} provider={provider} value={model} disabled={disabled}
              describedBy={provider?.installedOnly ? `fsm-model-note-${node.id}` : undefined} onChange={model => onConfigUpdate({ model })} />
            {provider?.installedOnly ? <span id={`fsm-model-note-${node.id}`} className={(model || provider.defaultModel) && !provider.models.includes(model || provider.defaultModel!) || !provider.models.length ? "fsm-model-warning" : "fsm-model-hint"}>
              {(model || provider.defaultModel) && !provider.models.includes(model || provider.defaultModel!) ? "This model is unavailable or incompatible. Check Models and choose a supported model." : !provider.models.length ? "Download a model in Models before running this node." : "Installed models load automatically when this node runs."}
            </span> : null}
          </Field>
        </>
      ) : null}
      {["agent", "file_search", "file_read", "file_write", "command"].includes(node.type) ? <>
        <p className="fsm-model-hint">Paths start in the run’s workspace folder.</p>
        <div className="fsm-output-contract"><span>Workspace bindings</span><code>{"{{workspace.rootPath}} · {{workspace.outputDir}} · {{project.name}} · {{project.id}}"}</code></div>
      </> : null}
      {["agent", "file_read", "file_search", "file_write", "command", "web_fetch"].includes(node.type) ? <Field label="Step access"><select aria-label="Step access" value={["never", "always"].includes(String(node.config.approval)) ? String(node.config.approval) : ""} onChange={event => onConfigUpdate({ approval: event.target.value })}>
        {!["never", "always"].includes(String(node.config.approval)) ? <option value="" disabled>Existing rules · choose to override</option> : null}
        <option value="always">Ask</option><option value="never">Full access · no requests</option>
      </select><span className="fsm-model-hint">Ask shows Approve / Reject above this node. Full access runs this step’s actions without asking.</span>
        {!["never", "always"].includes(String(node.config.approval)) ? <span className="fsm-model-hint">This saved step keeps its previous access rules until you choose a mode.</span> : null}
      </Field> : null}
      {node.type === "agent" ? <p className="fsm-model-hint">Agents read files, inspect tool results, and continue until done or the execution limit is reached.</p> : null}
      <NodeConfigFields node={node} nodes={nodes} onUpdate={onConfigUpdate} />
      <details className="fsm-advanced-config"><summary>Advanced JSON</summary>
      <Field label="Config JSON">
        <textarea
          key={`${node.id}-${JSON.stringify(node.config)}`}
          rows={8}
          defaultValue={JSON.stringify(node.config, null, 2)}
          onBlur={(event) => {
            try {
              const parsed: unknown = JSON.parse(event.target.value);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected an object");
              onConfigError("");
              onUpdate({ config: parsed as Record<string, unknown> });
            } catch {
              onConfigError("Config must be a JSON object.");
            }
          }}
        />
      </Field>
      </details>
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
  const [valueError, setValueError] = useState("");
  const jsonGuard = edge.guard.type === "json_path" ? edge.guard : null;
  const updateGuardType = (type: TransitionGuard["type"]) => {
    setValueError("");
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
          <Field label="JSON path"><input value={edge.guard.path} onChange={(event) => onUpdate({ guard: { ...jsonGuard!, path: event.target.value } })} /></Field>
          <Field label="Operation">
            <select value={edge.guard.op} onChange={(event) => onUpdate({ guard: { ...jsonGuard!, op: event.target.value as "eq" | "exists" | "contains" } })}>
              {["exists", "eq", "contains"].map((op) => <option key={op}>{op}</option>)}
            </select>
          </Field>
          {edge.guard.op !== "exists" ? <Field label="Comparison value (JSON)">
            <input key={`${edge.id}-${JSON.stringify(edge.guard.value)}`}
              defaultValue={JSON.stringify(edge.guard.value) ?? ""} placeholder={'0, false, or "text"'}
              onBlur={(event) => {
                try {
                  const value: unknown = JSON.parse(event.target.value);
                  onUpdate({ guard: { ...jsonGuard!, value } });
                  setValueError("");
                } catch { setValueError('Enter a JSON value, such as 0, false, or "text".'); }
              }} />
          </Field> : null}
          {valueError ? <div className="fsm-field-error">{valueError}</div> : null}
        </>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="fsm-field"><span>{label}</span>{children}</label>;
}

function defaultNodeConfig(type: WorkflowNodeType): Record<string, unknown> {
  if (type === "agent") return { mode: "code", promptTemplate: "{{input.title}}\n\n{{input.description}}", approval: "always" };
  if (type === "web_fetch") return { urlTemplate: "https://example.com", maxChars: 12000, approval: "always" };
  if (type === "file_read") return { path: "findings.md", startLine: 1, approval: "always" };
  if (type === "file_search") return {
    approval: "always",
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
    approval: "always",
    path: "workflow-output.md",
    mode: "overwrite",
    contentTemplate: "{{nodes.agent.data.response}}"
  };
  if (type === "command") return {
    approval: "always",
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
    case "web_fetch": return `${prefix}.data.text · ${prefix}.data.url · ${prefix}.data.truncated`;
    case "file_read": return `${prefix}.data.content · ${prefix}.data.path · ${prefix}.data.truncated`;
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
