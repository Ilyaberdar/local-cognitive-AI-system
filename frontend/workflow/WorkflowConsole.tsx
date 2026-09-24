import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FollowOutputButton } from "./FollowOutputButton";
import { WorkflowActivity } from "./WorkflowActivity";
import type { ProviderOption, WorkflowDefinition, WorkflowExecution, WorkflowLogEvent, WorkflowConsoleViewState } from "./types";

export function WorkflowConsole({ execution, workflow, nodeFilter, onFilter, onFocus, initialState, onCaptureState, providers }: {
  providers: ProviderOption[]; execution?: WorkflowExecution; workflow: WorkflowDefinition; nodeFilter: string;
  onFilter: (id: string) => void; onFocus: (id: string) => void; initialState?: WorkflowConsoleViewState;
  onCaptureState: (capture: () => WorkflowConsoleViewState) => void;
}) {
  const [view, setView] = useState<"both" | "console" | "activity">(initialState?.view ?? "both");
  const [split, setSplit] = useState(initialState?.split ?? 60);
  const [narrow, setNarrow] = useState(false);
  const [activityFollow, setActivityFollow] = useState(initialState?.activityFollow ?? true);
  const panel = useRef<HTMLElement>(null);
  const panes = useRef<HTMLDivElement>(null);
  const activityScroller = useRef<HTMLDivElement>(null);
  const splitDrag = useRef(false);
  const effectiveView = narrow && view === "both" ? "console" : view;
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setNarrow(element.clientWidth < 760));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const [collapsed, setCollapsed] = useState(initialState?.collapsed ?? false);
  const [height, setHeight] = useState(initialState?.height ?? 320);
  const [problemsOnly, setProblemsOnly] = useState(initialState?.problemsOnly ?? false);
  const [follow, setFollow] = useState(initialState?.follow ?? true);
  const [clearedRuns, setClearedRuns] = useState<NonNullable<WorkflowConsoleViewState["clearedRuns"]>>(initialState?.clearedRuns ?? {});
  const [copyLabel, setCopyLabel] = useState("Copy");
  const [now, setNow] = useState(Date.now());
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (scroller.current && initialState) scroller.current.scrollTop = initialState.scrollTop; if (activityScroller.current) activityScroller.current.scrollTop = initialState?.activityScrollTop ?? 0; }, []);
  useLayoutEffect(() => { onCaptureState(() => ({ collapsed, height, problemsOnly, follow, clearedRuns, view, split, activityFollow, activityScrollTop: activityScroller.current?.scrollTop ?? 0, scrollTop: scroller.current?.scrollTop ?? initialState?.scrollTop ?? 0 })); });
  const drag = useRef<{ y: number; height: number } | null>(null);
  const manualScrollUntil = useRef(0);
  const labels = useMemo(() => new Map(workflow.nodes.map(node => [node.id, node.label])), [workflow]);
  const recordedEvents = useMemo<WorkflowLogEvent[]>(() => {
    if (!execution) return [];
    if (execution.events.length || execution.connection !== "live") return execution.events;
    // Runs made by older builds have saved results but no event journal.
    const saved = execution.nodeRuns.filter(node => node.output).map((node, index) => ({
      sequence: -(index + 1), at: node.completedAt ?? node.startedAt ?? execution.run.createdAt,
      type: "node.completed", level: node.status === "failed" ? "error" : "info", nodeId: node.nodeId,
      message: node.output?.summary || `Step ${node.status}`, detail: node.output?.error
    }));
    if (execution.run.error) saved.push({ sequence: -(saved.length + 1), at: execution.run.updatedAt ?? execution.run.createdAt,
      type: "run.status", level: "error", nodeId: execution.run.currentNodeId ?? "", message: "Workflow failed", detail: execution.run.error });
    return saved;
  }, [execution]);
  const cleared = execution ? clearedRuns[execution.run.id] : undefined;
  const remainingEvents = useMemo(() => recordedEvents.filter(event => !cleared ||
    (event.sequence > 0 ? event.sequence > cleared.sequence : -event.sequence > cleared.legacyCount)), [recordedEvents, cleared]);
  const clearLog = () => {
    if (!execution) return;
    const marker = { sequence: Math.max(cleared?.sequence ?? 0, ...recordedEvents.map(event => Math.max(0, event.sequence))),
      legacyCount: Math.max(cleared?.legacyCount ?? 0, ...recordedEvents.map(event => Math.max(0, -event.sequence))) };
    setClearedRuns(current => Object.fromEntries([...Object.entries(current).filter(([id]) => id !== execution.run.id).slice(-19), [execution.run.id, marker]]));
    setCopyLabel("Copy");
    if (scroller.current) scroller.current.scrollTop = 0;
  };
  const events = useMemo(() => remainingEvents.filter(event => (!nodeFilter || event.nodeId === nodeFilter) &&
    (!problemsOnly || event.level === "error" || event.level === "warning")), [remainingEvents, nodeFilter, problemsOnly]);
  const active = ["running", "queued"].includes(execution?.run.status ?? "");
  const timing = ["running", "queued", "waiting", "interrupted"].includes(execution?.run.status ?? "");
  useEffect(() => { if (!timing) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [timing]);
  useEffect(() => { if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [events, follow, collapsed]);
  useLayoutEffect(() => { if (activityFollow && activityScroller.current) activityScroller.current.scrollTop = activityScroller.current.scrollHeight; }, [remainingEvents, activityFollow, collapsed, effectiveView, nodeFilter]);
  const end = execution?.run.completedAt ?? (!timing ? execution?.run.updatedAt : undefined);
  const duration = execution ? Math.max(0, Math.floor(((end ? Date.parse(end) : now) - Date.parse(execution.run.createdAt)) / 1000)) : 0;
  const completed = execution?.nodeRuns.filter(node => node.status === "ok").length ?? 0;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(events.map(event => `${event.at} [${event.nodeId ?? "workflow"}] ${event.message}${event.detail ? `\n${event.detail}` : ""}`).join("\n"));
      setCopyLabel("Copied");
    } catch { setCopyLabel("Copy unavailable"); }
  };
  return <section ref={panel} className={`workflow-console ${collapsed ? "is-collapsed" : ""}`} style={{ height: collapsed ? 50 : height }} aria-label="Workflow console">
    {!collapsed ? <div className="workflow-console__resize" role="separator" aria-label="Resize console" aria-orientation="horizontal"
      tabIndex={0} aria-valuemin={140} aria-valuemax={440} aria-valuenow={height}
      onKeyDown={event => { if (["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); setHeight(value => Math.max(140, Math.min(440, value + (event.key === "ArrowUp" ? 20 : -20)))); } }}
      onPointerDown={event => { drag.current = { y: event.clientY, height }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (drag.current) setHeight(Math.max(140, Math.min(440, drag.current.height + drag.current.y - event.clientY))); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} /> : null}
    <header className="workflow-console__header">
      <button className="workflow-console__title" type="button" onClick={() => setCollapsed(value => !value)} aria-expanded={!collapsed}>
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span><span className={`workflow-live-dot ${active ? "is-active" : ""}`} />Console
      </button>
      <span className="workflow-console__summary">{execution ? <><span className={`workflow-run-status status-${execution.run.status}`}>{execution.run.status}</span>
        {completed} steps completed · {Math.floor(duration / 60)}:{String(duration % 60).padStart(2, "0")}</> : "Ready to run"}</span>
      <span className="workflow-console__connection">{!execution ? "" : execution.connection === "live" ? `Run ${execution.run.id.slice(0, 8)}` : execution.connection === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
      <button type="button" disabled={!remainingEvents.length} title="Clear console and activity history. New events will continue to appear." onClick={clearLog}>Clear log</button>
      <button type="button" disabled={!events.length} onClick={() => void copy()}>{copyLabel}</button>
    </header>
    {!collapsed ? <>
      <div className="workflow-console__filters">
        <div className="workflow-console__views" aria-label="Output view">
          {!narrow ? <button type="button" aria-pressed={effectiveView === "both"} onClick={() => setView("both")}>Split view</button> : null}
          <button type="button" aria-pressed={effectiveView === "console"} onClick={() => setView("console")}>Console</button>
          <button type="button" aria-pressed={effectiveView === "activity"} onClick={() => setView("activity")}>Agent activity</button>
        </div>
        <select aria-label="Filter console by node" value={nodeFilter} onChange={event => onFilter(event.target.value)}>
          <option value="">All steps</option>{workflow.nodes.map(node => <option key={node.id} value={node.id}>{node.label}</option>)}
        </select>
        {effectiveView !== "activity" ? <><button type="button" title="Filter console warnings and errors" aria-pressed={problemsOnly} onClick={() => setProblemsOnly(value => !value)}>Warnings & errors</button>
        <span>{events.length} events</span>
        </> : null}
      </div>
      <div className={`workflow-console__panes view-${effectiveView}`} ref={panes} style={effectiveView === "both" ? { gridTemplateColumns: `minmax(0, ${split}fr) 7px minmax(0, ${100 - split}fr)` } : undefined}>
      <section className="workflow-console__pane" aria-label="Console output">
      <header className="workflow-output__pane-header"><strong>Console</strong><span>Events · stdout · stderr</span><FollowOutputButton following={follow} target="console" onToggle={() => setFollow(value => !value)} /></header>
      <div className="workflow-console__output" ref={scroller} tabIndex={0} aria-label="Execution events"
        onWheel={() => { manualScrollUntil.current = Date.now() + 500; }}
        onPointerDown={() => { manualScrollUntil.current = Date.now() + 1000; }}
        onKeyDown={event => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) manualScrollUntil.current = Date.now() + 500;
          if (event.key === "Home" || event.key === "End") { event.preventDefault(); event.currentTarget.scrollTop = event.key === "Home" ? 0 : event.currentTarget.scrollHeight; setFollow(event.key === "End"); }
        }}
        onScroll={() => { const element = scroller.current; if (element && Date.now() < manualScrollUntil.current) setFollow(element.scrollHeight - element.scrollTop - element.clientHeight <= 35); }}>
        {execution?.truncated && !cleared ? <div className="workflow-console__notice">Earlier events were trimmed. Showing the retained log.</div> : null}
        {execution && !execution.events.length && remainingEvents.length > 0 ? <div className="workflow-console__notice">This run has no live log. Showing its saved step results.</div> : null}
        {events.length ? events.map(event => <div className={`workflow-log-row level-${event.level} ${event.stream ? "is-output" : ""}`} key={event.sequence} data-sequence={event.sequence}>
          <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour12: false })}</time>
          <button type="button" className="workflow-log-row__source" disabled={!event.nodeId} title={event.nodeId ? labels.get(event.nodeId) ?? event.nodeId : "Workflow"}
            onClick={() => event.nodeId && onFocus(event.nodeId)}>{event.nodeId ? labels.get(event.nodeId) ?? event.nodeId : "Workflow"}</button>
          <div><span className="workflow-log-row__message">{event.message}</span>{event.detail ? <pre>{event.detail}</pre> : null}</div>
        </div>) : <div className="workflow-console__empty">{!execution ? "Choose your run settings and press Run to see model activity, command output and errors here." : cleared && !remainingEvents.length ? "Log cleared. New events will appear here." : problemsOnly || nodeFilter ? "No matching events." : active ? "Waiting for execution events…" : "No events were recorded for this run."}</div>}
      </div>
      </section>
      <div className="workflow-console__splitter" role="separator" aria-label="Resize output columns" aria-orientation="vertical"
        tabIndex={0} aria-valuemin={35} aria-valuemax={75} aria-valuenow={split}
        onKeyDown={event => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); setSplit(value => Math.max(35, Math.min(75, value + (event.key === "ArrowRight" ? 5 : -5)))); } }}
        onPointerDown={event => { splitDrag.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { const bounds = panes.current?.getBoundingClientRect(); if (splitDrag.current && bounds) setSplit(Math.max(35, Math.min(75, (event.clientX - bounds.left) / bounds.width * 100))); }}
        onPointerUp={() => { splitDrag.current = false; }} onPointerCancel={() => { splitDrag.current = false; }} />
      <WorkflowActivity execution={execution} workflow={workflow} providers={providers} events={remainingEvents} recordedEvents={recordedEvents}
        nodeFilter={nodeFilter} now={now} scroller={activityScroller} follow={activityFollow} onFollow={setActivityFollow} />
      </div>
    </> : null}
  </section>;
}
