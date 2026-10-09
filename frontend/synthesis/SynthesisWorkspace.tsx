import { useCallback, useEffect, useRef, useState } from "react";
import { encode, errorMessage, isAbort, synthesisRequest } from "./api";
import { SynthesisOutput, statusLabel } from "./SynthesisActivity";
import { SynthesisDiff } from "./SynthesisDiff";
import { diagnosticSummary, SynthesisDiagnostics } from "./SynthesisDiagnostics";
import { SynthesisIcon } from "./SynthesisIcon";
import { NewModuleDialog } from "./NewModuleDialog";
import type { CandidateDiff, RunSources, SynthesisModule, SynthesisRun, SynthesisWorkspaceProps } from "./types";

const activeStatuses = new Set(["running", "queued"]);
const recoverableStatuses = new Set(["interrupted", "blocked", "unresolved", "cancelled", "needs_review"]);
type SourceTab = "contract" | "flow" | "changes" | "preview";
function storedProject() { try { return localStorage.getItem("lcai.synthesis.project.v1") ?? ""; } catch { return ""; } }
const hiddenModulesKey = "lcai.synthesis.hiddenModules.v1";
function storedHiddenModules(): Record<string, string[]> {
  try {
    const value = JSON.parse(localStorage.getItem(hiddenModulesKey) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, ids]) => Array.isArray(ids)).map(([project, ids]) => [project, (ids as unknown[]).filter((id): id is string => typeof id === "string")]));
  } catch { return {}; }
}
function SourcePreview({ source, name }: { source: string; name: string }) {
  return <pre className="synthesis-source" aria-label={name}><code>{source.split("\n").map((line, index) => <span className="synthesis-source__line" key={index}>
    <span className="synthesis-source__number" aria-hidden="true">{index + 1}</span>
    <span>{line.split(/("(?:[^"\\]|\\.)*"|\/\/.*$|\b(?:module|version|interface|behavior|invariants|constraints|evaluate|hard|soft|implement|using|limit|while|if|else|await|return|continue|true|false|none)\b)/g).map((part, partIndex) =>
      <span key={partIndex} className={part.startsWith("//") ? "synthesis-source__comment" : part.startsWith('"') ? "synthesis-source__string" : /^(module|version|interface|behavior|invariants|constraints|evaluate|hard|soft|implement|using|limit|while|if|else|await|return|continue|true|false|none)$/.test(part) ? "synthesis-source__keyword" : undefined}>{part}</span>) || " "}</span>
  </span>)}</code></pre>;
}

export function SynthesisWorkspace({ projects, colorMode = "dark", active = true, onCreateProject, selectedProjectId }: SynthesisWorkspaceProps) {
  const availableProjects = projects.filter(project => !project.archivedAt);
  const [projectId, setProjectId] = useState(() => {
    const saved = storedProject(); return availableProjects.some(project => project.id === saved) ? saved : availableProjects[0]?.id ?? "";
  });
  const [modules, setModules] = useState<SynthesisModule[]>([]);
  const [hiddenModules, setHiddenModules] = useState(storedHiddenModules);
  const [moduleId, setModuleId] = useState("");
  const [module, setModule] = useState<SynthesisModule | null>(null);
  const [runs, setRuns] = useState<SynthesisRun[]>([]);
  const [runId, setRunId] = useState("");
  const [run, setRun] = useState<SynthesisRun | null>(null);
  const [tab, setTab] = useState<SourceTab>("contract");
  const [sourceOrigin, setSourceOrigin] = useState<"project" | "snapshot">("project");
  const [runSources, setRunSources] = useState<(RunSources & { runId: string }) | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [diff, setDiff] = useState<CandidateDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [creatingModule, setCreatingModule] = useState(false);
  const newModuleTrigger = useRef<HTMLButtonElement>(null);
  const diagnosticsTrigger = useRef<HTMLButtonElement>(null);
  const selection = useRef({ projectId, moduleId, runId });
  selection.current = { projectId, moduleId, runId };
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const project = availableProjects.find(item => item.id === projectId);
  const running = Boolean(run && activeStatuses.has(run.status));
  const moduleRuns = runs.filter(item => item.moduleId === moduleId);
  const sourceTab = tab === "contract" || tab === "flow";
  const snapshot = runSources?.runId === runId ? runSources : null;
  const diagnostics = diagnosticSummary(module);
  const closeDiagnostics = () => { setDiagnosticsOpen(false); diagnosticsTrigger.current?.focus(); };
  const visibleModules = modules.filter(item => !hiddenModules[projectId]?.includes(item.id));
  const removedModules = modules.filter(item => hiddenModules[projectId]?.includes(item.id));
  const restoreModule = (id: string) => {
    setHiddenModules(current => ({ ...current, [projectId]: (current[projectId] ?? []).filter(item => item !== id) }));
    setModuleId(id);
  };
  const hideModule = (id: string) => {
    setHiddenModules(current => ({ ...current, [projectId]: [...new Set([...(current[projectId] ?? []), id])] }));
  };
  useEffect(() => { try { localStorage.setItem(hiddenModulesKey, JSON.stringify(hiddenModules)); } catch { /* Optional view preference. */ } }, [hiddenModules]);
  useEffect(() => {
    const visible = modules.filter(item => !hiddenModules[projectId]?.includes(item.id));
    setModuleId(current => visible.some(item => item.id === current) ? current : visible[0]?.id ?? "");
  }, [modules, hiddenModules, projectId]);

  useEffect(() => {
    if (!availableProjects.some(item => item.id === projectId)) setProjectId(availableProjects[0]?.id ?? "");
  }, [projects, projectId]);
  useEffect(() => { if (selectedProjectId) setProjectId(selectedProjectId); }, [selectedProjectId]);
  useEffect(() => {
    try { localStorage.setItem("lcai.synthesis.project.v1", projectId); } catch { /* Storage may be unavailable. */ }
    setModules([]); setModuleId(""); setModule(null); setRuns([]); setRunId(""); setRun(null); setDiff(null); setError(""); setNotice("");
    setCreatingModule(false);
  }, [projectId]);
  useEffect(() => {
    if (!active || !projectId) return;
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      synthesisRequest<{ modules: SynthesisModule[] }>(`/projects/${encode(projectId)}/modules`, { signal: controller.signal }),
      synthesisRequest<SynthesisRun[]>(`/projects/${encode(projectId)}/runs`, { signal: controller.signal })
    ]).then(([moduleList, runList]) => {
      if (controller.signal.aborted) return;
      setModules(moduleList.modules); setRuns(runList);
      setError("");
    }).catch(reason => { if (!isAbort(reason) && !controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId, active, revision]);

  useEffect(() => {
    setModule(null); setRunId(""); setRun(null); setDiff(null);
    setSourceOrigin("project"); setRunSources(null); setSourceError("");
  }, [projectId, moduleId]);
  useEffect(() => {
    if (!moduleId || !projectId || !active) return;
    const controller = new AbortController();
    synthesisRequest<SynthesisModule>(`/projects/${encode(projectId)}/modules/${encode(moduleId)}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setModule(result); })
      .catch(reason => { if (!isAbort(reason) && !controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [moduleId, projectId, revision, active]);
  useEffect(() => {
    if (moduleId && !runId && moduleRuns.length) setRunId(moduleRuns[0].id);
  }, [moduleId, runId, runs]);

  useEffect(() => {
    if (!runId || !active || busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let shouldContinue = true;
      try {
        const result = await synthesisRequest<SynthesisRun>(`/runs/${encode(runId)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (result.projectId !== projectId || result.moduleId !== moduleId) return;
        setRun(result);
        setRuns(current => [result, ...current.filter(item => item.id !== result.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        shouldContinue = activeStatuses.has(result.status);
      } catch (reason) {
        if (!isAbort(reason) && !controller.signal.aborted) setError(errorMessage(reason));
      }
      if (!controller.signal.aborted && shouldContinue) timer = setTimeout(poll, 1200);
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [runId, projectId, moduleId, active, busy, revision]);

  useEffect(() => {
    if (sourceOrigin !== "snapshot" || !sourceTab || !runId || !active) return;
    const controller = new AbortController();
    setRunSources(null); setSourceError("");
    synthesisRequest<RunSources>(`/runs/${encode(runId)}/sources`, { signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted && selection.current.runId === runId) setRunSources({ ...result, runId });
      })
      .catch(reason => {
        if (!isAbort(reason) && !controller.signal.aborted && selection.current.runId === runId) setSourceError(errorMessage(reason));
      });
    return () => controller.abort();
  }, [runId, sourceOrigin, sourceTab, active]);

  useEffect(() => {
    setDiff(null);
    if (tab !== "changes" || !runId || !active || running) return;
    const controller = new AbortController();
    setDiffLoading(true);
    synthesisRequest<CandidateDiff>(`/runs/${encode(runId)}/diff`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setDiff(result); })
      .catch(reason => { if (!isAbort(reason) && !controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setDiffLoading(false); });
    return () => controller.abort();
  }, [runId, tab, running, run?.appliedAt, active, revision]);

  const perform = useCallback(async (label: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(label); setError(""); setNotice("");
    try { await action(); } catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
    finally { if (mounted.current) setBusy(""); }
  }, [busy]);
  const open = (file?: "spec" | "flow") => void perform("open", async () => {
    await synthesisRequest(`/projects/${encode(projectId)}/open`, { method: "POST", body: JSON.stringify(file ? { moduleId, file } : {}) });
    setNotice(file ? `Opened ${file === "spec" ? ".lcspec" : ".lcflow"} in your editor.` : "Opened project in your editor.");
  });
  const closeNewModule = () => { setCreatingModule(false); newModuleTrigger.current?.focus(); };
  const moduleCreated = (created: SynthesisModule) => {
    setModules(current => [...current.filter(item => item.id !== created.id), created]); restoreModule(created.id); setTab("contract");
    setRevision(current => current + 1); setNotice(`${created.name} created at ${created.specPath}. Open in editor to define its contract and flow.`);
    closeNewModule();
  };
  const startRun = () => void perform("run", async () => {
    const created = await synthesisRequest<SynthesisRun>(`/projects/${encode(projectId)}/runs`, { method: "POST", body: JSON.stringify({ moduleId }) });
    if (selection.current.projectId !== projectId || selection.current.moduleId !== moduleId) return;
    setRuns(current => [created, ...current.filter(item => item.id !== created.id)]); setRunId(created.id); setRun(created);
  });
  const runAction = (action: "cancel" | "resume") => void perform(action, async () => {
    const updated = await synthesisRequest<SynthesisRun>(`/runs/${encode(runId)}/${action}`, { method: "POST" });
    if (selection.current.runId !== runId) return;
    setRunId(updated.id); setRun(updated); setRuns(current => [updated, ...current.filter(item => item.id !== updated.id)]);
  });
  const apply = () => void perform("apply", async () => {
    await synthesisRequest(`/runs/${encode(runId)}/apply`, { method: "POST" });
    if (selection.current.runId !== runId) return;
    setNotice("Verified candidate applied to the project."); setRevision(current => current + 1);
  });

  return <div className="synthesis-workspace" data-color-mode={colorMode}>
    <header className="synthesis-toolbar">
      <div className="synthesis-toolbar__heading"><h2>Synthesis</h2></div>
      <div className="synthesis-toolbar__actions">
        <button type="button" disabled={!project || Boolean(busy)} onClick={() => open()}>Open in editor <SynthesisIcon name="external" /></button>
        <button type="button" disabled={!project || loading || Boolean(busy)} onClick={() => setRevision(current => current + 1)}><SynthesisIcon name="refresh" />{loading ? "Refreshing…" : "Refresh"}</button>
        <button ref={diagnosticsTrigger} type="button" className="synthesis-diagnostics-toggle" disabled={!project} aria-label={`Project diagnostics: ${diagnostics.label}`} aria-expanded={diagnosticsOpen && Boolean(project)} aria-controls="synthesis-diagnostics" onClick={() => setDiagnosticsOpen(open => !open)}><SynthesisIcon name="diagnostics" /><span>Diagnostics</span><span className={`synthesis-status-dot status-${diagnostics.tone}`} /></button>
        {running ? <button type="button" className="synthesis-stop" disabled={Boolean(busy)} onClick={() => runAction("cancel")}>{busy === "cancel" ? "Stopping…" : "Stop"}</button>
          : <button type="button" className="synthesis-run" disabled={!module?.valid || Boolean(busy) || loading} onClick={startRun}><SynthesisIcon name="play" />{busy === "run" ? "Starting…" : "Run synthesis"}</button>}
      </div>
    </header>
    {error ? <div className="synthesis-message synthesis-message--error" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError("")}>×</button></div> : null}
    {notice ? <div className="synthesis-message" role="status">{notice}<button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}>×</button></div> : null}
    {!project ? <div className="synthesis-welcome"><span className="synthesis-welcome__symbol" aria-hidden="true">⌘</span><h2>Build from a contract</h2><p>Connect a project to discover its .lcspec and .lcflow files. Edit in your IDE, then run and follow each step here.</p>{onCreateProject ? <button type="button" onClick={onCreateProject}>Add project</button> : <p>Add a project from the sidebar to begin.</p>}</div>
      : <div className={`synthesis-layout${diagnosticsOpen ? " is-inspector-open" : ""}`}>
        <aside className="synthesis-module-pane" aria-label="Synthesis modules">
          <header className="synthesis-pane-header"><strong>Modules</strong><span>{visibleModules.length}</span></header>
          <div className="synthesis-module-list">{visibleModules.map(item => <div className="synthesis-module-row" key={item.id}><button type="button" disabled={Boolean(busy)} aria-pressed={item.id === moduleId} className={`synthesis-module ${item.id === moduleId ? "is-selected" : ""}`} onClick={() => setModuleId(item.id)}>
            <span className={`synthesis-status-dot ${item.valid ? "is-valid" : "is-invalid"}`} /><span><strong>{item.name}</strong><small>{item.valid ? "Contract ready" : "Needs attention"}</small>{item.specPath ? <small className="synthesis-module-path" title={item.specPath}>{item.specPath.replace(/\/[^/]+$/, "") === item.specPath ? "Project root" : item.specPath.replace(/\/[^/]+$/, "")}</small> : null}</span>
          </button><button type="button" className="synthesis-module-remove" disabled={Boolean(busy)} aria-label={`Remove ${item.name} from view`} title="Remove from view · Files stay on disk" onClick={() => hideModule(item.id)}><SynthesisIcon name="close" /></button></div>)}{!visibleModules.length ? <p className="synthesis-empty">{loading ? "Discovering modules…" : removedModules.length ? "All modules are hidden. Restore one below." : "No DSL modules found in this project."}</p> : null}</div>
          {removedModules.length ? <details className="synthesis-hidden-modules"><summary>Hidden modules <span>{removedModules.length}</span></summary><p>Files remain in your project.</p>{removedModules.map(item => <button key={item.id} type="button" disabled={Boolean(busy)} aria-label={`Restore ${item.name}`} onClick={() => restoreModule(item.id)}><span>{item.name}</span><SynthesisIcon name="plus" /></button>)}</details> : null}
          <button ref={newModuleTrigger} type="button" className="synthesis-new-module" disabled={Boolean(busy) || loading} onClick={() => setCreatingModule(true)}><SynthesisIcon name="plus" />New module</button>
          <p className="synthesis-discovery-hint">DSL files saved in this project appear after Refresh.</p>
          <header className="synthesis-pane-header synthesis-run-history-title"><strong>Run history</strong></header>
          <div className="synthesis-run-history">{moduleRuns.slice(0, 30).map(item => <button type="button" key={item.id} disabled={Boolean(busy)} className={item.id === runId ? "is-selected" : ""} aria-pressed={item.id === runId} onClick={() => { setRunId(item.id); setRun(item); }}>
            <strong className={`status-${item.status}`}>{statusLabel(item.status)}</strong><small>{new Date(item.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
          </button>)}{!moduleRuns.length ? <p className="synthesis-empty">Runs for this module appear here.</p> : null}</div>
        </aside>
        <main className="synthesis-main-pane">
          <header className="synthesis-module-header"><div><h2>{module?.name ?? (moduleId ? "Loading module…" : "Your first synthesis")}</h2><span>{module ? "Edit the source in your IDE. Refresh to validate saved changes." : "Create a module or save matching .lcspec and .lcflow files in your project, then Refresh."}</span></div>
            {run ? <span className={`synthesis-badge status-${run.status}`}>{statusLabel(run.status)}</span> : null}</header>
          <div className="synthesis-tabs" role="tablist" aria-label="Module views">{([['contract', 'Contract'], ['flow', 'Flow'], ['changes', 'Changes'], ['preview', 'Preview']] as const).map(([id, label]) =>
            <button role="tab" type="button" key={id} id={`synthesis-tab-${id}`} aria-selected={tab === id} aria-controls="synthesis-source-panel" disabled={!module && !run} onClick={() => setTab(id)}>{label}</button>)}
            {sourceTab && module ? <button type="button" className="synthesis-open-source" disabled={Boolean(busy)} onClick={() => open(tab === "contract" ? "spec" : "flow")}>Open project .{tab === "contract" ? "lcspec" : "lcflow"} ↗</button> : null}
          </div>
          {sourceTab ? <div className="synthesis-source-origin">
            {run ? <div role="group" aria-label="Source version"><button type="button" aria-pressed={sourceOrigin === "project"} onClick={() => setSourceOrigin("project")}>Project source</button><button type="button" aria-pressed={sourceOrigin === "snapshot"} onClick={() => setSourceOrigin("snapshot")}>Run snapshot</button></div> : <span>Project source</span>}
            <span>{sourceOrigin === "snapshot" && run ? `Frozen for run ${run.id.slice(0, 8)}${snapshot ? ` · ${snapshot.specHash.slice(0, 10)}` : ""}` : "Current saved files · run evidence refers to its frozen snapshot"}</span>
          </div> : null}
          <SynthesisOutput run={run}>
          <section className="synthesis-source-panel" id="synthesis-source-panel" role="tabpanel" aria-labelledby={`synthesis-tab-${tab}`}>
            {sourceTab ? sourceOrigin === "snapshot" && run ? snapshot ? <SourcePreview source={tab === "contract" ? snapshot.specSource : snapshot.flowSource} name={tab === "contract" ? "LC Spec run snapshot" : "LC Flow run snapshot"} /> : <div className="synthesis-empty" role={sourceError ? "alert" : "status"}>{sourceError || "Loading frozen run sources…"}</div> : module ? <SourcePreview source={(tab === "contract" ? module.specSource : module.flowSource) ?? ""} name={tab === "contract" ? "LC Spec source" : "LC Flow source"} /> : <div className="synthesis-empty">Select a module to inspect its contract and flow.</div>
              : tab === "changes" ? <><div className="synthesis-diff-toolbar"><span>{run?.appliedAt ? "Applied to project" : running ? "Changes are available after this run stops." : `${diff?.files.length ?? 0} changed files`}</span><button type="button" disabled={!diff?.canApply || run?.status !== "accepted" || Boolean(run?.appliedAt) || Boolean(busy)} onClick={apply}>{busy === "apply" ? "Applying…" : "Apply verified patch"}</button></div><SynthesisDiff diff={diff} loading={diffLoading && !running} /></>
                : run ? <div className="synthesis-preview"><p>Candidate preview · isolated from the application</p><iframe key={`${run.id}:${run.status}`} title="Generated candidate preview" src={`/synthesis/runs/${encode(run.id)}/preview/index.html`} sandbox="allow-scripts" referrerPolicy="no-referrer" /></div> : <div className="synthesis-empty">Run the module to preview a generated candidate.</div>}
          </section>
          {run?.error ? <div className="synthesis-message synthesis-message--error">{run.error}</div> : null}
          {run && recoverableStatuses.has(run.status) ? <div className="synthesis-recovery"><span>Start a new run from this frozen snapshot. The existing run and its history stay available.</span><button type="button" disabled={Boolean(busy)} onClick={() => runAction("resume")}>{busy === "resume" ? "Restarting…" : "Restart from snapshot"}</button></div> : null}
          </SynthesisOutput>
        </main>
        {diagnosticsOpen ? <SynthesisDiagnostics module={module} run={run} busy={Boolean(busy)} onOpenSource={open} onClose={closeDiagnostics} /> : null}
      </div>}
    <footer className="synthesis-workspace-footer"><label htmlFor="synthesis-project">Workspace</label><select id="synthesis-project" value={projectId} disabled={Boolean(busy)} onChange={event => setProjectId(event.target.value)} aria-label="Synthesis workspace project"><option value="" disabled>Select project</option>{availableProjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><span title={project?.rootPath}>{project?.rootPath ?? "Choose a project to start"}</span>{onCreateProject ? <button type="button" disabled={Boolean(busy)} onClick={onCreateProject}>+ Project</button> : null}</footer>
    {creatingModule && project && active ? <NewModuleDialog key={projectId} project={project} modules={modules} onClose={closeNewModule} onCreated={moduleCreated} /> : null}
  </div>;
}
