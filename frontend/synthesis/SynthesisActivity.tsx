import { useEffect, useRef, useState } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { usePaneSplit } from "./usePaneSplit";
import type { SynthesisEvent, SynthesisRun } from "./types";

export function statusLabel(status?: string) {
  return ({ accepted: "Accepted", needs_review: "Needs review", unresolved: "Unresolved", interrupted: "Interrupted", blocked: "Blocked", running: "Running", queued: "Queued", cancelled: "Cancelled" } as Record<string, string>)[status ?? ""] ?? "Ready to run";
}
function EventDetail({ event }: { event: SynthesisEvent }) {
  return <article className={`synthesis-event status-${event.status ?? "ok"}`} data-sequence={event.sequence}>
    <span className="synthesis-event__marker" aria-label={event.status}>{event.status === "failed" ? "×" : event.status === "running" ? "·" : "✓"}</span>
    <div><strong>{event.message}</strong>
      {event.file ? <small>{event.file}{event.line ? `:${event.line}` : ""}</small> : null}
      {event.detail ? <details><summary>Details</summary><pre>{event.detail}</pre></details> : null}
    </div>
    <time title={event.at}>{new Date(event.at).toLocaleTimeString([], { hour12: false })}</time>
  </article>;
}

export function SynthesisOutput({ children, run }: { children: ReactNode; run: SynthesisRun | null }) {
  const container = useRef<HTMLDivElement>(null);
  const split = usePaneSplit("lcai.synthesis.activitySplit.v1", 60, "y", container);
  return <div className="synthesis-output" ref={container} data-resizing={split.resizing || undefined}
    style={{ gridTemplateRows: `minmax(64px, ${split.value}fr) minmax(64px, ${100 - split.value}fr)` }}>
    <div className="synthesis-editor-pane">{children}</div>
    <SynthesisActivity run={run} resize={split.handle} />
  </div>;
}

export function SynthesisActivity({ run, resize }: { run: SynthesisRun | null; resize?: HTMLAttributes<HTMLDivElement> }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const events = run?.events ?? [];
  useEffect(() => { setFollowing(true); }, [run?.id]);
  useEffect(() => {
    if (following && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [following, run?.id, events.length, events.at(-1)?.detail]);
  const current = events.at(-1);
  return <section className="synthesis-activity" aria-label="Synthesis agent activity">
    <header className="synthesis-pane-header">
      <div {...resize} className="synthesis-activity__resize" aria-label="Resize Agent activity" title="Drag to resize · Double-click to reset"><span aria-hidden="true" /><strong>Agent activity</strong></div>
      <button type="button" aria-pressed={following} onClick={() => setFollowing(!following)}>{following ? "Following ↓" : "Follow ↓"}</button>
    </header>
    <div className={`synthesis-activity__current status-${run?.status ?? "idle"}`} aria-live="polite">
      <strong>{run?.status === "running" ? current?.message ?? run.phase : statusLabel(run?.status)}</strong>
      {run ? <span>{run.moduleName} · {run.iteration ? `Iteration ${run.iteration} · ` : ""}{run.phase}</span> : <span>Run a module to see each agent action and evaluation.</span>}
    </div>
    <div className="synthesis-activity__history" ref={scroller} tabIndex={0} aria-label="Synthesis action history"
      onScroll={event => { const el = event.currentTarget; setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 40); }}
      onKeyDown={event => {
        if (event.target === event.currentTarget && (event.key === "Home" || event.key === "End")) {
          event.preventDefault(); const el = event.currentTarget;
          el.scrollTop = event.key === "End" ? el.scrollHeight : 0; setFollowing(event.key === "End");
        }
      }}>
      {events.length ? events.map((event, index) => <div key={event.sequence}>
        {index === 0 || events[index - 1].iteration !== event.iteration ? <div className="synthesis-activity__iteration">{event.iteration ? `Iteration ${event.iteration}` : "Preparation"}</div> : null}
        {index === 0 || events[index - 1].step !== event.step || events[index - 1].iteration !== event.iteration ? <div className="synthesis-activity__step"><span>{event.step.replace(/[._-]/g, " ")}</span>{event.model ? <small>{event.model}</small> : null}</div> : null}
        <EventDetail event={event} />
      </div>) : <div className="synthesis-empty">The execution trace will appear here: model loading, file changes, checks, and repair iterations.</div>}
    </div>
  </section>;
}
