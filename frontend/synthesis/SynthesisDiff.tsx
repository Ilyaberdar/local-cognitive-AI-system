import { memo, useMemo, useRef } from "react";
import { codeLanguage, highlightCode } from "../markdown/highlight.js";
import { usePaneSplit } from "./usePaneSplit";
import type { CandidateDiff } from "./types";

const labels: Record<string, string> = { javascript: "JavaScript", typescript: "TypeScript", xml: "HTML / XML", json: "JSON", css: "CSS", python: "Python", bash: "Shell", sql: "SQL", yaml: "YAML", markdown: "Markdown" };

const Code = memo(function Code({ source, path, version }: { source: string; path: string; version?: string }) {
  const language = codeLanguage(path);
  const html = useMemo(() => highlightCode(source, language), [source, language]);
  return <section className="synthesis-diff__code" aria-label={`${version ? `${version}: ` : ""}${path}`}>
    <header><span>{labels[language] ?? "Text"}</span>{version ? <span>{version}</span> : null}</header>
    <pre tabIndex={0}><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
  </section>;
});

function FileChange({ file, open }: { file: CandidateDiff["files"][number]; open: boolean }) {
  const columns = useRef<HTMLDivElement>(null);
  const split = usePaneSplit("lcai.synthesis.diffSplit.v1", 50, "x", columns);
  // null means added; an existing empty file is still a modification.
  const added = file.before === null;
  return <details open={open}>
    <summary>{file.path}<span>{added ? "Added" : "Modified"}</span></summary>
    {added ? <Code path={file.path} source={file.after} /> :
      <div className="synthesis-diff__columns" ref={columns} data-resizing={split.resizing || undefined}
        style={{ gridTemplateColumns: `minmax(0, ${split.value}fr) 8px minmax(0, ${100 - split.value}fr)` }}>
        <Code path={file.path} source={file.before ?? ""} version="Before" />
        <div {...split.handle} className="synthesis-diff__resize" aria-label={`Resize code columns for ${file.path}`} title="Drag to resize · Double-click to reset" />
        <Code path={file.path} source={file.after} version="After" />
      </div>}
  </details>;
}

export function SynthesisDiff({ diff, loading }: { diff: CandidateDiff | null; loading: boolean }) {
  if (loading) return <div className="synthesis-empty">Loading candidate changes…</div>;
  if (!diff?.files.length) return <div className="synthesis-empty">No candidate changes to display yet.</div>;
  return <div className="synthesis-diff">{diff.files.map(file => <FileChange key={file.path} file={file} open={diff.files.length === 1} />)}</div>;
}
