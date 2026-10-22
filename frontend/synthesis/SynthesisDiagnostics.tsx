import { useEffect, useRef } from "react";
import { SynthesisIcon } from "./SynthesisIcon";
import type { SynthesisModule, SynthesisRun } from "./types";

export function diagnosticSummary(module: SynthesisModule | null) {
  if (!module) return { label: "No module selected", tone: "idle" };
  const errors = module.diagnostics.filter(item => item.severity !== "warning").length;
  const warnings = module.diagnostics.length - errors;
  if (errors) return { label: `${errors} ${errors === 1 ? "error" : "errors"}`, tone: "fail" };
  if (!module.valid) return { label: "Needs attention", tone: "fail" };
  if (warnings) return { label: `${warnings} ${warnings === 1 ? "warning" : "warnings"}`, tone: "unknown" };
  return { label: "Valid", tone: "pass" };
}

export function SynthesisDiagnostics({ module, run, busy, focus, onReveal, onOpenSource, onClose }: {
  module: SynthesisModule | null; run: SynthesisRun | null; busy: boolean;
  /** Opened by the person now (not shown again with the screen): its title takes the focus. */
  focus?: boolean;
  /** Shows the line in the module's Contract or Flow. */
  onReveal: (file: "spec" | "flow", line?: number) => void;
  /** Absent on a server's screen: its files are not opened in an editor here. */
  onOpenSource?: (file: "spec" | "flow") => void; onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focus) heading.current?.focus(); }, []);
  const summary = diagnosticSummary(module);
  const evidence = run?.evidence;
  const running = run?.status === "running" || run?.status === "queued";
  return <section className="synthesis-panel synthesis-inspector" id="synthesis-diagnostics" aria-labelledby="synthesis-diagnostics-title"
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="synthesis-panel__header">
      <div><h2 id="synthesis-diagnostics-title" ref={heading} tabIndex={-1}>Project diagnostics</h2><p>{module?.name ?? "Select a module to begin"}</p></div>
      <button type="button" className="synthesis-icon-button" aria-label="Close project diagnostics" onClick={onClose}><SynthesisIcon name="close" /></button>
    </header>
    <div className="synthesis-panel__body">
      <section className="synthesis-diagnostic-section" aria-labelledby="synthesis-validation-title">
        <header><h3 id="synthesis-validation-title">Current source</h3><span className={`synthesis-status status-${summary.tone}`}>{summary.label}</span></header>
        {module ? module.diagnostics.length ? <div className="synthesis-diagnostics">{module.diagnostics.map((item, index) => {
          const file = item.file?.endsWith(".lcflow") ? "flow" : "spec";
          return <div key={index} className={`synthesis-diagnostic ${item.severity === "warning" ? "is-warning" : "is-error"}`}>
            <button type="button" className="synthesis-diagnostic__show" title={`Show in ${file === "flow" ? "Flow" : "Contract"}`} onClick={() => onReveal(file, item.line)}>
              <SynthesisIcon name="warning" /><span><strong>{item.message}</strong><small>{item.file ?? "DSL source"}{item.line ? `:${item.line}${item.column ? `:${item.column}` : ""}` : ""}</small></span>
            </button>
            {onOpenSource ? <button type="button" className="synthesis-diagnostic__open" disabled={busy} aria-label={`Open ${item.file ?? "the source"} in your editor`} title="Open in your editor" onClick={() => onOpenSource(file)}><SynthesisIcon name="external" /></button> : null}
          </div>;
        })}</div>
          : <p className={`synthesis-validation-result status-${summary.tone}`}><SynthesisIcon name={module.valid ? "check" : "warning"} />{module.valid ? "Spec and flow are valid" : "Source validation is incomplete. Refresh to check the saved files."}</p>
          : <p className="synthesis-section-note">Select a module to validate its source.</p>}
      </section>
      <section className="synthesis-diagnostic-section" aria-labelledby="synthesis-gates-title">
        <header><h3 id="synthesis-gates-title">Acceptance gates</h3><span className={`synthesis-status status-${evidence?.status.toLowerCase() ?? "idle"}`}>{evidence?.status ?? (running ? "Pending" : "Not evaluated")}</span></header>
        <p className="synthesis-section-note">{evidence ? "Results for the selected run’s frozen source." : running ? "Checks will appear as this run is evaluated." : "Run this module to evaluate its candidate."}</p>
        {evidence ? <div className="synthesis-gates">{evidence.gates.length ? evidence.gates.map(gate => <details className="synthesis-gate" key={gate.id}>
          <summary><span className={`synthesis-gate__verdict status-${gate.skipped ? "idle" : gate.status.toLowerCase()}`}><SynthesisIcon name={gate.status === "Pass" ? "check" : gate.status === "Fail" ? "close" : "clock"} /></span><strong>{gate.id}</strong><span className={`status-${gate.skipped ? "idle" : gate.status.toLowerCase()}`}>{gate.skipped ? "Not evaluated" : gate.status}</span><SynthesisIcon name="chevron" /></summary>
          <div className="synthesis-gate__detail"><p>{gate.message}</p>
            {gate.cases?.length ? <ul className="synthesis-gate__cases" aria-label={`Tests of ${gate.id}`}>{gate.cases.map((item, index) =>
              <li key={index} className={item.status === "pass" ? "is-pass" : "is-fail"}><SynthesisIcon name={item.status === "pass" ? "check" : "close"} /><span><strong>{item.name}</strong>
                {item.status === "fail" && (item.message || item.expected !== undefined) ? <small>{[item.message, item.expected !== undefined ? `expected ${item.expected}, actual ${item.actual ?? "?"}` : ""].filter(Boolean).join(" · ")}{item.file ? ` · ${item.file}${item.line ? `:${item.line}` : ""}` : ""}</small> : null}</span></li>)}</ul>
              : gate.feedback?.length && gate.status !== "Pass" ? <ul className="synthesis-gate__cases">{gate.feedback.map((item, index) => <li key={index} className="is-fail"><SynthesisIcon name="close" /><span><small>{item}</small></span></li>)}</ul> : null}
            <span>Evaluator</span><code>{gate.evaluator}</code></div>
        </details>) : <p className="synthesis-section-note">No individual gate results were recorded.</p>}</div> : null}
      </section>
      {run?.models?.length ? <details className="synthesis-inspector-disclosure" open>
        <summary><span>Models</span><small>{run.models.length}</small><SynthesisIcon name="chevron" /></summary>
        <div className="synthesis-models">{run.models.map(item => <div key={`${item.providerId}:${item.id}`}><strong>{item.displayName || item.id}</strong><small>{item.providerName ?? item.providerId}{item.quantization ? ` · ${item.quantization}` : ""}{item.sizeBytes ? ` · ${(item.sizeBytes / 1024 ** 3).toFixed(1)} GiB` : item.providerId === "llamacpp" ? "" : " · cloud"}</small></div>)}</div>
        {/* The run's total: under two models it read as the second one's. */}
        {run.usage?.calls ? <p className="synthesis-section-note">{run.models.length > 1 ? "All models: " : ""}{run.usage.calls} model {run.usage.calls === 1 ? "call" : "calls"} · {run.usage.inputTokens.toLocaleString()} tokens in, {run.usage.outputTokens.toLocaleString()} out</p> : null}
      </details> : null}
      {evidence ? <details className="synthesis-inspector-disclosure synthesis-provenance"><summary><span>Evidence identity</span><SynthesisIcon name="chevron" /></summary>
        <dl><div><dt>Candidate</dt><dd>{evidence.candidateHash}</dd></div><div><dt>Contract</dt><dd>{evidence.specHash}</dd></div></dl>
      </details> : null}
    </div>
  </section>;
}
