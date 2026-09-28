import { Comment, Diagnostic, SourcePosition, SourceSpan, Token } from "./types";

export const UNIT_SCALE: Readonly<Record<string, number>> = Object.freeze({
  ms: 1, s: 1000, m: 60_000, h: 3_600_000,
  B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, usd: 1
});

export interface LexResult { tokens: Token[]; comments: Comment[]; diagnostics: Diagnostic[] }

/** A small scanner, intentionally independent of JavaScript's grammar/evaluator. */
export function lex(source: string, path?: string): LexResult {
  let offset = 0;
  let line = 1;
  let column = 1;
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  const diagnostics: Diagnostic[] = [];
  const position = (): SourcePosition => ({ offset, line, column });
  const advance = (): string => {
    const char = source[offset++];
    if (char === "\n") { line++; column = 1; } else { column++; }
    return char;
  };
  const error = (code: string, message: string, start: SourcePosition) => {
    diagnostics.push({ severity: "error", code, message, span: { start, end: position() }, path });
  };
  const token = (kind: Token["kind"], start: SourcePosition, value?: string | number, unit?: string) => {
    tokens.push({ kind, text: source.slice(start.offset, offset), value, unit, span: { start, end: position() } });
  };
  const isDigit = (char?: string) => char !== undefined && char >= "0" && char <= "9";
  const isLetter = (char?: string) => char !== undefined && /[A-Za-z_]/.test(char);

  while (offset < source.length) {
    if (tokens.length >= 16_384) {
      error("LEX_TOKEN_LIMIT", "DSL files must contain fewer than 16,384 tokens.", position());
      break;
    }
    const char = source[offset];
    if (/\s/.test(char)) { advance(); continue; }
    const start = position();
    if (char === "/" && (source[offset + 1] === "/" || source[offset + 1] === "*")) {
      advance();
      const block = advance() === "*";
      if (block) {
        while (offset < source.length && !(source[offset] === "*" && source[offset + 1] === "/")) advance();
        if (offset === source.length) error("LEX_UNTERMINATED_COMMENT", "Unterminated block comment.", start);
        else { advance(); advance(); }
      } else {
        while (offset < source.length && source[offset] !== "\n") advance();
      }
      comments.push({ text: source.slice(start.offset, offset), span: { start, end: position() } });
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = advance();
      let value = "";
      let closed = false;
      while (offset < source.length) {
        const next = advance();
        if (next === quote) { closed = true; break; }
        if (next === "\n" || next === "\r") { error("LEX_STRING_NEWLINE", "Use \\n for a newline inside a string.", start); break; }
        if (next !== "\\") { value += next; continue; }
        if (offset === source.length) break;
        const escaped = advance();
        const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '\\': '\\', '"': '"', "'": "'", "/": "/" };
        if (escaped === "u") {
          const hex = source.slice(offset, offset + 4);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) error("LEX_ESCAPE", "Expected four hexadecimal digits after \\u.", start);
          else { for (let i = 0; i < 4; i++) advance(); value += String.fromCharCode(parseInt(hex, 16)); }
        } else if (Object.hasOwn(escapes, escaped)) value += escapes[escaped];
        else error("LEX_ESCAPE", `Unsupported string escape \\${escaped}.`, start);
      }
      if (!closed) error("LEX_UNTERMINATED_STRING", "Unterminated string literal.", start);
      token("string", start, value);
      continue;
    }
    if (isDigit(char)) {
      while (isDigit(source[offset])) advance();
      if (source[offset] === "." && isDigit(source[offset + 1])) {
        advance();
        while (isDigit(source[offset])) advance();
      }
      if (source[offset] === "e" || source[offset] === "E") {
        advance();
        if (source[offset] === "+" || source[offset] === "-") advance();
        if (!isDigit(source[offset])) error("LEX_NUMBER", "Expected digits in exponent.", start);
        while (isDigit(source[offset])) advance();
      }
      const numericEnd = offset;
      while (isLetter(source[offset])) advance();
      const unit = source.slice(numericEnd, offset) || undefined;
      const scale = unit ? UNIT_SCALE[unit] : 1;
      if (unit && !Object.hasOwn(UNIT_SCALE, unit)) error("LEX_UNIT", `Unknown unit '${unit}'.`, start);
      const value = Number(source.slice(start.offset, numericEnd)) * (scale ?? 1);
      if (!Number.isFinite(value)) error("LEX_NUMBER", "Numeric literals must be finite.", start);
      token("number", start, value, unit);
      continue;
    }
    if (isLetter(char)) {
      advance();
      while (isLetter(source[offset]) || isDigit(source[offset])) advance();
      token("identifier", start);
      continue;
    }
    if (["==", "!=", "<=", ">=", "&&", "||", "->"].includes(source.slice(offset, offset + 2))) {
      advance(); advance(); token("symbol", start); continue;
    }
    if ("{}()[];,:.=!<>+-*/%|".includes(char)) { advance(); token("symbol", start); continue; }
    advance();
    error("LEX_CHARACTER", `Unexpected character '${char}'.`, start);
  }
  const end = position();
  tokens.push({ kind: "eof", text: "", span: { start: end, end } });
  return { tokens, comments, diagnostics };
}

export function joinSpans(start: SourceSpan, end: SourceSpan): SourceSpan {
  return { start: start.start, end: end.end };
}
