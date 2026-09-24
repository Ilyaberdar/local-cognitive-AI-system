import { useState } from "react";
import { Field } from "./NodeConfigFields";
import type { WorkflowEditorProps, WorkflowRunOptions } from "./types";

export function RunSettings({ options, projects = [], onUpdate, onChooseFolder, disabled, initiallyOpen, onOpenChange, hasRun }: {
  options: WorkflowRunOptions; projects: WorkflowEditorProps["projects"]; onUpdate: (options: WorkflowRunOptions) => void;
  onChooseFolder?: WorkflowEditorProps["onChooseFolder"];
  hasRun?: boolean; disabled?: boolean; initiallyOpen?: boolean; onOpenChange: (open: boolean) => void;
}) {
  const [folderMode, setFolderMode] = useState(options.rootPath !== undefined);
  const [open, setOpen] = useState(initiallyOpen ?? false);
  const [error, setError] = useState("");
  const update = (patch: Partial<WorkflowRunOptions>) => onUpdate({ ...options, ...patch });
  return <details className="fsm-run-settings" open={open} onToggle={event => { const next = event.currentTarget.open; setOpen(next); onOpenChange(next); }}>
    <summary><strong>Run settings</strong><span>{options.projectId ? projects.find(item => item.id === options.projectId)?.name ?? "Project unavailable" : folderMode ? options.rootPath || "Choose a folder" : "New run folder"}</span></summary>
    <fieldset className="fsm-settings-fields" disabled={disabled}>
      <div className={`fsm-run-settings__fields${folderMode ? " fsm-run-settings__fields--folder" : ""}`}>
        <div className="fsm-run-settings__workspace">
        <Field label="Workspace"><select value={options.projectId || (folderMode ? "__folder" : "__managed")} onChange={event => {
          const value = event.target.value;
          setFolderMode(value === "__folder");
          onUpdate({ ...options, projectId: value.startsWith("__") ? undefined : value, rootPath: value === "__folder" ? "" : undefined });
        }}>
          <option value="__managed">New folder for this run</option><option value="__folder">Choose a folder…</option>
          {options.projectId && !projects.some(item => item.id === options.projectId && !item.archivedAt) ? <option value={options.projectId} disabled>Project unavailable</option> : null}
          {projects.filter(item => !item.archivedAt).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select></Field>
        <div className="fsm-run-options-row">
          <Field label="Access"><select value={options.accessMode ?? "default"} onChange={event => update({ accessMode: event.target.value as WorkflowRunOptions["accessMode"] })}>
            <option value="default">Ask for commands / web</option><option value="ask">Ask before changes</option><option value="full">Full access</option>
          </select></Field>
          <Field label="Step limit"><input type="number" min={1} max={250} value={options.maxSteps ?? 25} onChange={event => update({ maxSteps: Number(event.target.value) })} /></Field>
        </div>
        </div>
        <div className="fsm-run-settings__instructions">
        {folderMode ? <div className="fsm-run-folder">
          <Field label="Folder path"><input value={options.rootPath ?? ""} placeholder="/absolute/path/to/folder" onChange={event => update({ rootPath: event.target.value })} /></Field>
          {onChooseFolder ? <button type="button" onClick={async () => {
            try { const path = await onChooseFolder(); if (path) update({ rootPath: path }); setError(""); }
            catch (failure) { setError(failure instanceof Error ? failure.message : "Could not select folder."); }
          }}>Browse</button> : null}
        </div> : null}
        <Field label="Run input"><textarea rows={2} value={options.description ?? ""} placeholder="Shared instructions available to nodes as {{input.description}}" onChange={event => update({ description: event.target.value })} /></Field>

        </div>
      <p className="fsm-model-hint">{hasRun ? "Settings apply to the next run. " : ""}Save keeps these defaults. Each agent uses its selected model.</p>
      {error ? <p className="fsm-field-error">{error}</p> : null}
      </div>
    </fieldset>
  </details>;
}
