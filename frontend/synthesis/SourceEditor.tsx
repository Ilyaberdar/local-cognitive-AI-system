import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";

const KEYWORDS = "module|version|interface|behavior|invariants|constraints|evaluate|hard|soft|implement|using|limit|while|if|else|await|return|continue|true|false|none";
const TOKENS = new RegExp(`("(?:[^"\\\\]|\\\\.)*"|\\/\\/.*$|\\b(?:${KEYWORDS})\\b)`, "g");
const KEYWORD = new RegExp(`^(?:${KEYWORDS})$`);

/** The DSL's line ends as an editor holds them. */
export const normalizeLines = (text: string) => text.replace(/\r\n?/g, "\n");

function Highlighted({ line }: { line: string }) {
  return <>{line.split(TOKENS).map((part, index) =>
    <span key={index} className={part.startsWith("//") ? "synthesis-source__comment" : part.startsWith('"') ? "synthesis-source__string" : KEYWORD.test(part) ? "synthesis-source__keyword" : undefined}>{part}</span>)}</>;
}

export interface SourceProblem { line: number; column?: number; message: string; severity: "error" | "warning" }

function Lines({ source, problems = [] }: { source: string; problems?: SourceProblem[] }) {
  const worst = new Map<number, SourceProblem["severity"]>();
  for (const problem of problems) if (worst.get(problem.line) !== "error") worst.set(problem.line, problem.severity);
  return <code>{source.split("\n").map((line, index) => <span className={`synthesis-source__line${worst.has(index + 1) ? ` is-${worst.get(index + 1)}` : ""}`} key={index}>
    <span className="synthesis-source__number" aria-hidden="true">{index + 1}</span>
    <span>{line ? <Highlighted line={line} /> : " "}</span>
  </span>)}</code>;
}

/** A read-only source with line numbers: a run's frozen snapshot, or a server's file. */
export function SourcePreview({ source, name }: { source: string; name: string }) {
  return <pre className="synthesis-source" aria-label={name}><Lines source={normalizeLines(source)} /></pre>;
}

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];
/** The file's own indent step: the smallest one its lines use, 4 spaces when it has none. */
function indentUnit(source: string) {
  const widths = source.split("\n").map(line => indentOf(line)).filter(indent => indent && !indent.includes("\t")).map(indent => indent.length);
  return " ".repeat(Math.max(2, Math.min(8, widths.length ? Math.min(...widths) : 4)));
}

/** The contract or flow as text to edit, highlighted as it is typed. The text area lies over the
 * highlighted lines and scrolls them with it, so the caret, selection, undo and the system's text
 * services stay the browser's own. Tab indents (Escape, then Tab, moves on); ⌘S or Ctrl+S saves. */
export function SourceEditor({ value, label, problems, reveal, onChange, onSave }: {
  value: string; label: string; problems: SourceProblem[];
  /** A line to bring the caret to; `key` asks again for the same line. */
  reveal?: { line: number; key: number };
  onChange: (value: string) => void; onSave: () => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLPreElement>(null);
  const sync = () => { if (area.current && layer.current) layer.current.style.transform = `translate(${-area.current.scrollLeft}px, ${-area.current.scrollTop}px)`; };
  useLayoutEffect(sync, [value]);
  useEffect(() => {
    const element = area.current;
    if (!reveal || !element) return;
    const lines = element.value.split("\n");
    const line = Math.max(1, Math.min(lines.length, reveal.line));
    const offset = lines.slice(0, line - 1).reduce((total, text) => total + text.length + 1, 0);
    element.focus();
    element.setSelectionRange(offset, offset);
    const height = parseFloat(getComputedStyle(element).lineHeight) || 21;
    element.scrollTop = Math.max(0, (line - 1) * height - element.clientHeight / 3);
    sync();
  }, [reveal?.key]);

  /** Replaces the selection as typing would, so undo takes it back. */
  const insert = (text: string) => {
    const element = area.current!;
    if (document.execCommand?.("insertText", false, text)) return;
    const { selectionStart: start, selectionEnd: end } = element;
    onChange(element.value.slice(0, start) + text + element.value.slice(end));
    requestAnimationFrame(() => element.setSelectionRange(start + text.length, start + text.length));
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") { event.preventDefault(); onSave(); return; }
    if (event.key === "Escape") { event.preventDefault(); element.blur(); return; }
    const { selectionStart: start, selectionEnd: end, value: text } = element;
    const unit = indentUnit(text);
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      const first = text.lastIndexOf("\n", start - 1) + 1;
      if (!event.shiftKey && !text.slice(start, end).includes("\n")) { insert(unit); return; }
      // Several lines, or Shift+Tab: each chosen line moves one step.
      const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
      const close = text.indexOf("\n", last);
      const block = text.slice(first, close === -1 ? text.length : close);
      const moved = block.split("\n").map(line => event.shiftKey ? line.replace(new RegExp(`^(?: {1,${unit.length}}|\\t)`), "") : line ? unit + line : line).join("\n");
      if (moved === block) return;
      element.setSelectionRange(first, first + block.length);
      insert(moved);
      element.setSelectionRange(first, first + moved.length);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // The next line starts where this one does, one step in after an opening brace.
      const line = text.slice(text.lastIndexOf("\n", start - 1) + 1, start);
      const indent = indentOf(line) + (/[{[(]\s*$/.test(line) ? unit : "");
      if (!indent) return;
      event.preventDefault();
      insert(`\n${indent}`);
    }
  };
  return <div className="synthesis-editor">
    <pre className="synthesis-source synthesis-editor__layer" ref={layer} aria-hidden="true"><Lines source={value} problems={problems} /></pre>
    <textarea ref={area} className="synthesis-editor__input" aria-label={label} aria-invalid={problems.some(problem => problem.severity === "error") || undefined}
      value={value} wrap="off" spellCheck={false} autoCapitalize="off" autoComplete="off" autoCorrect="off" data-gramm="false"
      onChange={event => onChange(event.target.value)} onScroll={sync} onKeyDown={keyDown} />
  </div>;
}
