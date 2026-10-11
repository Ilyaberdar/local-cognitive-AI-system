/**
 * What a chat may show of an answer while the model is still writing it. Only text meant for the
 * person is shown: the decoded text of an agent's final answer, never a tool call, its arguments,
 * JSON, reasoning or file and command blocks. The finished answer replaces it in full when the turn
 * ends, so anything held back here costs only a moment of delay.
 */

const TAGS = ["<think>", "<thinking>", "<analysis>"];

/** Skips leading reasoning blocks; undefined while one is still open (or its tag is still arriving). */
const afterThinking = (raw: string, from: number): number | undefined => {
  let i = from;
  for (;;) {
    while (i < raw.length && /\s/.test(raw[i]!)) i++;
    const rest = raw.slice(i), lower = rest.toLowerCase();
    const tag = TAGS.find(name => lower.startsWith(name));
    if (!tag) return rest && TAGS.some(name => name.startsWith(lower)) ? undefined : i;
    const close = lower.indexOf(`</${tag.slice(1)}`);
    if (close < 0) return undefined;
    i += close + tag.length + 1;
  }
};

/** Decodes a JSON string body from `start` up to its closing quote or the end of what has arrived;
 * an escape cut off at the end (or half of a surrogate pair) waits for the next delta. */
const decodeJsonString = (raw: string, start: number): string => {
  let text = "";
  for (let i = start; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === "\"") break;
    if (char !== "\\") { text += char; continue; }
    const kind = raw[i + 1];
    if (kind === undefined) break;
    if (kind === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4 || !/^[0-9a-f]{4}$/i.test(hex)) break;
      const code = parseInt(hex, 16);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = raw.slice(i + 6, i + 12);
        if (low.length < 6) break;
        if (/^\\u[0-9a-f]{4}$/i.test(low)) { text += String.fromCharCode(code, parseInt(low.slice(2), 16)); i += 11; continue; }
      }
      text += String.fromCharCode(code); i += 5; continue;
    }
    text += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[kind] ?? kind;
    i++;
  }
  return text;
};

/** The final answer text of an agent action as far as it has been generated:
 * `{"type":"final","text":"…"}`, wrapped in `{"action":…}` or a ```json fence or not. Undefined
 * while it is not yet clear the action is a final answer, and for every other action. */
export const finalAnswerSoFar = (raw: string): string | undefined => {
  let i = afterThinking(raw, 0);
  if (i === undefined) return undefined;
  const ws = () => { while (i! < raw.length && /\s/.test(raw[i!]!)) i!++; };
  // true when the token is next, undefined while it may still arrive, false when something else is.
  const take = (token: string): boolean | undefined => {
    ws();
    const next = raw.slice(i, i! + token.length);
    if (next.length < token.length) return token.startsWith(next) ? undefined : false;
    if (next !== token) return false;
    i! += token.length;
    return true;
  };
  const key = (): string | undefined => {
    if (take("\"") !== true) return undefined;
    const end = raw.indexOf("\"", i);
    if (end < 0) return undefined;
    const name = raw.slice(i, end);
    i = end + 1;
    return take(":") === true ? name : undefined;
  };
  ws();
  if (raw.startsWith("```", i)) {
    const line = raw.indexOf("\n", i);
    if (line < 0) return undefined;
    i = line + 1;
  }
  if (take("{") !== true) return undefined;
  let name = key();
  if (name === "action") {
    if (take("{") !== true) return undefined;
    name = key();
  }
  if (name !== "type" || take("\"final\"") !== true || take(",") !== true || key() !== "text" || take("\"") !== true) return undefined;
  return decodeJsonString(raw, i);
};

/** The part of a plain-text answer that may be shown while it is written: reasoning blocks are
 * hidden, a FINAL_OUTPUT section is shown without its marker, and nothing from the first file,
 * command or other `<<<` block on (it is applied, or summarized, when the turn ends). */
export const visibleAnswer = (raw: string): string => {
  const start = afterThinking(raw, 0);
  if (start === undefined) return "";
  let text = raw.slice(start);
  const final = /<<<FINAL_OUTPUT>>>\s*/i.exec(text);
  if (final) text = text.slice(final.index + final[0].length);
  const marker = text.indexOf("<<<");
  if (marker >= 0) text = text.slice(0, marker);
  // A "<" or "<<" at the very end may be the start of a marker.
  return text.replace(/<{1,2}$/, "").trimEnd();
};

/** Feeds raw deltas through `read` and calls `emit` with the visible text whenever it changes. */
export const answerStream = (read: (raw: string) => string | undefined, emit: (visible: string) => void) => {
  let raw = "", shown = "";
  return {
    push(delta: string) {
      raw += delta;
      const visible = read(raw) ?? "";
      if (visible !== shown) { shown = visible; emit(visible); }
    },
    /** Whether anything has been shown (so a retraction is worth sending). */
    get shown() { return shown; },
    reset() { raw = ""; shown = ""; }
  };
};
