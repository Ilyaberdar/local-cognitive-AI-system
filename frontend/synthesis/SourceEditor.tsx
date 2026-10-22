import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";

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
export function SourceEditor({ value, label, problems, reveal, onRevealed, onChange, onSave }: {
  value: string; label: string; problems: SourceProblem[];
  /** A line to bring the caret to; `key` asks again for the same line. */
  reveal?: { line: number; key: number };
  /** The line was shown: an editor made again later does not show it again. */
  onRevealed?: () => void;
  onChange: (value: string) => void; onSave: () => void;
}) {
  const hint = useId();
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
    onRevealed?.();
  }, [reveal?.key]);

  /** Replaces the selection as typing would, so undo takes it back. */
  const insert = (text: string) => {
    const element = area.current!;
    if (document.execCommand?.("insertText", false, text)) return;
    // Without the command: the text is set as typing sets it, so the caret can be placed at once.
    const { selectionStart: start, selectionEnd: end } = element;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(element, element.value.slice(0, start) + text + element.value.slice(end));
    element.setSelectionRange(start + text.length, start + text.length);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    // Keys that confirm an input method's text are its own.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    // The key, not its letter: ⌘S saves in any keyboard layout (as the app's shortcuts do).
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.code === "KeyS" || event.key.toLowerCase() === "s")) { event.preventDefault(); onSave(); return; }
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
      const lines = block.split("\n");
      const moved = lines.map(line => event.shiftKey ? line.replace(new RegExp(`^(?: {1,${unit.length}}|\\t)`), "") : line ? unit + line : line);
      if (moved.join("\n") === block) return;
      element.setSelectionRange(first, first + block.length);
      insert(moved.join("\n"));
      // A caret stays where it was in its line; a selection keeps the lines it held.
      if (start === end) { const at = Math.max(first, start + moved[0]!.length - lines[0]!.length); element.setSelectionRange(at, at); }
      else element.setSelectionRange(first, first + moved.join("\n").length);
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
    <span id={hint} className="synthesis-visually-hidden">Tab indents. Press Escape, then Tab, to leave the editor. ⌘S or Ctrl+S saves.</span>
    <textarea ref={area} className="synthesis-editor__input" aria-label={label} aria-describedby={hint} aria-invalid={problems.some(problem => problem.severity === "error") || undefined}
      value={value} wrap="off" spellCheck={false} autoCapitalize="off" autoComplete="off" autoCorrect="off" data-gramm="false"
      onChange={event => onChange(event.target.value)} onScroll={sync} onKeyDown={keyDown} />
  </div>;
}
