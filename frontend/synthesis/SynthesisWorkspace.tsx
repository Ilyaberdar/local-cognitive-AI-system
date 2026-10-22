import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { encode, errorMessage, isAbort, RequestError, synthesisRequest } from "./api";
import { SynthesisOutput, runLabel } from "./SynthesisActivity";
import { SynthesisChanges } from "./SynthesisChanges";
import { SynthesisAgents } from "./SynthesisAgents";
import { diagnosticSummary, SynthesisDiagnostics } from "./SynthesisDiagnostics";
import { SynthesisModules } from "./SynthesisModules";
import { SynthesisIcon } from "./SynthesisIcon";
import { NewModuleDialog } from "./NewModuleDialog";
import { WebTargetsDialog } from "./WebTargetsDialog";
import { normalizeLines, SourceEditor, SourcePreview, type SourceProblem } from "./SourceEditor";
import { usePaneSplit, usePaneWidth } from "./usePaneSplit";
import type { CandidateDiff, RunSources, SynthesisModule, SynthesisRun, SynthesisWorkspaceProps } from "./types";

const activeStatuses = new Set(["running", "queued"]);
const recoverableStatuses = new Set(["interrupted", "blocked", "unresolved", "cancelled", "needs_review"]);
type SourceTab = "contract" | "flow" | "agents" | "changes";
type SourceFile = "spec" | "flow";
/** The panels beside the module, in the order they were opened (the later one below). */
type Panel = "modules" | "diagnostics";
// Each machine keeps its own view preferences (a server's screen passes its key).
const projectKey = (machine = "") => `lcai.synthesis.project.v1${machine ? `:${machine}` : ""}`;
const hiddenModulesKey = (machine = "") => `lcai.synthesis.hiddenModules.v1${machine ? `:${machine}` : ""}`;
const panelsKey = (machine = "") => `lcai.synthesis.panels.v1${machine ? `:${machine}` : ""}`;
function storedProject(machine?: string) { try { return localStorage.getItem(projectKey(machine)) ?? ""; } catch { return ""; } }
function storedHiddenModules(machine?: string): Record<string, string[]> {
  try {
    const value = JSON.parse(localStorage.getItem(hiddenModulesKey(machine)) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, ids]) => Array.isArray(ids)).map(([project, ids]) => [project, (ids as unknown[]).filter((id): id is string => typeof id === "string")]));
  } catch { return {}; }
}
/** The module list is open until it is closed once. */
function storedPanels(machine?: string): Panel[] {
  try {
    const value = JSON.parse(localStorage.getItem(panelsKey(machine)) ?? "null");
    return Array.isArray(value) ? [...new Set(value.filter((item): item is Panel => item === "modules" || item === "diagnostics"))] : ["modules"];
  } catch { return ["modules"]; }
}

export function SynthesisWorkspace({ projects, colorMode = "dark", active = true, onCreateProject, selectedProjectId, transport, storageKey }: SynthesisWorkspaceProps) {
  // This computer's API, or the paired server's operations (R5-5).
  const request = <T,>(path: string, options: RequestInit = {}): Promise<T> => transport ? transport.request<T>(path, options) : synthesisRequest<T>(path, options);
  const remote = transport?.remote;
  const availableProjects = projects.filter(project => !project.archivedAt);
  const [projectId, setProjectId] = useState(() => {
    const saved = storedProject(storageKey); return availableProjects.some(project => project.id === saved) ? saved : availableProjects[0]?.id ?? "";
  });
  const [modules, setModules] = useState<SynthesisModule[]>([]);
  const [hiddenModules, setHiddenModules] = useState(() => storedHiddenModules(storageKey));
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
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [diff, setDiff] = useState<(CandidateDiff & { runId: string }) | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [panels, setPanels] = useState(() => storedPanels(storageKey));
  const [focusPanel, setFocusPanel] = useState<Panel | null>(null);
  const [creatingModule, setCreatingModule] = useState(false);
  /** Edits of a module's contract and flow not saved yet, by project, module and file. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** A save the file refused: it was changed elsewhere since the editor read it. */
  const [conflict, setConflict] = useState<{ key: string; message: string } | null>(null);
  const [reveal, setReveal] = useState<{ file: SourceFile; line: number; key: number } | undefined>();
  /** Whether this project's files may go to cloud models: shown and set only on the computer that owns it. */
  const [cloud, setCloud] = useState<boolean | undefined>(undefined);
  /** Web origins this project's agents may reach with the http right: shown everywhere, set only on the owner. */
  const [webTargets, setWebTargets] = useState<string[] | undefined>(undefined);
  const [editingWebTargets, setEditingWebTargets] = useState(false);
  const newModuleTrigger = useRef<HTMLButtonElement>(null);
  const triggers = { modules: useRef<HTMLButtonElement>(null), diagnostics: useRef<HTMLButtonElement>(null) };
  const selection = useRef({ projectId, moduleId, runId });
  selection.current = { projectId, moduleId, runId };
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  /** Runs deleted here: a list read before the deletion does not bring them back. */
  const deletedRuns = useRef(new Set<string>());
  const kept = (list: SynthesisRun[]) => list.filter(item => !deletedRuns.current.has(item.id));
  const project = availableProjects.find(item => item.id === projectId);
  const running = Boolean(run && activeStatuses.has(run.status));
  const moduleRuns = runs.filter(item => item.moduleId === moduleId);
  const sourceTab = tab === "contract" || tab === "flow";
  const sourceFile: SourceFile = tab === "flow" ? "flow" : "spec";
  const snapshot = runSources?.runId === runId ? runSources : null;
  const shownDiff = diff?.runId === runId ? diff : null;
  const diagnostics = diagnosticSummary(module);

  const draftKey = (file: SourceFile) => `${projectId}\n${moduleId}\n${file}`;
  const savedSource = (file: SourceFile) => normalizeLines((file === "spec" ? module?.specSource : module?.flowSource) ?? "");
  const dirty = (file: SourceFile) => drafts[draftKey(file)] !== undefined && drafts[draftKey(file)] !== savedSource(file);
  const unsaved = Boolean(module) && (dirty("spec") || dirty("flow"));
  // The project's own files are edited here; a run's snapshot and a server's files are only read.
  const editable = Boolean(module) && !remote && (sourceOrigin === "project" || !run);
  const problemsOf = (file: SourceFile): SourceProblem[] => (module?.diagnostics ?? [])
    .filter(item => item.line && item.file === (file === "spec" ? module?.specPath : module?.flowPath))
    .map(item => ({ line: item.line!, column: item.column, message: item.message, severity: item.severity === "warning" ? "warning" : "error" }));

  // The panels beside the module slide in and out (as a chat's Session setup does): they stay while they leave.
  const sideOpen = panels.length > 0 && Boolean(project);
  const [side, setSide] = useState<"closed" | "entering" | "open" | "leaving">(() => sideOpen ? "open" : "closed");
  useEffect(() => {
    if (sideOpen) {
      setSide(current => current === "open" ? current : "entering");
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setSide("open")));
      return () => cancelAnimationFrame(frame);
    }
    setSide(current => current === "closed" ? current : "leaving");
    const timer = setTimeout(() => setSide("closed"), document.documentElement.dataset.motion === "off" ? 0 : 340);
    return () => clearTimeout(timer);
  }, [sideOpen]);
  const lastPanels = useRef(panels);
  if (panels.length) lastPanels.current = panels;
  const shownPanels = panels.length ? panels : lastPanels.current;
  useEffect(() => { try { localStorage.setItem(panelsKey(storageKey), JSON.stringify(panels)); } catch { /* Optional view preference. */ } }, [panels]);
  const togglePanel = (panel: Panel) => {
    if (panels.includes(panel)) { setPanels(current => current.filter(item => item !== panel)); return; }
    setFocusPanel(panel); setPanels(current => [...current, panel]);
  };
  const closePanel = (panel: Panel) => { setPanels(current => current.filter(item => item !== panel)); triggers[panel].current?.focus(); };
  const layout = useRef<HTMLDivElement>(null);
  const sideColumn = useRef<HTMLDivElement>(null);
  // The module keeps at least 420 px beside the panels.
  const sideWidth = usePaneWidth("lcai.synthesis.sideWidth.v1", 340, 260, () => (layout.current?.clientWidth ?? 1200) - 420);
  const sideSplit = usePaneSplit("lcai.synthesis.sideSplit.v1", 50, "y", sideColumn);

  // Focus rings are for the keyboard: a click or a drag never leaves one behind.
  const root = useRef<HTMLDivElement>(null);
  const modality = (value: "pointer" | "keyboard") => { if (root.current && root.current.dataset.modality !== value) root.current.dataset.modality = value; };
  const visibleModules = modules.filter(item => !hiddenModules[projectId]?.includes(item.id));
  const removedModules = modules.filter(item => hiddenModules[projectId]?.includes(item.id));
  const restoreModule = (id: string) => {
    setHiddenModules(current => ({ ...current, [projectId]: (current[projectId] ?? []).filter(item => item !== id) }));
    setModuleId(id);
  };
  const hideModule = (id: string) => {
    setHiddenModules(current => ({ ...current, [projectId]: [...new Set([...(current[projectId] ?? []), id])] }));
  };
  useEffect(() => { try { localStorage.setItem(hiddenModulesKey(storageKey), JSON.stringify(hiddenModules)); } catch { /* Optional view preference. */ } }, [hiddenModules]);
  useEffect(() => {
    const visible = modules.filter(item => !hiddenModules[projectId]?.includes(item.id));
    setModuleId(current => visible.some(item => item.id === current) ? current : visible[0]?.id ?? "");
  }, [modules, hiddenModules, projectId]);

  useEffect(() => {
    // Projects a server sends arrive after the screen: the saved choice is still the first pick.
    if (!availableProjects.some(item => item.id === projectId)) {
      const saved = storedProject(storageKey);
      setProjectId(availableProjects.some(item => item.id === saved) ? saved : availableProjects[0]?.id ?? "");
    }
  }, [projects, projectId]);
  useEffect(() => { if (selectedProjectId) setProjectId(selectedProjectId); }, [selectedProjectId]);
  useEffect(() => {
    try { if (projectId) localStorage.setItem(projectKey(storageKey), projectId); } catch { /* Storage may be unavailable. */ }
    setModules([]); setModuleId(""); setModule(null); setRuns([]); setRunId(""); setRun(null); setDiff(null); setError(""); setNotice("");
    setCreatingModule(false); setEditingWebTargets(false);
  }, [projectId]);
  // The first read of a project shows it is discovering; Refresh keeps the screen as it is and only
  // turns its icon, long enough to be seen.
  const loadedProject = useRef("");
  const loads = useRef(0);
  useEffect(() => {
    if (!active || !projectId) return;
    const controller = new AbortController();
    const load = ++loads.current;
    const started = Date.now();
    if (loadedProject.current !== projectId) setLoading(true);
    Promise.all([
      request<{ modules: SynthesisModule[] }>(`/projects/${encode(projectId)}/modules`, { signal: controller.signal }),
      request<SynthesisRun[]>(`/projects/${encode(projectId)}/runs`, { signal: controller.signal })
    ]).then(([moduleList, runList]) => {
      if (controller.signal.aborted) return;
      setModules(moduleList.modules); setRuns(kept(runList));
      loadedProject.current = projectId;
      setError("");
    }).catch(reason => { if (!isAbort(reason) && !controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setTimeout(() => { if (mounted.current && loads.current === load) setRefreshing(false); }, Math.max(0, 500 - (Date.now() - started)));
      });
    return () => controller.abort();
  }, [projectId, active, revision]);
  const refresh = () => { setRefreshing(true); setRevision(current => current + 1); };

  // Runs started elsewhere (another window, a paired device, MCP) join the history while it is open;
  // a run's own poll below keeps the selected one current.
  useEffect(() => {
    if (!active || !projectId) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      request<SynthesisRun[]>(`/projects/${encode(projectId)}/runs`, { signal: controller.signal })
        .then(list => { if (!controller.signal.aborted) setRuns(current => kept(list).map(item => ({ ...current.find(known => known.id === item.id), ...item }))); })
        .catch(() => { /* The next tick tries again; a lasting failure shows on the run's own poll. */ });
    }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [projectId, active]);

  useEffect(() => {
    setModule(null); setRunId(""); setRun(null); setDiff(null);
    setSourceOrigin("project"); setRunSources(null); setSourceError(""); setReveal(undefined);
  }, [projectId, moduleId]);
  useEffect(() => {
    if (!moduleId || !projectId || !active) return;
    const controller = new AbortController();
    request<SynthesisModule>(`/projects/${encode(projectId)}/modules/${encode(moduleId)}`, { signal: controller.signal })
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
        const result = await request<SynthesisRun>(`/runs/${encode(runId)}`, { signal: controller.signal });
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
    request<RunSources>(`/runs/${encode(runId)}/sources`, { signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted && selection.current.runId === runId) setRunSources({ ...result, runId });
      })
      .catch(reason => {
        if (!isAbort(reason) && !controller.signal.aborted && selection.current.runId === runId) setSourceError(errorMessage(reason));
      });
    return () => controller.abort();
  }, [runId, sourceOrigin, sourceTab, active]);

  // A run's changes stay on screen while they are read again (Refresh, Apply).
  useEffect(() => {
    if (tab !== "changes" || !runId || !active || running) return;
    const controller = new AbortController();
    setDiffLoading(true);
    request<CandidateDiff>(`/runs/${encode(runId)}/diff`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setDiff({ ...result, runId }); })
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
  const open = (file?: SourceFile) => void perform("open", async () => {
    await request(`/projects/${encode(projectId)}/open`, { method: "POST", body: JSON.stringify(file ? { moduleId, file } : {}) });
    setNotice(file ? `Opened ${file === "spec" ? ".lcspec" : ".lcflow"} in your editor.` : "Opened project in your editor.");
  });

  const edit = (file: SourceFile, value: string) => {
    const key = draftKey(file), saved = savedSource(file);
    setDrafts(current => {
      const next = { ...current };
      if (value === saved) delete next[key]; else next[key] = value;
      return next;
    });
  };
  const discard = (file: SourceFile) => {
    const key = draftKey(file);
    setDrafts(current => { const next = { ...current }; delete next[key]; return next; });
    setConflict(current => current?.key === key ? null : current);
  };
  /** Writes a file's edits; false when the file changed elsewhere since it was read (nothing written). */
  const saveSource = async (file: SourceFile, replace = false): Promise<boolean> => {
    const key = draftKey(file), source = drafts[key];
    if (source === undefined || !module) return true;
    const expected = (file === "spec" ? module.specSource : module.flowSource) ?? "";
    try {
      const saved = await request<SynthesisModule>(`/projects/${encode(projectId)}/modules/${encode(moduleId)}/source`,
        { method: "PUT", body: JSON.stringify({ file, source, ...(replace ? {} : { expected }) }) });
      // Typing that went on during the save stays a draft.
      setDrafts(current => { if (current[key] !== source) return current; const next = { ...current }; delete next[key]; return next; });
      setConflict(current => current?.key === key ? null : current);
      setModules(current => current.map(item => item.id === saved.id ? saved : item));
      if (selection.current.projectId === projectId && selection.current.moduleId === moduleId) setModule(saved);
      return true;
    } catch (reason) {
      if (reason instanceof RequestError && reason.status === 409) { setConflict({ key, message: reason.message }); return false; }
      throw reason;
    }
  };
  const save = (file: SourceFile, replace = false) => void perform("save", async () => { await saveSource(file, replace); });
  const reload = (file: SourceFile) => { discard(file); setRevision(current => current + 1); };
  const showLine = (file: SourceFile, line?: number) => {
    setTab(file === "flow" ? "flow" : "contract"); setSourceOrigin("project");
    if (line) setReveal({ file, line, key: Date.now() });
  };

  const closeNewModule = () => { setCreatingModule(false); newModuleTrigger.current?.focus(); };
  const moduleCreated = (created: SynthesisModule) => {
    setModules(current => [...current.filter(item => item.id !== created.id), created]); restoreModule(created.id); setTab("contract");
    setRevision(current => current + 1); setNotice(`${created.name} created at ${created.specPath}. ${remote ? `Edit its contract and flow on ${remote.hostName}, then Refresh.` : "Define its contract and flow here or in your editor."}`);
    closeNewModule();
  };
  const startRun = () => void perform("run", async () => {
    // A run reads the saved files: what is edited here is saved first.
    for (const file of ["spec", "flow"] as const) if (dirty(file) && !await saveSource(file)) return;
    const created = await request<SynthesisRun>(`/projects/${encode(projectId)}/runs`, { method: "POST", body: JSON.stringify({ moduleId }) });
    if (selection.current.projectId !== projectId || selection.current.moduleId !== moduleId) return;
    setRuns(current => [created, ...current.filter(item => item.id !== created.id)]); setRunId(created.id); setRun(created);
  });
  const runAction = (action: "cancel" | "resume") => void perform(action, async () => {
    const updated = await request<SynthesisRun>(`/runs/${encode(runId)}/${action}`, { method: "POST" });
    if (selection.current.runId !== runId) return;
    setRunId(updated.id); setRun(updated); setRuns(current => [updated, ...current.filter(item => item.id !== updated.id)]);
  });
  const forget = (ids: string[]) => {
    for (const id of ids) deletedRuns.current.add(id);
    setRuns(current => current.filter(item => !ids.includes(item.id)));
    if (ids.includes(selection.current.runId)) { setRunId(""); setRun(null); }
  };
  const deleteRun = (id: string) => void perform("delete", async () => {
    await request(`/runs/${encode(id)}`, { method: "DELETE" });
    forget([id]);
  });
  const clearRuns = () => void perform("delete", async () => {
    const name = module?.name ?? moduleId;
    const before = runs.filter(item => item.moduleId === moduleId && !activeStatuses.has(item.status)).map(item => item.id);
    const result = await request<{ deleted: number; kept: number }>(`/projects/${encode(projectId)}/runs?moduleId=${encode(moduleId)}`, { method: "DELETE" });
    const left = new Set((await request<SynthesisRun[]>(`/projects/${encode(projectId)}/runs`)).map(item => item.id));
    if (selection.current.projectId !== projectId) return;
    forget(before.filter(id => !left.has(id)));
    setNotice(`${result.deleted} ${result.deleted === 1 ? "run" : "runs"} of ${name} deleted.${result.kept ? ` ${result.kept} still going ${result.kept === 1 ? "stays" : "stay"}.` : ""}`);
  });
  // Another project (or host) shows nothing until its own answer arrives.
  useEffect(() => { setCloud(undefined); }, [projectId, remote]);
  useEffect(() => {
    if (!projectId) return;
    let current = true;
    // An older host has no such setting: the switch (on a server, the status) is not shown. Refresh reads it again.
    request<{ allowed?: unknown } | null>(`/projects/${encode(projectId)}/cloud`).then(result => { if (current) setCloud(typeof result?.allowed === "boolean" ? result.allowed : undefined); }, () => { if (current) setCloud(undefined); });
    return () => { current = false; };
  }, [projectId, remote, revision]);
  const toggleCloud = (allowed: boolean) => void perform("cloud", async () => {
    const result = await request<{ allowed?: unknown } | null>(`/projects/${encode(projectId)}/cloud`, { method: "PUT", body: JSON.stringify({ allowed }) });
    if (selection.current.projectId !== projectId) return;
    setCloud(result?.allowed === true); setRevision(current => current + 1);
    setNotice(result?.allowed === true ? "Cloud models may now read this project's contract and files." : "This project now runs local models only.");
  });
  // A device only reads the list (no route changes it); the owner edits it in the dialog. An older
  // host answers neither, so the affordance is not shown. Refresh reads it again.
  useEffect(() => { setWebTargets(undefined); }, [projectId, remote]);
  useEffect(() => {
    if (!projectId) return;
    let current = true;
    request<{ targets?: unknown } | null>(`/projects/${encode(projectId)}/web-targets`).then(result => { if (current) setWebTargets(Array.isArray(result?.targets) ? result!.targets.filter((item): item is string => typeof item === "string") : undefined); }, () => { if (current) setWebTargets(undefined); });
    return () => { current = false; };
  }, [projectId, remote, revision]);
  const webTargetsSaved = (next: string[]) => {
    if (selection.current.projectId !== projectId) return;
    setWebTargets(next); setEditingWebTargets(false); setRevision(current => current + 1);
    setNotice(next.length ? `This project's agents may reach ${next.length} web ${next.length === 1 ? "target" : "targets"} with the http right.` : "This project has no web targets. The http right is refused until you add one.");
  };
  const apply = () => void perform("apply", async () => {
    await request(`/runs/${encode(runId)}/apply`, { method: "POST" });
    if (selection.current.runId !== runId) return;
    setNotice("Verified candidate applied to the project."); setRevision(current => current + 1);
  });

  const title = module?.name ?? (!project ? "Synthesis" : moduleId ? "Loading module…" : "Your first synthesis");
  const subtitle = !project ? "" : !module ? "Create a module or save matching .lcspec and .lcflow files in your project, then Refresh."
    : remote ? `The source is edited on ${remote.hostName}. Refresh to see saved changes.` : "Edit the contract and flow here, or in your IDE and Refresh. Saving checks them.";
  const fileConflict = conflict?.key === draftKey(sourceFile) ? conflict : null;
  const sourceView = () => {
    if (sourceOrigin === "snapshot" && run) return snapshot ? <SourcePreview source={tab === "contract" ? snapshot.specSource : snapshot.flowSource} name={tab === "contract" ? "LC Spec run snapshot" : "LC Flow run snapshot"} />
      : <div className="synthesis-empty" role={sourceError ? "alert" : "status"}>{sourceError || "Loading frozen run sources…"}</div>;
    if (!module) return <div className="synthesis-empty">{moduleId ? "Loading the module…" : <>Select a module to inspect its contract and flow.{!remote && project ? <button type="button" disabled={Boolean(busy) || loading} onClick={() => setCreatingModule(true)}><SynthesisIcon name="plus" />New module</button> : null}</>}</div>;
    const label = tab === "contract" ? "LC Spec source" : "LC Flow source";
    if (!editable) return <SourcePreview source={(tab === "contract" ? module.specSource : module.flowSource) ?? ""} name={label} />;
    const problems = problemsOf(sourceFile);
    return <>
      <SourceEditor key={`${projectId}:${moduleId}:${sourceFile}`} value={drafts[draftKey(sourceFile)] ?? savedSource(sourceFile)} label={label} problems={problems}
        reveal={reveal?.file === sourceFile ? reveal : undefined} onChange={value => edit(sourceFile, value)} onSave={() => { if (dirty(sourceFile)) save(sourceFile); }} />
      {problems.length ? <div className="synthesis-problems" aria-label="Problems in this file">
        {dirty(sourceFile) ? <span className="synthesis-problems__note">As last saved:</span> : null}
        {problems.slice(0, 3).map((problem, index) => <button type="button" key={index} className={`is-${problem.severity}`} onClick={() => setReveal({ file: sourceFile, line: problem.line, key: Date.now() })}>
          <SynthesisIcon name="warning" /><span>Line {problem.line}</span>{problem.message}</button>)}
        {problems.length > 3 ? <span className="synthesis-problems__note">{problems.length - 3} more in Diagnostics</span> : null}
      </div> : null}
    </>;
  };

  return <div className="synthesis-workspace" data-color-mode={colorMode} ref={root} data-modality="pointer"
    onPointerDownCapture={() => modality("pointer")} onKeyDownCapture={event => { if (!event.metaKey && !event.ctrlKey && !event.altKey) modality("keyboard"); }}>
    <header className="synthesis-toolbar">
      <div className="synthesis-toolbar__heading">
        {project ? <span className="synthesis-eyebrow">Synthesis · {project.name}</span> : null}
        <div className="synthesis-title"><h2>{title}</h2>{run && module ? <span className={`synthesis-badge status-${run.status}`}>{runLabel(run)}</span> : null}</div>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      <div className="synthesis-toolbar__actions">
        {remote ? null : <button type="button" disabled={!project || Boolean(busy)} onClick={() => open()}>Open in editor <SynthesisIcon name="external" /></button>}
        <button type="button" className={`synthesis-refresh${refreshing ? " is-refreshing" : ""}`} aria-busy={refreshing || undefined} disabled={!project || loading || Boolean(busy)} onClick={refresh}><SynthesisIcon name="refresh" />Refresh</button>
        <button ref={triggers.modules} type="button" className="synthesis-panel-toggle" disabled={!project} aria-label={`Modules: ${visibleModules.length}`} aria-expanded={panels.includes("modules") && Boolean(project)} aria-controls="synthesis-modules" onClick={() => togglePanel("modules")}><SynthesisIcon name="modules" /><span>Modules</span><span className="synthesis-count">{visibleModules.length}</span></button>
        <button ref={triggers.diagnostics} type="button" className="synthesis-panel-toggle synthesis-diagnostics-toggle" disabled={!project} aria-label={`Project diagnostics: ${diagnostics.label}`} aria-expanded={panels.includes("diagnostics") && Boolean(project)} aria-controls="synthesis-diagnostics" onClick={() => togglePanel("diagnostics")}><SynthesisIcon name="diagnostics" /><span>Diagnostics</span><span className={`synthesis-status-dot status-${diagnostics.tone}`} /></button>
        {running ? <button type="button" className="synthesis-stop" disabled={Boolean(busy)} onClick={() => runAction("cancel")}>{busy === "cancel" ? "Stopping…" : "Stop"}</button>
          : <button type="button" className="synthesis-run" disabled={!(module?.valid || unsaved) || Boolean(busy) || loading} onClick={startRun}><SynthesisIcon name="play" />{busy === "run" ? "Starting…" : "Run synthesis"}</button>}
      </div>
    </header>
    {error ? <div className="synthesis-message synthesis-message--error" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError("")}>×</button></div> : null}
    {notice ? <div className="synthesis-message" role="status">{notice}<button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}>×</button></div> : null}
    {!project ? <div className="synthesis-welcome"><span className="synthesis-welcome__symbol" aria-hidden="true">⌘</span><h2>Build from a contract</h2><p>Connect a project to discover its .lcspec and .lcflow files. Edit them here or in your IDE, then run and follow each step here.</p>{onCreateProject ? <button type="button" onClick={onCreateProject}>Add project</button> : <p>Add a project from the sidebar to begin.</p>}</div>
      : <div ref={layout} className={`synthesis-layout${side === "open" ? " is-side-open" : ""}`} data-resizing={sideWidth.resizing || undefined}
        style={{ "--synthesis-side-width": `${sideWidth.value}px` } as CSSProperties}>
        <main className="synthesis-main-pane">
          <div className="synthesis-tabs" role="tablist" aria-label="Module views">{([['contract', 'Contract'], ['flow', 'Flow'], ...(run?.agents ? [['agents', `Agents · ${run.agents.total}`]] : []), ['changes', 'Changes']] as Array<[SourceTab, string]>).map(([id, label]) =>
            <button role="tab" type="button" key={id} id={`synthesis-tab-${id}`} aria-selected={tab === id} aria-controls="synthesis-source-panel" disabled={!module && !run} onClick={() => { setTab(id); setReveal(undefined); }}>{label}{(id === "contract" && dirty("spec")) || (id === "flow" && dirty("flow")) ? <span className="synthesis-dirty" title="Unsaved changes">•</span> : null}</button>)}
            {sourceTab && module && !remote ? <button type="button" className="synthesis-open-source" disabled={Boolean(busy)} onClick={() => open(tab === "contract" ? "spec" : "flow")}>Open project .{tab === "contract" ? "lcspec" : "lcflow"} ↗</button> : null}
          </div>
          {sourceTab ? <div className="synthesis-source-origin">
            {run ? <div role="group" aria-label="Source version"><button type="button" aria-pressed={sourceOrigin === "project"} onClick={() => setSourceOrigin("project")}>Project source</button><button type="button" aria-pressed={sourceOrigin === "snapshot"} onClick={() => setSourceOrigin("snapshot")}>Run snapshot</button></div> : <span>Project source</span>}
            <span>{sourceOrigin === "snapshot" && run ? `Frozen for run ${run.id.slice(0, 8)}${snapshot ? ` · ${snapshot.specHash.slice(0, 10)}` : ""}` : editable ? dirty(sourceFile) ? "Unsaved changes · a run saves them first" : "Saved · run evidence refers to its frozen snapshot" : "Current saved files · run evidence refers to its frozen snapshot"}</span>
            {editable && sourceTab ? <div className="synthesis-source-actions">
              <button type="button" disabled={!dirty(sourceFile) || Boolean(busy)} onClick={() => discard(sourceFile)}>Discard</button>
              <button type="button" className="synthesis-primary" disabled={!dirty(sourceFile) || Boolean(busy)} title="⌘S or Ctrl+S" onClick={() => save(sourceFile)}>{busy === "save" ? "Saving…" : "Save"}</button>
            </div> : null}
          </div> : null}
          {sourceTab && fileConflict ? <div className="synthesis-message synthesis-message--error synthesis-conflict" role="alert"><span>{fileConflict.message}</span>
            <button type="button" disabled={Boolean(busy)} onClick={() => reload(sourceFile)}>Reload from disk</button><button type="button" disabled={Boolean(busy)} onClick={() => save(sourceFile, true)}>Replace with mine</button></div> : null}
          <SynthesisOutput run={run}>
          <section className={`synthesis-source-panel${sourceTab && editable ? " is-editing" : ""}`} id="synthesis-source-panel" role="tabpanel" aria-labelledby={`synthesis-tab-${tab}`}>
            {sourceTab ? sourceView()
              : tab === "agents" && run ? <SynthesisAgents run={run} request={request} />
              : <div className="synthesis-changes-view"><div className="synthesis-diff-toolbar"><span>{run?.appliedAt ? "Applied to project" : running ? "Changes are available after this run stops." : `${shownDiff?.files.length ?? 0} changed files`}</span><button type="button" disabled={!shownDiff?.canApply || run?.status !== "accepted" || Boolean(run?.appliedAt) || Boolean(busy)} onClick={apply}>{busy === "apply" ? "Applying…" : "Apply verified patch"}</button></div><SynthesisChanges diff={shownDiff} loading={diffLoading && !running && !shownDiff} gates={run?.evidence?.gates} runId={runId} request={request} remote={Boolean(remote)} /></div>}
          </section>
          {run?.error ? <div className="synthesis-message synthesis-message--error">{run.error}</div> : null}
          {run && recoverableStatuses.has(run.status) ? <div className="synthesis-recovery"><span>Start a new run from this frozen snapshot. The existing run and its history stay available.</span><button type="button" disabled={Boolean(busy)} onClick={() => runAction("resume")}>{busy === "resume" ? "Restarting…" : "Restart from snapshot"}</button></div> : null}
          </SynthesisOutput>
        </main>
        {side !== "closed" ? <div className="synthesis-side" ref={sideColumn} data-resizing={sideSplit.resizing || undefined}
          style={shownPanels.length > 1 ? { gridTemplateRows: `minmax(140px, ${sideSplit.value}fr) 9px minmax(140px, ${100 - sideSplit.value}fr)` } : undefined}>
          <div {...sideWidth.handle} className="synthesis-side__resize" aria-label="Resize the side panels" title="Drag to resize · Double-click to reset" />
          {shownPanels.map((panel, index) => <Fragment key={panel}>
            {index ? <div {...sideSplit.handle} className="synthesis-split synthesis-split--row" aria-label="Resize the side panels' heights" title="Drag to resize · Double-click to reset" /> : null}
            {panel === "modules" ? <SynthesisModules modules={visibleModules} hidden={removedModules} moduleId={moduleId} runs={moduleRuns} runId={runId} busy={Boolean(busy)} loading={loading}
              canDelete={!remote} focus={focusPanel === "modules"} newModule={newModuleTrigger} onSelect={setModuleId} onHide={hideModule} onRestore={restoreModule} onCreate={() => setCreatingModule(true)}
              onSelectRun={item => { setRunId(item.id); setRun(item); }} onDeleteRun={deleteRun} onClearRuns={clearRuns} onClose={() => closePanel("modules")} />
              : <SynthesisDiagnostics module={module} run={run} busy={Boolean(busy)} focus={focusPanel === "diagnostics"} onReveal={showLine} onOpenSource={remote ? undefined : open} onClose={() => closePanel("diagnostics")} />}
          </Fragment>)}
        </div> : null}
      </div>}
    <footer className="synthesis-workspace-footer"><label htmlFor="synthesis-project">Workspace</label><select id="synthesis-project" value={projectId} disabled={Boolean(busy)} onChange={event => setProjectId(event.target.value)} aria-label="Synthesis workspace project"><option value="" disabled>Select project</option>{availableProjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><span title={project?.rootPath}>{project?.rootPath ?? "Choose a project to start"}</span>{project && remote && cloud !== undefined ? <span className="synthesis-cloud-status" title={`Set on ${remote.hostName}: sudo local-cognitive-server cloud-models ${cloud ? "deny" : "allow"} ${project.id}`}>Cloud models: {cloud ? "on" : "off"}</span> : null}{project && !remote && cloud !== undefined ? <label className="synthesis-cloud-toggle" title="Flows with a cloud provider send the contract, frozen files, visible tests and candidate files to it. Hidden tests stay here."><input type="checkbox" role="switch" className="synthesis-switch" checked={cloud} disabled={Boolean(busy)} onChange={event => toggleCloud(event.target.checked)} />Cloud models</label> : null}{project && remote && webTargets !== undefined ? <span className="synthesis-cloud-status" title={`Set on ${remote.hostName}: sudo local-cognitive-server web-targets ${webTargets.length ? `allow ${project.id} ${webTargets.join(" ")}` : `allow ${project.id} <url>`}`}>Web targets: {webTargets.length}</span> : null}{project && !remote && webTargets !== undefined ? <button type="button" className="synthesis-web-targets" disabled={Boolean(busy)} title="Web origins this project's agents may reach with the http right" onClick={() => setEditingWebTargets(true)}>Web targets: {webTargets.length}</button> : null}{onCreateProject ? <button type="button" disabled={Boolean(busy)} onClick={onCreateProject}>+ Project</button> : null}</footer>
    {creatingModule && project && active ? <NewModuleDialog key={projectId} project={project} modules={modules} onClose={closeNewModule} onCreated={moduleCreated} request={request} /> : null}
    {editingWebTargets && project && !remote && webTargets !== undefined ? <WebTargetsDialog key={projectId} project={project} targets={webTargets} onClose={() => setEditingWebTargets(false)} onSaved={webTargetsSaved} request={request} /> : null}
  </div>;
}
