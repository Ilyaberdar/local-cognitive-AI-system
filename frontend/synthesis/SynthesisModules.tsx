import { useEffect, useRef, useState, type Ref } from "react";
import { statusLabel } from "./SynthesisActivity";
import { SynthesisIcon } from "./SynthesisIcon";
import type { SynthesisModule, SynthesisRun } from "./types";

const going = (run: SynthesisRun) => run.status === "running" || run.status === "queued";
const when = (at: string) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const folderOf = (specPath?: string) => !specPath ? "" : specPath.replace(/\/[^/]+$/, "") === specPath ? "Project root" : specPath.replace(/\/[^/]+$/, "");

/** The project's modules and the chosen module's runs, in a panel beside the module (as Diagnostics
 * is). Deleting runs is this computer's: a paired server's screen shows the history only. */
export function SynthesisModules({ modules, hidden, moduleId, runs, runId, busy, loading, canDelete, focus, newModule, onSelect, onHide, onRestore, onCreate, onSelectRun, onDeleteRun, onClearRuns, onClose }: {
  modules: SynthesisModule[]; hidden: SynthesisModule[]; moduleId: string; runs: SynthesisRun[]; runId: string;
  busy: boolean; loading: boolean; canDelete: boolean; newModule: Ref<HTMLButtonElement>;
  /** Opened by the person now (not shown again with the screen): its title takes the focus. */
  focus?: boolean;
  onSelect: (id: string) => void; onHide: (id: string) => void; onRestore: (id: string) => void; onCreate: () => void;
  onSelectRun: (run: SynthesisRun) => void; onDeleteRun: (id: string) => void; onClearRuns: () => void; onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focus) heading.current?.focus(); }, []);
  const [confirm, setConfirm] = useState<"all" | string | null>(null);
  useEffect(() => { setConfirm(null); }, [moduleId]);
  const module = modules.find(item => item.id === moduleId);
  const finished = runs.filter(run => !going(run)).length;
  return <section className="synthesis-panel synthesis-modules-panel" id="synthesis-modules" aria-labelledby="synthesis-modules-title"
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); if (confirm) setConfirm(null); else onClose(); } }}>
    <header className="synthesis-panel__header">
      <div><h2 id="synthesis-modules-title" ref={heading} tabIndex={-1}>Modules <span>{modules.length}</span></h2><p>DSL files saved in this project appear after Refresh.</p></div>
      <button type="button" className="synthesis-icon-button" aria-label="Close modules" onClick={onClose}><SynthesisIcon name="close" /></button>
    </header>
    <div className="synthesis-panel__body">
      <div className="synthesis-module-list">{modules.map(item => <div className="synthesis-module-row" key={item.id}>
        <button type="button" disabled={busy} aria-pressed={item.id === moduleId} className={`synthesis-module${item.id === moduleId ? " is-selected" : ""}`} onClick={() => onSelect(item.id)}>
          <span className={`synthesis-status-dot ${item.valid ? "is-valid" : "is-invalid"}`} />
          <span><strong>{item.name}</strong><small>{item.valid ? "Contract ready" : "Needs attention"}</small>{item.specPath ? <small className="synthesis-module-path" title={item.specPath}>{folderOf(item.specPath)}</small> : null}</span>
        </button>
        <button type="button" className="synthesis-module-remove" disabled={busy} aria-label={`Remove ${item.name} from view`} title="Remove from view · Files stay on disk" onClick={() => onHide(item.id)}><SynthesisIcon name="close" /></button>
      </div>)}
        {!modules.length ? <p className="synthesis-empty">{loading ? "Discovering modules…" : hidden.length ? "All modules are hidden. Restore one below." : "No DSL modules found in this project."}</p> : null}</div>
      {hidden.length ? <details className="synthesis-hidden-modules"><summary>Hidden modules <span>{hidden.length}</span></summary><p>Files remain in your project.</p>{hidden.map(item =>
        <button key={item.id} type="button" disabled={busy} aria-label={`Restore ${item.name}`} onClick={() => onRestore(item.id)}><span>{item.name}</span><SynthesisIcon name="plus" /></button>)}</details> : null}
      <button ref={newModule} type="button" className="synthesis-new-module" disabled={busy || loading} onClick={onCreate}><SynthesisIcon name="plus" />New module</button>

      <section className="synthesis-runs" aria-labelledby="synthesis-runs-title">
        <header><h3 id="synthesis-runs-title">Run history</h3>{module ? <span>{module.name}</span> : null}
          {canDelete && finished ? <button type="button" className="synthesis-runs__clear" disabled={busy} aria-expanded={confirm === "all"} onClick={() => setConfirm(confirm === "all" ? null : "all")}>Clear</button> : null}</header>
        {confirm === "all" ? <div className="synthesis-confirm" role="group" aria-label="Clear run history">
          <p>Delete {finished === 1 ? "the finished run" : `${finished} finished runs`} of {module?.name ?? "this module"}? Their logs, candidates and agents' steps go; files already applied stay in the project.{finished < runs.length ? " A run still going stays." : ""}</p>
          <div><button type="button" className="synthesis-danger" disabled={busy} onClick={() => { setConfirm(null); onClearRuns(); }}>Delete {finished === 1 ? "run" : "runs"}</button><button type="button" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button></div>
        </div> : null}
        <div className="synthesis-run-history">{runs.slice(0, 30).map(item => {
          const model = item.models?.[0]?.displayName || item.models?.[0]?.id;
          const facts = [model ? `${model}${(item.models?.length ?? 0) > 1 ? ` +${item.models!.length - 1}` : ""}` : "", item.iteration ? `${item.iteration} ${item.iteration === 1 ? "iteration" : "iterations"}` : ""].filter(Boolean).join(" · ");
          return confirm === item.id ? <div className="synthesis-confirm synthesis-confirm--row" key={item.id} role="group" aria-label={`Delete the run from ${when(item.createdAt)}`}>
            <p>Delete this run from {when(item.createdAt)}?</p>
            <div><button type="button" className="synthesis-danger" disabled={busy} onClick={() => { setConfirm(null); onDeleteRun(item.id); }}>Delete</button><button type="button" disabled={busy} onClick={() => setConfirm(null)}>Keep</button></div>
          </div> : <div className="synthesis-run-row" key={item.id}>
            <button type="button" disabled={busy} className={`synthesis-run-item${item.id === runId ? " is-selected" : ""}`} aria-pressed={item.id === runId} onClick={() => onSelectRun(item)}>
              <span className="synthesis-run__top"><strong className={`status-${item.status}`}>{statusLabel(item.status)}</strong><time dateTime={item.createdAt}>{when(item.createdAt)}</time></span>
              {facts ? <small>{facts}</small> : null}
            </button>
            {canDelete && !going(item) ? <button type="button" className="synthesis-run-remove" disabled={busy} aria-label={`Delete the run from ${when(item.createdAt)}`} title="Delete run" onClick={() => setConfirm(item.id)}><SynthesisIcon name="trash" /></button> : null}
          </div>;
        })}{!runs.length ? <p className="synthesis-empty">Runs of this module appear here.</p> : null}</div>
      </section>
    </div>
  </section>;
}
