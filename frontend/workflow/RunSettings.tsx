import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Field } from "./NodeConfigFields";
import type { WorkflowEditorProps, WorkflowRunOptions } from "./types";

export function RunSettings({ options, projects = [], onUpdate, onChooseFolder, disabled, initiallyOpen, onOpenChange, hasRun, container, limits }: {
  options: WorkflowRunOptions; projects: WorkflowEditorProps["projects"]; onUpdate: (options: WorkflowRunOptions) => void;
  limits?: WorkflowEditorProps["limits"];
  onChooseFolder?: WorkflowEditorProps["onChooseFolder"];
  hasRun?: boolean; disabled?: boolean; initiallyOpen?: boolean; onOpenChange: (open: boolean) => void;
  container?: HTMLElement | null;
}) {
  const folderMode = options.rootPath !== undefined;
  const folders = limits?.folder !== false, fullAccess = limits?.fullAccess !== false;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const id = useId();
  const panelRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const position = () => {
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!panel || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const top = Math.min(rect.bottom + 10, window.innerHeight - 100);
    panel.style.top = `${Math.max(12, top)}px`;
    panel.style.right = `${Math.min(Math.max(12, window.innerWidth - rect.right), Math.max(12, window.innerWidth - 440 - 12))}px`;
    panel.style.maxHeight = `${window.innerHeight - Math.max(12, top) - 12}px`;
  };
  useLayoutEffect(() => { if (initiallyOpen) panelRef.current?.showPopover(); }, []);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open]);
  const update = (patch: Partial<WorkflowRunOptions>) => onUpdate({ ...options, ...patch });
  const control = <>
    <button ref={triggerRef} type="button" className={`ghost-button workflow-settings-toggle${open ? " is-active" : ""}`}
      popoverTarget={id} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} aria-label="Workflow settings" title="Workflow settings">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 3-.6 2.3-2 .9-2.2-.6-2 3.4 1.6 1.7v2.6L2.7 15l2 3.4 2.2-.6 2 .9.6 2.3h4.9l.6-2.3 2-.9 2.2.6 2-3.4-1.6-1.7v-2.6L21.2 9l-2-3.4-2.2.6-2-.9-.6-2.3z" /><circle cx="12" cy="12" r="3" /></svg>
    </button>
    <section ref={panelRef} id={id} className="fsm-run-settings" popover="auto" role="dialog" aria-labelledby={`${id}-title`}
      onBeforeToggle={event => { if (event.newState === "open") position(); }}
      onToggle={event => { const next = event.newState === "open"; setOpen(next); onOpenChange(next); }}>
    <header className="fsm-run-settings__header">
      <div><h2 id={`${id}-title`}>Workflow settings</h2><p>Configure the next run</p></div>
      <button type="button" className="fsm-run-settings__close" popoverTarget={id} popoverTargetAction="hide" aria-label="Close workflow settings" onClick={() => triggerRef.current?.focus()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </header>
    <fieldset className="fsm-settings-fields" disabled={disabled}>
      <div className="fsm-run-settings__fields">
        <div className="fsm-run-settings__workspace">
        <Field label="Workspace"><select value={options.projectId || (folderMode ? "__folder" : "__managed")} onChange={event => {
          const value = event.target.value;
          setError("");
          onUpdate({ ...options, projectId: value.startsWith("__") ? undefined : value, rootPath: value === "__folder" ? "" : undefined });
        }}>
          <option value="__managed">New folder for this run</option>{folders ? <option value="__folder">Choose a folder…</option> : null}
          {options.projectId && !projects.some(item => item.id === options.projectId && !item.archivedAt) ? <option value={options.projectId} disabled>Project unavailable</option> : null}
          {folders ? projects.filter(item => !item.archivedAt).map(project => <option key={project.id} value={project.id}>{project.name}</option>) : null}
        </select></Field>
        <div className="fsm-run-options-row">
          <Field label="Access"><select value={options.accessMode ?? "default"} onChange={event => update({ accessMode: event.target.value as WorkflowRunOptions["accessMode"] })}>
            <option value="default">Ask for commands / web</option><option value="ask">Ask before changes</option>
            {fullAccess || options.accessMode === "full" ? <option value="full" disabled={!fullAccess}>Full access</option> : null}
          </select></Field>
          <Field label="Step limit"><input type="number" min={1} max={250} value={options.maxSteps ?? 25} onChange={event => update({ maxSteps: Number(event.target.value) })} /></Field>
        </div>
        </div>
        <div className="fsm-run-settings__instructions">
        {folderMode && folders ? <div className="fsm-run-folder">
          <Field label="Folder path"><input value={options.rootPath ?? ""} placeholder="/absolute/path/to/folder" onChange={event => update({ rootPath: event.target.value })} /></Field>
          {onChooseFolder ? <button type="button" onClick={async () => {
            try { const path = await onChooseFolder(); if (path) update({ rootPath: path }); setError(""); }
            catch (failure) { setError(failure instanceof Error ? failure.message : "Could not select folder."); }
          }}>Browse</button> : null}
        </div> : null}
        <Field label="Run input"><textarea rows={2} value={options.description ?? ""} placeholder="Shared instructions available to nodes as {{input.description}}" onChange={event => update({ description: event.target.value })} /></Field>

        </div>
      <p className="fsm-model-hint fsm-run-settings__footer">{disabled ? "Settings are locked while this run is active. " : hasRun ? "Settings apply to the next run. " : ""}Save keeps these defaults. Each agent uses its selected model.</p>
      {error ? <p className="fsm-field-error" role="alert">{error}</p> : null}
      </div>
    </fieldset>
  </section></>;
  return container ? createPortal(control, container) : control;
}
