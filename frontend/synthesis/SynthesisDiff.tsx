import { memo, useMemo, useRef } from "react";
import { codeLanguage, highlightCode } from "../markdown/highlight.js";
import { usePaneSplit } from "./usePaneSplit";

export const languageLabels: Record<string, string> = { javascript: "JavaScript", typescript: "TypeScript", xml: "HTML / XML", json: "JSON", css: "CSS", python: "Python", bash: "Shell", sql: "SQL", yaml: "YAML", markdown: "Markdown" };

export const Code = memo(function Code({ source, path, version }: { source: string; path: string; version?: string }) {
  const language = codeLanguage(path);
  const html = useMemo(() => highlightCode(source, language), [source, language]);
  return <section className="synthesis-diff__code" aria-label={`${version ? `${version}: ` : ""}${path}`}>
    <header><span>{languageLabels[language] ?? "Text"}</span>{version ? <span>{version}</span> : null}</header>
    <pre tabIndex={0}><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
  </section>;
});

/** A modified file: before and after side by side, the split kept between files and sessions. */
export function DiffColumns({ path, before, after }: { path: string; before: string; after: string }) {
  const columns = useRef<HTMLDivElement>(null);
  const split = usePaneSplit("lcai.synthesis.diffSplit.v1", 50, "x", columns);
  return <div className="synthesis-diff__columns" ref={columns} data-resizing={split.resizing || undefined}
    style={{ gridTemplateColumns: `minmax(0, ${split.value}fr) 8px minmax(0, ${100 - split.value}fr)` }}>
    <Code path={path} source={before} version="Before" />
    <div {...split.handle} className="synthesis-diff__resize" aria-label={`Resize code columns for ${path}`} title="Drag to resize · Double-click to reset" />
    <Code path={path} source={after} version="After" />
  </div>;
}
