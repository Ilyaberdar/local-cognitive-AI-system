import { useEffect, useRef, useState } from "react";
import { encode, errorMessage, isAbort, synthesisRequest } from "./api";
import { SynthesisIcon } from "./SynthesisIcon";
import type { DraftModels, SynthesisDraft, SynthesisModule, SynthesisProject } from "./types";

export interface NewModuleInput { name: string; template: "empty" | "calculator" | "rate-limiter" | "repository-review"; directory: string }

const LANGUAGES = [["TypeScript", "TypeScript"], ["JavaScript", "JavaScript"], ["Python", "Python"], ["Cpp", "C++"]] as const;
/** A model in the list: its provider and id, split at the first bar (provider ids have none). */
const modelKey = (providerId: string, id: string) => `${providerId}|${id}`;
const FLOW_NOTE = "The module's flow runs on the same model; change it in the flow if you like.";

/** What to know about the chosen drafting model: where a cloud one sends the description, and what is stronger than
 * a local one, since small models write tests with wrong expected values more often. */
function modelHint(models: DraftModels, chosen: { providerId: string; id: string } | undefined, isRecommended: boolean): string {
  const provider = chosen && chosen.providerId !== "llamacpp" ? models.cloud.find(item => item.providerId === chosen.providerId) : undefined;
  if (provider) return `Your description goes to ${provider.providerName}. ${FLOW_NOTE}`;
  const offered = models.cloud.find(item => item.models.length);
  if (offered && !models.cloudAllowed) return `Small models get expected values in tests wrong more often: read each one. For more reliable tests, turn Cloud models on for this project and draft with ${offered.providerName}. ${FLOW_NOTE}`;
  if (!isRecommended && models.recommended) {
    const best = models.recommended.providerId === "llamacpp" ? models.local.find(item => item.id === models.recommended!.id)?.displayName
      : `${models.recommended.id} (${models.cloud.find(item => item.providerId === models.recommended!.providerId)?.providerName ?? models.recommended.providerId})`;
    return `${best ?? models.recommended.id} is recommended: a larger model gets expected values in tests wrong less often. ${FLOW_NOTE}`;
  }
  return `The largest model here. Small models get expected values in tests wrong more often: read each one before saving. ${FLOW_NOTE}`;
}
const splitKey = (key: string) => ({ providerId: key.slice(0, key.indexOf("|")), id: key.slice(key.indexOf("|") + 1) });

export function NewModuleDialog({ project, modules, onCreated, onDrafted, canDescribe = false, onClose, request = synthesisRequest }: {
  project: SynthesisProject; modules: SynthesisModule[];
  onCreated: (module: SynthesisModule) => void; onClose: () => void;
  /** Drafting with a model is this computer's: a server's screen starts from templates only. */
  canDescribe?: boolean; onDrafted?: (draft: SynthesisDraft) => void;
  /** This computer's API, or the server's operations. */
  request?: <T>(path: string, options?: RequestInit) => Promise<T>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<NewModuleInput["template"]>("empty");
  const [directory, setDirectory] = useState("Synthesis");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [location, setLocation] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [folderError, setFolderError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"template" | "describe">("template");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState<SynthesisDraft["language"]>("TypeScript");
  const [output, setOutput] = useState("");
  const [models, setModels] = useState<DraftModels | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [model, setModel] = useState("");
  const cleanName = name.trim();
  const describing = mode === "describe";
  const cleanDescription = description.trim();
  const chosen = model ? splitKey(model) : undefined;
  const recommended = models?.recommended ? modelKey(models.recommended.providerId, models.recommended.id) : "";
  const tag = (key: string) => key === recommended ? " · recommended" : "";
  const outputError = output.trim() && (output.trim().split("/").some(part => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part)) || output.trim().toLowerCase().split("/").includes("synthesis"))
    ? "Use a project-relative folder outside Synthesis, without spaces, hidden names or .. segments." : "";
  const parent = directory.trim() === "." ? "" : directory.trim();
  const destination = [parent, cleanName || "ModuleName"].filter(Boolean).join("/");
  const specPath = `${destination}/${cleanName || "ModuleName"}.lcspec`;
  const conflict = modules.find(item => item.specPath?.toLowerCase() === specPath.toLowerCase());
  const nameError = cleanName && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(cleanName)
    ? "Start with a letter. Use letters, numbers or underscores, up to 64 characters." : "";
  const pathError = parent && (parent.length > 170 || parent.split("/").some(part => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part)))
    ? "Use a project-relative folder without spaces, hidden names or .. segments." : "";

  useEffect(() => {
    alive.current = true;
    const element = dialog.current;
    if (element?.showModal) element.showModal(); else element?.setAttribute("open", "");
    nameInput.current?.focus();
    return () => { alive.current = false; if (element?.close) element.close(); };
  }, []);
  useEffect(() => {
    if (!browsing) return;
    const controller = new AbortController();
    setLoading(true); setFolderError(""); setFolders([]);
    request<{directory: string; folders: string[]}>(`/projects/${encode(project.id)}/folders?directory=${encode(location)}`, {signal: controller.signal})
      .then(result => { if (!controller.signal.aborted) setFolders(result.folders); })
      .catch(reason => { if (!controller.signal.aborted && !isAbort(reason)) setFolderError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [browsing, location, project.id]);

  // The models are read when drafting is chosen, with the recommended one (a cloud provider's default where the
  // project allows cloud models, else the largest installed model) chosen.
  useEffect(() => {
    if (!describing || models) return;
    const controller = new AbortController();
    setModelsError("");
    request<DraftModels>(`/projects/${encode(project.id)}/draft-models`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        setModels(result);
        const first = result.recommended ? modelKey(result.recommended.providerId, result.recommended.id) : result.local[0] ? modelKey("llamacpp", result.local[0].id)
          : result.cloudAllowed ? result.cloud.flatMap(provider => provider.models.map(id => modelKey(provider.providerId, id)))[0] : undefined;
        setModel(current => current || first || "");
      })
      .catch(reason => { if (!controller.signal.aborted && !isAbort(reason)) setModelsError(errorMessage(reason)); });
    return () => controller.abort();
  }, [describing, models, project.id]);

  const draft = async () => {
    if (pending.current || !cleanName || nameError || pathError || outputError || conflict || cleanDescription.length < 20 || !chosen) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const started = await request<SynthesisDraft>(`/projects/${encode(project.id)}/drafts`, {
        method: "POST", body: JSON.stringify({ name: cleanName, directory: parent, language, description: cleanDescription, ...(output.trim() ? { output: output.trim() } : {}), model: chosen })
      });
      if (alive.current) onDrafted?.(started);
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };

  const create = async () => {
    if (describing) return draft();
    if (pending.current || !cleanName || nameError || pathError || conflict) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const created = await request<SynthesisModule>(`/projects/${encode(project.id)}/modules`, {
        method: "POST", body: JSON.stringify({name: cleanName, template, directory: parent} satisfies NewModuleInput)
      });
      if (alive.current) onCreated(created);
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };

  return <dialog ref={dialog} className="synthesis-create-dialog" aria-labelledby="synthesis-create-title" aria-describedby="synthesis-create-description"
    onCancel={event => { event.preventDefault(); if (!pending.current) onClose(); }}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!pending.current) onClose(); }
      if (event.key === "Tab") {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <header className="synthesis-create-header"><div><h2 id="synthesis-create-title">New module</h2><p id="synthesis-create-description">{describing ? `A model drafts the contract and its tests for ${project.name}; you read them, then save.` : `Create a contract and a flow in ${project.name}.`}</p></div>
      <button type="button" className="synthesis-icon-button" aria-label="Close new module" disabled={busy} onClick={onClose}><SynthesisIcon name="close" /></button>
    </header>
    <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <div className="synthesis-create-body">
        {canDescribe ? <div className="synthesis-create-mode" role="radiogroup" aria-label="How to start the module">
          <button type="button" role="radio" aria-checked={!describing} disabled={busy} onClick={() => { setMode("template"); setError(""); }}>From a template</button>
          <button type="button" role="radio" aria-checked={describing} disabled={busy} onClick={() => { setMode("describe"); setError(""); }}>Describe it to a model</button>
        </div> : null}
        <label className="synthesis-create-field" htmlFor="synthesis-module-name">Module name
          <input ref={nameInput} id="synthesis-module-name" value={name} onChange={event => { setName(event.target.value); setError(""); }} placeholder="e.g. AbilitySystem" autoComplete="off" spellCheck={false} disabled={busy} required maxLength={64} aria-invalid={Boolean(nameError || conflict)} aria-describedby="synthesis-name-hint" />
        </label>
        <p id="synthesis-name-hint" className={nameError || conflict ? "synthesis-form-error" : "synthesis-form-hint"}>
          {nameError || (conflict ? `A module already exists at ${destination}. Choose another name or folder.` : "The same name will be used for both DSL files.")}
        </p>
        {describing ? <>
          <label className="synthesis-create-field" htmlFor="synthesis-module-description">What should it do?
            <textarea id="synthesis-module-description" value={description} rows={6} maxLength={6000} disabled={busy} spellCheck onChange={event => { setDescription(event.target.value); setError(""); }}
              placeholder="e.g. A token-bucket rate limiter: capacity and refill per second, tryAcquire(tokens) says whether it took them, time only from an injected clock, RangeError on invalid settings." aria-describedby="synthesis-description-hint" />
          </label>
          <p id="synthesis-description-hint" className="synthesis-form-hint">Say the interface, what it does, every way it fails and what it may not use. The model writes a contract of numbered clauses and a test for each; you read both before anything runs.</p>
          <label className="synthesis-create-field" htmlFor="synthesis-module-language">Language
            <select id="synthesis-module-language" value={language} disabled={busy} onChange={event => setLanguage(event.target.value as SynthesisDraft["language"])}>
              {LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="synthesis-create-field synthesis-create-field--spaced" htmlFor="synthesis-module-output">Folder for the code
            <input id="synthesis-module-output" value={output} disabled={busy} spellCheck={false} onChange={event => { setOutput(event.target.value); setError(""); }} placeholder={`generated/${cleanName || "ModuleName"}`} aria-invalid={Boolean(outputError)} aria-describedby="synthesis-output-hint" />
          </label>
          <p id="synthesis-output-hint" className={outputError ? "synthesis-form-error" : "synthesis-form-hint"}>{outputError || "Where Apply writes the module's files, relative to the project."}</p>
          <label className="synthesis-create-field" htmlFor="synthesis-module-model">Model that writes the draft
            <select id="synthesis-module-model" value={model} disabled={busy || !models} onChange={event => setModel(event.target.value)}>
              {!models ? <option value="">Reading the models…</option> : null}
              {models?.local.length ? <optgroup label="On this computer">{models.local.map(item => <option key={item.id} value={modelKey("llamacpp", item.id)}>{item.displayName}{item.sizeBytes ? ` · ${(item.sizeBytes / 1e9).toFixed(1)} GB` : ""}{tag(modelKey("llamacpp", item.id))}</option>)}</optgroup> : null}
              {models?.cloud.filter(provider => provider.models.length).map(provider => <optgroup key={provider.providerId} label={models.cloudAllowed ? provider.providerName : `${provider.providerName} · Cloud models are off for this project`}>
                {provider.models.map(id => <option key={id} value={modelKey(provider.providerId, id)} disabled={!models.cloudAllowed}>{id}{tag(modelKey(provider.providerId, id))}</option>)}</optgroup>)}
            </select>
          </label>
          <p className={modelsError ? "synthesis-form-error" : "synthesis-form-hint"}>{modelsError || (!models ? "" : !models.local.length && !models.cloud.some(provider => provider.models.length) ? "No model to write with: install one in Models, or set a provider up in Settings."
            : modelHint(models, chosen, recommended === model))}</p>
        </> : <>
        <label className="synthesis-create-field" htmlFor="synthesis-module-template">Template
          <select id="synthesis-module-template" value={template} disabled={busy} onChange={event => setTemplate(event.target.value as NewModuleInput["template"])}>
            <option value="empty">Empty module</option><option value="calculator">Calculator example</option><option value="rate-limiter">Rate limiter (TypeScript, with tests)</option><option value="repository-review">Repository review (parallel agents)</option>
          </select>
        </label>
        <p className="synthesis-form-hint">{template === "empty" ? "A neutral starter. Define the contract, agents and trusted evaluators before running." : template === "rate-limiter" ? "A TypeScript module checked by its shape, its dependencies and your own tests, which the model reads but never writes. Needs Node.js 22.18 or newer." : template === "repository-review" ? "Four agents on one local model review src/ in parallel and leave notes; the report is accepted when every file and line it cites exists. Switch to a cloud provider in the flow for more agents." : "A working HTML/CSS/JavaScript example with built-in calculator checks. Prefers an installed 7B model."}</p>
        </>}
        <label className="synthesis-create-field" htmlFor="synthesis-module-directory">Folder inside project</label>
        <div className="synthesis-directory-control"><input id="synthesis-module-directory" value={directory} disabled={busy} onChange={event => { setDirectory(event.target.value); setError(""); }} placeholder="Synthesis" spellCheck={false} aria-invalid={Boolean(pathError)} aria-describedby="synthesis-directory-hint" />
          <button type="button" disabled={busy} onClick={() => { setLocation(""); setBrowsing(value => !value); }} aria-expanded={browsing}><SynthesisIcon name="folder" />Browse</button>
        </div>
        <p id="synthesis-directory-hint" className={pathError ? "synthesis-form-error" : "synthesis-form-hint"}>{pathError || "Choose an existing folder or type a new relative path. Use . for the project root."}</p>
        {browsing ? <section className="synthesis-folder-browser" aria-label="Choose module folder">
          <header><button type="button" disabled={!location || loading} onClick={() => setLocation(value => value.split("/").slice(0, -1).join("/"))}>Up</button><span title={project.rootPath}>{location || "Project root"}</span></header>
          <div className="synthesis-folder-list">{loading ? <p>Reading folders…</p> : folderError ? <p role="alert">{folderError}</p> : folders.length ? folders.map(folder => <button type="button" key={folder} onClick={() => setLocation([location, folder].filter(Boolean).join("/"))}><SynthesisIcon name="folder" />{folder}</button>) : <p>No subfolders. You can use this folder.</p>}</div>
          <footer><button type="button" disabled={loading || Boolean(folderError)} onClick={() => { setDirectory(location || "."); setBrowsing(false); setError(""); }}>Use this folder</button></footer>
        </section> : null}
        <div className="synthesis-file-preview" aria-label="Files to create"><span>{describing ? "Files the draft becomes when you save it" : "Files to create"}</span><small title={project.rootPath}>{project.rootPath}</small><code>{destination}/<wbr />{cleanName || "ModuleName"}.lcspec</code><code>{destination}/<wbr />{cleanName || "ModuleName"}.lcflow</code>{describing ? <code>{destination}/<wbr />tests/…</code> : null}</div>
        <p className="synthesis-form-hint">{describing ? "The draft stays in the app until you save it: nothing is written to the project before." : "Already have DSL files? Save matching .lcspec and .lcflow files in your project, then Refresh. No import or copying required."}</p>
        {error ? <p className="synthesis-form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="synthesis-create-footer"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="synthesis-primary" disabled={busy || !cleanName || Boolean(nameError || pathError || conflict) || (describing && (cleanDescription.length < 20 || !chosen || Boolean(outputError)))}>{describing ? busy ? "Starting…" : "Write a draft" : busy ? "Creating…" : "Create module"}</button></footer>
    </form>
  </dialog>;
}
