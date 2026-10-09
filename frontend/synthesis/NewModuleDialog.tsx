import { useEffect, useRef, useState } from "react";
import { encode, errorMessage, isAbort, synthesisRequest } from "./api";
import { SynthesisIcon } from "./SynthesisIcon";
import type { SynthesisModule, SynthesisProject } from "./types";

export interface NewModuleInput { name: string; template: "empty" | "calculator"; directory: string }

export function NewModuleDialog({ project, modules, onCreated, onClose, request = synthesisRequest }: {
  project: SynthesisProject; modules: SynthesisModule[];
  onCreated: (module: SynthesisModule) => void; onClose: () => void;
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
  const cleanName = name.trim();
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

  const create = async () => {
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
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <header className="synthesis-create-header"><div><h2 id="synthesis-create-title">New module</h2><p id="synthesis-create-description">Create a contract and a flow in {project.name}.</p></div>
      <button type="button" className="synthesis-icon-button" aria-label="Close new module" disabled={busy} onClick={onClose}><SynthesisIcon name="close" /></button>
    </header>
    <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <div className="synthesis-create-body">
        <label className="synthesis-create-field" htmlFor="synthesis-module-name">Module name
          <input ref={nameInput} id="synthesis-module-name" value={name} onChange={event => { setName(event.target.value); setError(""); }} placeholder="e.g. AbilitySystem" autoComplete="off" spellCheck={false} disabled={busy} required maxLength={64} aria-invalid={Boolean(nameError || conflict)} aria-describedby="synthesis-name-hint" />
        </label>
        <p id="synthesis-name-hint" className={nameError || conflict ? "synthesis-form-error" : "synthesis-form-hint"}>
          {nameError || (conflict ? `A module already exists at ${destination}. Choose another name or folder.` : "The same name will be used for both DSL files.")}
        </p>
        <label className="synthesis-create-field" htmlFor="synthesis-module-template">Template
          <select id="synthesis-module-template" value={template} disabled={busy} onChange={event => setTemplate(event.target.value as NewModuleInput["template"])}>
            <option value="empty">Empty module</option><option value="calculator">Calculator example</option>
          </select>
        </label>
        <p className="synthesis-form-hint">{template === "empty" ? "A neutral starter. Define the contract, agents and trusted evaluators before running." : "A working HTML/CSS/JavaScript example with built-in calculator checks. Prefers an installed 7B model."}</p>
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
        <div className="synthesis-file-preview" aria-label="Files to create"><span>Files to create</span><small title={project.rootPath}>{project.rootPath}</small><code>{destination}/<wbr />{cleanName || "ModuleName"}.lcspec</code><code>{destination}/<wbr />{cleanName || "ModuleName"}.lcflow</code></div>
        <p className="synthesis-form-hint">Already have DSL files? Save matching .lcspec and .lcflow files in your project, then Refresh. No import or copying required.</p>
        {error ? <p className="synthesis-form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="synthesis-create-footer"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="synthesis-primary" disabled={busy || !cleanName || Boolean(nameError || pathError || conflict)}>{busy ? "Creating…" : "Create module"}</button></footer>
    </form>
  </dialog>;
}
