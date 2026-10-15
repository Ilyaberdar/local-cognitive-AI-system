import { memo, useMemo, useRef, useState } from "react";
import { codeLanguage, highlightCode } from "../markdown/highlight.js";
import { renderCodeLines } from "../markdown/index.js";
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

type Op = { type: "same"; a: number; b: number } | { type: "del"; a: number } | { type: "add"; b: number };
/** The fewest lines removed and added that turn `a` into `b`: the common start and end are taken
 * first, the rest by longest common subsequence (when it is too large for that, all of it changed). */
export function diffLines(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const ops: Op[] = [];
  for (let index = 0; index < start; index++) ops.push({ type: "same", a: index, b: index });
  const n = a.length - start - end, m = b.length - start - end;
  if (n * m <= 2_000_000) {
    // table[i][j]: the longest common run of a[start+i..] and b[start+j..].
    const width = m + 1, table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) { ops.push({ type: "same", a: start + i, b: start + j }); i++; j++; }
      else if (j < m && (i === n || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) { ops.push({ type: "add", b: start + j }); j++; }
      else { ops.push({ type: "del", a: start + i }); i++; }
    }
  } else {
    for (let i = 0; i < n; i++) ops.push({ type: "del", a: start + i });
    for (let j = 0; j < m; j++) ops.push({ type: "add", b: start + j });
  }
  for (let index = 0; index < end; index++) ops.push({ type: "same", a: a.length - end + index, b: b.length - end + index });
  return ops;
}

/** Wraps text positions [from, to) of a highlighted line in a mark, around each text piece so the
 * line's own spans stay whole. Entities count as one character. */
function markText(html: string, from: number, to: number, className: string): string {
  if (from >= to) return html;
  let at = 0, out = "";
  for (const piece of html.split(/(<[^>]+>)/)) {
    if (!piece) continue;
    if (piece.startsWith("<")) { out += piece; continue; }
    const chars = piece.match(/&[#a-zA-Z0-9]+;|[^&]|&/g) ?? [];
    let inside = "", plain = "";
    const flush = () => { if (inside) { out += `<span class="${className}">${inside}</span>`; inside = ""; } };
    for (const char of chars) {
      if (at >= from && at < to) { out += plain; plain = ""; inside += char; }
      else { flush(); plain += char; }
      at++;
    }
    flush(); out += plain;
  }
  return out;
}

interface Cell { n: number; html: string; type: "same" | "del" | "add" }
type Row = { kind: "line"; left?: Cell; right?: Cell } | { kind: "fold"; id: number; count: number };
const CONTEXT = 3;

/** The rows of a side-by-side diff: unchanged lines on both sides, a removed line beside the line
 * that replaced it, and long unchanged stretches folded. */
function diffRows(before: string, after: string, path: string, expanded: Set<number>) {
  const a = before.replace(/\r?\n$/, "").split(/\r?\n/), b = after.replace(/\r?\n$/, "").split(/\r?\n/);
  const left = renderCodeLines(before, path), right = renderCodeLines(after, path);
  const ops = diffLines(a, b);
  const lines: Array<{ left?: Cell; right?: Cell }> = [];
  let removed = 0, added = 0;
  for (let index = 0; index < ops.length;) {
    const op = ops[index]!;
    if (op.type === "same") { lines.push({ left: { n: op.a + 1, html: left[op.a] ?? "", type: "same" }, right: { n: op.b + 1, html: right[op.b] ?? "", type: "same" } }); index++; continue; }
    const dels: number[] = [], adds: number[] = [];
    while (index < ops.length && ops[index]!.type !== "same") { const next = ops[index]!; if (next.type === "del") dels.push(next.a); else if (next.type === "add") adds.push(next.b); index++; }
    removed += dels.length; added += adds.length;
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const da = dels[k], db = adds[k];
      let lh = da !== undefined ? left[da] ?? "" : "", rh = db !== undefined ? right[db] ?? "" : "";
      // A line beside the one that replaced it: what changed within it is marked.
      if (da !== undefined && db !== undefined) {
        const x = a[da]!, y = b[db]!;
        let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
        let s = 0; while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
        if (p + s > 0) { lh = markText(lh, p, x.length - s, "synthesis-diff2__del"); rh = markText(rh, p, y.length - s, "synthesis-diff2__add"); }
      }
      lines.push({ ...(da !== undefined ? { left: { n: da + 1, html: lh, type: "del" as const } } : {}), ...(db !== undefined ? { right: { n: db + 1, html: rh, type: "add" as const } } : {}) });
    }
  }
  const changed = lines.map(line => line.left?.type !== "same" || line.right?.type !== "same");
  const near = lines.map((_line, index) => changed.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some(Boolean));
  const rows: Row[] = [];
  for (let index = 0; index < lines.length;) {
    if (near[index]) { rows.push({ kind: "line", ...lines[index]! }); index++; continue; }
    let stop = index; while (stop < lines.length && !near[stop]) stop++;
    // A fold of one or two lines saves nothing.
    if (stop - index > 2 && !expanded.has(index)) rows.push({ kind: "fold", id: index, count: stop - index });
    else for (let k = index; k < stop; k++) rows.push({ kind: "line", ...lines[k]! });
    index = stop;
  }
  return { rows, removed, added };
}

/** A modified file side by side, as a diff reads: aligned lines, removed ones red on the left,
 * added ones green on the right, what changed within a line marked, unchanged stretches folded.
 * Long lines wrap; the split between the sides is kept between files and sessions. */
export function DiffColumns({ path, before, after }: { path: string; before: string; after: string }) {
  const columns = useRef<HTMLDivElement>(null);
  const split = usePaneSplit("lcai.synthesis.diffSplit.v1", 50, "x", columns);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const { rows, removed, added } = useMemo(() => diffRows(before, after, path, expanded), [before, after, path, expanded]);
  const cell = (side: Cell | undefined, which: "left" | "right") => side
    ? [<span key={`${which}-n`} className={`synthesis-diff2__num is-${side.type}`} aria-hidden="true">{side.n}</span>,
      <code key={`${which}-c`} className={`synthesis-diff2__code hljs is-${side.type}`} dangerouslySetInnerHTML={{ __html: side.html || " " }} />]
    : [<span key={`${which}-n`} className="synthesis-diff2__num is-empty" />, <span key={`${which}-c`} className="synthesis-diff2__code is-empty" />];
  return <div className="synthesis-diff2" ref={columns} data-resizing={split.resizing || undefined} aria-label={`Changes to ${path}`}
    style={{ gridTemplateColumns: `44px minmax(0, ${split.value}fr) 8px 44px minmax(0, ${100 - split.value}fr)` }}>
    <div className="synthesis-diff2__head">
      <span className="synthesis-diff2__title">Before</span>
      <div {...split.handle} className="synthesis-diff__resize" aria-label={`Resize code columns for ${path}`} title="Drag to resize · Double-click to reset" />
      <span className="synthesis-diff2__title">After<small><span className="is-add">+{added}</span> <span className="is-del">−{removed}</span></small></span>
    </div>
    {rows.map((row, index) => row.kind === "fold"
      ? <button type="button" key={`fold-${row.id}`} className="synthesis-diff2__fold" onClick={() => setExpanded(current => new Set(current).add(row.id))}>⋯ {row.count} unchanged lines</button>
      : <div key={index} className="synthesis-diff2__row">{cell(row.left, "left")}<span className="synthesis-diff2__gutter" />{cell(row.right, "right")}</div>)}
  </div>;
}
