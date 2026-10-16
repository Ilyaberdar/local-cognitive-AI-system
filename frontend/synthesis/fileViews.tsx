import { memo, useEffect, useMemo, useRef, type MouseEvent, type ReactNode } from "react";
import { renderCodeLines, renderMarkdown } from "../markdown/index.js";
import { references, type Reference } from "../../src/synthesis/checks/references";
import { revealIn } from "./scroll";
import type { GroundedReference } from "./types";

/** A place a file cites: where it leads, and what Grounded found there ("unchecked" when it did not look). */
export type Cited = Pick<Reference, "path" | "start" | "end">;
export type CitedStatus = GroundedReference["status"] | "unchecked";
export interface Citations {
  status(reference: Cited): { status: CitedStatus; lines?: number };
  /** Whether a click can open it: a candidate file always, a project file only on the computer that owns the project. */
  opens(reference: Cited): boolean;
  open(reference: Cited): void;
}

const place = (reference: Cited) => `${reference.path}${reference.start !== undefined ? `:${reference.start}${reference.end !== undefined ? `-${reference.end}` : ""}` : ""}`;
const describe = (reference: Cited, found: { status: CitedStatus; lines?: number }) => found.status === "ok" ? `${place(reference)}: exists${found.lines ? ` (${found.lines} lines)` : ""}`
  : found.status === "missing" ? `${reference.path} does not exist in the project`
    : found.status === "range" ? `${reference.path} has ${found.lines ?? "fewer"} lines` : `${place(reference)}: not checked by Grounded`;

/** The whole file with line numbers, highlighted; `focus` lines are marked and scrolled to. */
export const SourceLines = memo(function SourceLines({ source, path, focus, label }: { source: string; path: string; focus?: { start?: number; end?: number }; label: string }) {
  const lines = useMemo(() => renderCodeLines(source, path), [source, path]);
  const box = useRef<HTMLDivElement>(null);
  const first = focus?.start, last = focus?.end ?? focus?.start;
  useEffect(() => {
    if (first === undefined) return;
    const row = box.current?.querySelector(`[data-line="${first}"]`) as HTMLElement | null;
    revealIn(row, "center");
  }, [first, last, source]);
  return <div className="synthesis-lines" ref={box} role="region" aria-label={label} tabIndex={0}>
    {lines.map((html, index) => {
      const line = index + 1;
      const marked = first !== undefined && line >= first && line <= (last ?? first);
      return <div key={index} className={`synthesis-lines__row${marked ? " is-target" : ""}`} data-line={line}>
        <span className="synthesis-lines__number" aria-hidden="true">{line}</span>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html || " " }} />
      </div>;
    })}
  </div>;
});

/** Markdown a model wrote, formatted (sanitized, no raw HTML, no images), with every path:line it
 * cites made a button that opens the place, marked by what Grounded found. Links leave the app only
 * for http(s); any other is inert. */
export function MarkdownView({ source, citations, label }: { source: string; citations: Citations; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(source), [source]);
  const citing = useRef(citations);
  citing.current = citations;
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    // Sanitized by DOMPurify in renderMarkdown, as chat answers are; the buttons below are made with the DOM, never from the text.
    root.innerHTML = html;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest("a, button") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
    for (const text of texts) {
      const found = references(text.data);
      if (!found.length) continue;
      // Where each line of the text starts: references() counts lines and columns within it.
      const offsets = [0];
      for (let index = text.data.indexOf("\n"); index >= 0; index = text.data.indexOf("\n", index + 1)) offsets.push(index + 1);
      const fragment = document.createDocumentFragment();
      let at = 0;
      for (const reference of found) {
        const start = offsets[reference.line - 1]! + reference.column;
        if (start < at) continue;
        fragment.append(text.data.slice(at, start));
        const result = citing.current.status(reference);
        const element = document.createElement(citing.current.opens(reference) ? "button" : "span");
        if (element instanceof HTMLButtonElement) element.type = "button";
        element.className = `synthesis-ref is-${result.status}`;
        element.dataset.path = reference.path;
        if (reference.start !== undefined) element.dataset.start = String(reference.start);
        if (reference.end !== undefined) element.dataset.end = String(reference.end);
        element.title = describe(reference, result);
        element.textContent = reference.raw;
        fragment.append(element);
        at = start + reference.raw.length;
      }
      fragment.append(text.data.slice(at));
      text.replaceWith(fragment);
    }
  }, [html, citations]);
  const click = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const button = target.closest?.("button.synthesis-ref") as HTMLButtonElement | null;
    if (button && box.current?.contains(button)) {
      event.preventDefault();
      const number = (value?: string) => value === undefined ? undefined : Number(value);
      citing.current.open({ path: button.dataset.path!, start: number(button.dataset.start), end: number(button.dataset.end) });
      return;
    }
    const link = target.closest?.("a") as HTMLAnchorElement | null;
    if (!link || !box.current?.contains(link)) return;
    // Only the web leaves the app (the window opens it outside); a relative or other link does nothing.
    let web = false;
    try { web = ["http:", "https:"].includes(new URL(link.getAttribute("href") ?? "", "about:blank").protocol); } catch { /* Not a URL. */ }
    if (!web) event.preventDefault();
  };
  return <div className="synthesis-markdown message-markdown" ref={box} role="region" aria-label={label} onClick={click} />;
}

const LIMIT = 500;
function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }): ReactNode {
  const key = name === undefined ? null : <span className="synthesis-json__key">{name}: </span>;
  if (value === null || typeof value !== "object") {
    const kind = value === null ? "null" : typeof value;
    return <li>{key}<span className={`synthesis-json__${kind}`}>{kind === "string" ? JSON.stringify(value) : String(value)}</span></li>;
  }
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value as Record<string, unknown>);
  const summary = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  return <li><details open={depth < 2}>
    <summary>{key}<span className="synthesis-json__count">{summary}</span></summary>
    <ul>{entries.slice(0, LIMIT).map(([child, item]) => <JsonNode key={child} name={child} value={item} depth={depth + 1} />)}
      {entries.length > LIMIT ? <li className="synthesis-json__more">… {entries.length - LIMIT} more</li> : null}</ul>
  </details></li>;
}

/** JSON as a tree that folds (two levels open); text that is not JSON is shown as it is, with why. */
export function JsonView({ source, path, label }: { source: string; path: string; label: string }) {
  const parsed = useMemo((): { value: unknown } | { error: string } => { try { return { value: JSON.parse(source) as unknown }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; } }, [source]);
  if ("error" in parsed) return <><p className="synthesis-view-note" role="status">Not valid JSON: {parsed.error}</p><SourceLines source={source} path={path} label={label} /></>;
  return <ul className="synthesis-json" role="tree" aria-label={label}><JsonNode value={parsed.value} depth={0} /></ul>;
}
