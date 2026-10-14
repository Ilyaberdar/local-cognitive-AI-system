import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { encode, errorMessage } from "./api";
import { DiffColumns } from "./SynthesisDiff";
import { JsonView, MarkdownView, SourceLines, type Cited, type Citations } from "./fileViews";
import type { CandidateDiff, GroundedReference, SynthesisRun } from "./types";

type ChangedFile = CandidateDiff["files"][number];
type Mode = "view" | "source" | "diff";
type Gates = NonNullable<SynthesisRun["evidence"]>["gates"];
const key = (reference: Cited) => `${reference.path}:${reference.start ?? ""}-${reference.end ?? ""}`;

const kind = (path: string) => /\.(?:md|markdown)$/i.test(path) ? "markdown" : /\.json$/i.test(path) ? "json" : "code";
const state = (file: ChangedFile) => file.before === null ? "Added" : file.after === null ? "Deleted" : "Modified";
/** What a file opens on: formatted when it is Markdown or JSON, else its changes, else its text. */
const modesOf = (file: ChangedFile): Mode[] => {
  const modified = state(file) === "Modified";
  return kind(file.path) !== "code" ? ["view", "source", ...(modified ? ["diff" as const] : [])] : [...(modified ? ["diff" as const] : []), "source"];
};
const modeLabels: Record<Mode, string> = { view: "View", source: "Source", diff: "Diff" };

/** The run's changes: the files on the left, the chosen one on the right as a diff, its source with
 * line numbers, or formatted (Markdown with its citations, JSON as a tree). A citation opens the place
 * it names: a candidate file here, a project file read-only on this computer only. */
export function SynthesisChanges({ diff, loading, gates, runId, request, remote }: {
  diff: CandidateDiff | null; loading: boolean; gates?: Gates; runId: string; remote: boolean;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
}) {
  const files = diff?.files ?? [];
  const root = diff?.root ?? "";
  const [selected, setSelected] = useState("");
  const [modes, setModes] = useState<Record<string, Mode>>({});
  const [focus, setFocus] = useState<{ start?: number; end?: number } | undefined>();
  const [project, setProject] = useState<{ path: string; start?: number; end?: number; content?: string; error?: string } | null>(null);
  useEffect(() => { setSelected(""); setModes({}); setFocus(undefined); setProject(null); }, [runId]);
  const file = files.find(item => item.path === selected) ?? files[0];
  const relative = (path: string) => root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;

  // What Grounded found for each place each checked file cites, by the file's path as Changes shows it.
  const checked = useMemo(() => {
    const byFile = new Map<string, Map<string, GroundedReference>>();
    for (const gate of gates ?? []) {
      if (!gate.grounded) continue;
      const places = byFile.get(gate.grounded.file) ?? new Map<string, GroundedReference>();
      for (const reference of gate.grounded.references) places.set(key(reference), reference);
      byFile.set(gate.grounded.file, places);
    }
    return byFile;
  }, [gates]);
  const candidateOf = (path: string) => files.find(item => item.path === path || (root && item.path === `${root}/${path}`));
  const showLine = (start?: number, end?: number) => setFocus(start === undefined ? undefined : { start, ...(end !== undefined ? { end } : {}) });
  const citations: Citations = useMemo(() => ({
    status: reference => {
      const found = file ? checked.get(relative(file.path))?.get(key(reference)) : undefined;
      return found ? { status: found.status, ...(found.lines !== undefined ? { lines: found.lines } : {}) } : { status: "unchecked" };
    },
    opens: reference => Boolean(candidateOf(reference.path)) || !remote,
    open: reference => {
      const target = candidateOf(reference.path);
      if (target) {
        setProject(null); setSelected(target.path);
        setModes(current => ({ ...current, [target.path]: "source" }));
        showLine(reference.start, reference.end);
        return;
      }
      if (remote) return;
      setProject({ path: reference.path, start: reference.start, end: reference.end });
      request<{ path: string; content: string }>(`/runs/${encode(runId)}/project-file?path=${encodeURIComponent(reference.path)}`)
        .then(result => setProject(current => current?.path === reference.path ? { ...current, content: result.content } : current),
          reason => setProject(current => current?.path === reference.path ? { ...current, error: errorMessage(reason) } : current));
    }
  }), [file?.path, checked, files, root, remote, runId]);

  if (loading) return <div className="synthesis-empty">Loading candidate changes…</div>;
  if (!files.length || !file) return <div className="synthesis-empty">No candidate changes to display yet.</div>;
  const available = modesOf(file);
  const mode = modes[file.path] && available.includes(modes[file.path]!) ? modes[file.path]! : available[0]!;
  const content = file.after ?? file.before ?? "";
  const choose = (path: string) => { setProject(null); setFocus(undefined); setSelected(path); };
  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const index = files.indexOf(file) + (event.key === "ArrowDown" ? 1 : -1);
    const next = files[Math.max(0, Math.min(files.length - 1, index))]!;
    choose(next.path);
    (event.currentTarget.querySelector(`[data-path="${CSS.escape(next.path)}"]`) as HTMLElement | null)?.focus();
  };
  const broken = (path: string) => [...(checked.get(relative(path))?.values() ?? [])].filter(reference => reference.status !== "ok").length;

  return <div className="synthesis-changes">
    <ul className="synthesis-changes__files" role="listbox" aria-label="Changed files" onKeyDown={move}>
      {files.map(item => {
        const failing = broken(item.path);
        return <li key={item.path}><button type="button" role="option" data-path={item.path} aria-selected={item === file && !project} tabIndex={item === file ? 0 : -1} onClick={() => choose(item.path)}>
          <span className="synthesis-changes__name" title={item.path}>{item.path}</span>
          <span className={`synthesis-changes__state is-${state(item).toLowerCase()}`}>{state(item)}</span>
          {failing ? <span className="synthesis-changes__broken" title={`${failing} cited places do not hold (Grounded)`}>{failing} broken</span> : null}
        </button></li>;
      })}
    </ul>
    <section className="synthesis-changes__file" aria-label={project ? `Project file ${project.path}` : file.path}>
      {project ? <>
        <header className="synthesis-changes__header">
          <button type="button" onClick={() => setProject(null)}>← {file.path}</button>
          <span className="synthesis-changes__path">{project.path}</span>
          <span className="synthesis-changes__note">Project file · read-only, as it is now</span>
        </header>
        <div className="synthesis-changes__body">{project.error ? <div className="synthesis-empty" role="alert">{project.error}</div>
          : project.content === undefined ? <div className="synthesis-empty">Loading {project.path}…</div>
            : <SourceLines source={project.content} path={project.path} focus={{ start: project.start, end: project.end }} label={`${project.path}, read-only`} />}</div>
      </> : <>
        <header className="synthesis-changes__header">
          <span className="synthesis-changes__path">{file.path}</span>
          <span className={`synthesis-changes__state is-${state(file).toLowerCase()}`}>{state(file)}</span>
          {available.length > 1 ? <div role="group" aria-label="Show the file as">{available.map(item =>
            <button type="button" key={item} aria-pressed={mode === item} onClick={() => { setModes(current => ({ ...current, [file.path]: item })); if (item !== "source") setFocus(undefined); }}>{modeLabels[item]}</button>)}</div> : null}
        </header>
        <div className="synthesis-changes__body" key={`${file.path}:${mode}`}>
          {mode === "diff" ? <DiffColumns path={file.path} before={file.before ?? ""} after={file.after ?? ""} />
            : mode === "view" && kind(file.path) === "markdown" ? <MarkdownView source={content} citations={citations} label={`${file.path}, formatted`} />
              : mode === "view" ? <JsonView source={content} path={file.path} label={`${file.path}, as a tree`} />
                : <SourceLines source={content} path={file.path} focus={focus} label={`${file.path}${state(file) === "Deleted" ? ", deleted" : ""}`} />}
        </div>
      </>}
    </section>
  </div>;
}
