import type { CheckFiles, CheckLanguage, CheckResult } from "./types";

// Built-in architecture checks. They only read the module's text and execute nothing, so they
// behave the same on every OS and can run before any sandboxed test.

const EXTENSIONS: Record<string, CheckLanguage> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", py: "python",
  c: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", h: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp", inl: "cpp"
};
// Names a file outside the module whatever folder the import sits in (Windows forms included).
const ABSOLUTE = /^(?:[\\/]|[A-Za-z]:|file:)/i;

export function languageOf(path: string): CheckLanguage | undefined {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1].toLowerCase();
  return extension && Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : undefined;
}

export function matchesGlob(value: string, pattern: string): boolean { return glob(pattern).test(value); }
function glob(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    // "**" may stand for no segment at all, so "src/**" also matches "src".
    if (c === "/" && /^\*\*+$/.test(pattern.slice(i + 1))) { source += "(?:/.*)?"; break; }
    if (c !== "*") { source += c === "?" ? "[^/]" : c.replace(/[\\^$.|+()[\]{}]/g, "\\$&"); continue; }
    let end = i + 1;
    while (pattern[end] === "*") end++;
    if (end === i + 1) source += "[^/]*";
    else if ((i === 0 || pattern[i - 1] === "/") && pattern[end] === "/") { source += "(?:[^/]*/)*"; end++; }
    else source += ".*"; // inside a segment ("node:**") it crosses "/" too
    i = end - 1;
  }
  return new RegExp(`^${source}$`, "s");
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split(/[\\/]+/)) {
    if (part === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/") || ".";
}
const leaves = (path: string) => path === ".." || path.startsWith("../");

/** A relative specifier as a normalized path from the module root (it starts with "../" when it
 * leaves the root); package names, URLs and system headers come back unchanged. */
export function resolveImport(fromFile: string, specifier: string): string {
  const folder = fromFile.replace(/[^\\/]*$/, ""), language = languageOf(fromFile);
  if (language === "python") {
    const dots = /^\.*/.exec(specifier)![0].length;
    // One dot is the file's own package; each further dot climbs a level.
    return dots ? normalize(folder + "../".repeat(dots - 1) + specifier.slice(dots).replace(/\./g, "/")) : specifier;
  }
  if (language === "cpp") return specifier.startsWith("<") || ABSOLUTE.test(specifier) ? specifier : normalize(folder + specifier);
  return /^\.\.?(?:[\\/]|$)/.test(specifier) ? normalize(folder + specifier) : specifier;
}

interface Literal { text: string; end: number; raw: boolean }
const WORD = /[A-Za-z_$][\w$]*/y;
const CPP_NUMBER = /\.?\d(?:[eEpP][+-]|'(?=\w)|[\w.])*/y; // 1'000'000: a digit separator is no char literal
const PY_PREFIX = /^(?:[rubftRUBFT]|[rR][bBfFtT]|[bBfFtT][rR])$/;
// After these tokens a JavaScript "/" opens a regular expression rather than dividing.
const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "=>",
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/** Blanks comments and the contents of string, char, template and regex literals with spaces, keeping
 * delimiters, newlines and offsets, so no text inside them can pass for code. Code inside `${…}` and
 * f-string braces stays visible. Each string is recorded by the offset of its opening quote. */
function scan(source: string, language: CheckLanguage): { code: string; literals: Map<number, Literal> } {
  const out = source.split(""), literals = new Map<number, Literal>();
  const js = language === "javascript" || language === "typescript", py = language === "python", cpp = language === "cpp";
  const holes: Array<{ quote: string; raw: boolean; depth: number }> = [];
  let i = 0, last = ""; // `last` is the previous token, which tells a JavaScript regex from a division
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " "; };
  // Literal text up to its closing quote, or up to an interpolation, which the main loop reads as code.
  const text = (open: number, from: number, quote: string, raw: boolean, interpolates: boolean): number => {
    let k = from;
    last = '"';
    for (; k < source.length; k++) {
      const c = source[k];
      if (c === "\\") { k += source.startsWith("\r\n", k + 1) ? 2 : 1; continue; }
      if (source.startsWith(quote, k)) {
        blank(from, k);
        if (open >= 0) literals.set(open, { text: source.slice(from, k), end: k + quote.length, raw });
        return k + quote.length;
      }
      if (interpolates && (js ? c === "$" && source[k + 1] === "{" : c === "{")) {
        if (!js && source[k + 1] === "{") { k++; continue; }
        blank(from, k); holes.push({ quote, raw, depth: 0 }); last = "{";
        return k + (js ? 2 : 1);
      }
      if (c === "\n" && (quote === "'" || quote === '"')) break;
    }
    blank(from, k);
    return k;
  };
  while (i < source.length) {
    const c = source[i], next = source[i + 1];
    if (py ? c === "#" : (c === "/" && next === "/") || (js && !i && c === "#" && next === "!")) {
      let end = i;
      // C and C++ splice a line that ends in a backslash before they drop comments.
      do end = source.indexOf("\n", end + 1); while (cpp && end > 0 && /\\\r?$/.test(source.slice(end - 2, end)));
      if (end < 0) end = source.length;
      blank(i, end); i = end; continue;
    }
    if (!py && c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2), end = close < 0 ? source.length : close + 2;
      blank(i, end); i = end; continue;
    }
    WORD.lastIndex = i;
    const word = WORD.exec(source)?.[0];
    if (word) {
      i += word.length; last = word;
      const quote = source[i];
      if (py && (quote === "'" || quote === '"') && PY_PREFIX.test(word)) {
        const delimiter = source.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
        i = text(i, i + delimiter.length, delimiter, /r/i.test(word), /[ft]/i.test(word));
      } else if (cpp && quote === '"' && /^(?:u8|[uUL])?R$/.test(word)) {
        const delimiter = /^"([^\s()\\"]{0,16})\(/.exec(source.slice(i, i + 19))?.[1];
        if (delimiter !== undefined) {
          const close = source.indexOf(`)${delimiter}"`, i), end = close < 0 ? source.length : close + delimiter.length + 2;
          blank(i + 1, close < 0 ? end : end - 1); i = end; last = '"';
        }
      }
      continue;
    }
    if (cpp && /\d/.test(c === "." ? next : c)) { CPP_NUMBER.lastIndex = i; i += CPP_NUMBER.exec(source)![0].length; last = "0"; continue; }
    if (c === '"' || c === "'" || (js && c === "`")) {
      const delimiter = py && source.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i = text(i, i + delimiter.length, delimiter, false, c === "`"); continue;
    }
    if (js && c === "/" && REGEX_AFTER.has(last)) {
      const end = regexEnd(source, i);
      if (end > 0) { blank(i + 1, end - 1); i = end; last = '"'; continue; }
    }
    const hole = holes[holes.length - 1];
    if (hole && c === "}" && !hole.depth) { holes.pop(); i = text(-1, i + 1, hole.quote, hole.raw, true); continue; }
    if (hole && (c === "{" || c === "}")) hole.depth += c === "{" ? 1 : -1;
    const pair = source.slice(i, i + 2), token = pair === "++" || pair === "--" || pair === "=>" ? pair : c;
    if (!/\s/.test(c)) last = token;
    i += token.length;
  }
  return { code: out.join(""), literals };
}
function regexEnd(source: string, start: number): number {
  let inClass = false;
  // A literal still open after 1000 characters is taken for a division, which keeps hostile lines linear.
  for (let k = start + 1, end = Math.min(source.length, start + 1000); k < end && source[k] !== "\n"; k++) {
    const c = source[k];
    if (c === "\\") k++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return k + 1;
  }
  return -1;
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };
// "\x2e\x2e/x" must count as "../x", so specifiers are read as the runtime reads them.
function unescape(text: string): string {
  return text.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|x([0-9a-fA-F]{2})|([0-7]{1,3})|(\r\n|[\s\S]))/g,
    (_, braced?: string, short?: string, wide?: string, byte?: string, octal?: string, other = "") => {
      const hex = braced ?? short ?? wide ?? byte;
      if (hex) return String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff));
      if (octal) return String.fromCharCode(parseInt(octal, 8));
      return /^\r?\n$|^\r$/.test(other) ? "" : Object.hasOwn(ESCAPES, other) ? ESCAPES[other] : other;
    });
}

function lineOf(source: string): (offset: number) => number {
  const breaks: number[] = [];
  for (let k = source.indexOf("\n"); k >= 0; k = source.indexOf("\n", k + 1)) breaks.push(k);
  return offset => {
    let low = 0, high = breaks.length;
    while (low < high) { const middle = (low + high) >> 1; if (breaks[middle] < offset) low = middle + 1; else high = middle; }
    return low + 1;
  };
}

// The clause grammar, not "anything up to from": a bounded clause keeps the scan linear.
const JS_FROM = /(?<![\w$.])(?:import|export)\b\s*(?:type\b\s*)?(?:[\w$]+\s*(?:,\s*)?)?(?:\*\s*(?:as\b\s*[\w$]+\s*)?|\{[^{}]*\}\s*)?from\s*["']/g;
const JS_BARE = /(?<![\w$.])import\s*["']/g;
const JS_CALL = /(?<![\w$.])(?:import|require)\s*\(\s*["'`]/g;
const ARGUMENT_END = /\s*[,)]/y;
const S = String.raw`(?:[ \t]|\\\r?\n)*`; // spaces and line continuations
const DOTTED = String.raw`[A-Za-z_]\w*(?:${S}\.${S}[A-Za-z_]\w*)*`;
const PY_FROM = new RegExp(String.raw`(?<![\w.])from\b((?:${S}\.)*${S}(?:${DOTTED}${S})?)import\b`, "g");
const PY_IMPORT = new RegExp(String.raw`(?:^|[;:])[ \t]*import\b(${S}${DOTTED}(?:${S}as${S}\w+)?(?:${S},${S}${DOTTED}(?:${S}as${S}\w+)?)*)`, "gm");
const PY_NAME = new RegExp(String.raw`(${DOTTED})(?:${S}as${S}\w+)?`, "g");
const PY_CALL = /(?<![\w.])(?:__import__|(?:importlib\s*\.\s*)?import_module)\s*\(\s*[A-Za-z]{0,2}["']/g;
const CPP_INCLUDE = /^[ \t]*#[ \t]*(?:include(?:_next)?|import|embed)\b[ \t]*[<"]/gm;
const HEADER = /<[^>\n]*>/y;

export function extractImports(path: string, source: string): Array<{ specifier: string; line: number }> {
  const language = languageOf(path);
  if (!language) return [];
  const { code, literals } = scan(source, language), found = new Map<number, string>();
  // A call counts only when the literal is its whole first argument.
  const literal = (quote: number, call = false) => {
    const item = literals.get(quote);
    ARGUMENT_END.lastIndex = item?.end ?? 0;
    if (item && (!call || ARGUMENT_END.test(code))) found.set(quote, language === "cpp" || item.raw ? item.text : unescape(item.text));
  };
  if (language === "python") {
    for (const m of code.matchAll(PY_FROM)) {
      const specifier = m[1].replace(/[\s\\]/g, "");
      if (specifier) found.set(m.index + 4 + /^(?:[ \t]|\\\r?\n)*/.exec(m[1])![0].length, specifier);
    }
    for (const m of code.matchAll(PY_IMPORT)) {
      // A line continued by a backslash is not the start of a statement.
      if (!/[;:]/.test(m[0][0]) && /\\\r?\n$/.test(code.slice(Math.max(0, m.index - 3), m.index))) continue;
      const start = m.index + m[0].length - m[1].length;
      for (const name of m[1].matchAll(PY_NAME)) found.set(start + name.index, name[1].replace(/[\s\\]/g, ""));
    }
    for (const m of code.matchAll(PY_CALL)) literal(m.index + m[0].length - 1, true);
  } else if (language === "cpp") {
    for (const m of code.matchAll(CPP_INCLUDE)) {
      const at = m.index + m[0].length - 1;
      if (source[at] === '"') { literal(at); continue; }
      HEADER.lastIndex = at;
      const header = HEADER.exec(source)?.[0];
      if (header) found.set(at, header);
    }
  } else {
    for (const pattern of [JS_FROM, JS_BARE]) for (const m of code.matchAll(pattern)) literal(m.index + m[0].length - 1);
    for (const m of code.matchAll(JS_CALL)) literal(m.index + m[0].length - 1, true);
  }
  const line = lineOf(source);
  return [...found].sort(([a], [b]) => a - b).map(([offset, specifier]) => ({ specifier, line: line(offset) }));
}

const own = (record: Record<string, string>, key: string) => Object.hasOwn(record, key) ? record[key] : undefined;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const clip = (text: string, max = 300) => {
  const line = text.replace(/\s*[\r\n]+\s*/g, " ");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
// The model reads at most eight items; past that the eighth counts what was left out.
const limited = (items: string[]) => (items.length > 8 ? [...items.slice(0, 7), `…and ${items.length - 7} more.`] : items).map(item => clip(item));
const matching = (files: Record<string, string>, pattern: string) => {
  const expression = glob(pattern);
  return Object.keys(files).filter(path => expression.test(path)).sort();
};
const verb = (path: string) => languageOf(path) === "cpp" ? "includes" : "imports";
function closing(code: string, open: number, limit = code.length): number {
  const [opener, closer] = code[open] === "{" ? "{}" : "()";
  for (let k = open, depth = 0, end = Math.min(code.length, open + limit); k < end; k++) {
    if (code[k] === opener) depth++;
    else if (code[k] === closer && !--depth) return k;
  }
  return -1;
}
function topLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let k = 0; k < text.length; k++) {
    if ("([{".includes(text[k])) depth++;
    else if (")]}".includes(text[k])) depth--;
    else if (text[k] === "," && !depth) { parts.push(text.slice(start, k)); start = k + 1; }
  }
  return [...parts, text.slice(start)];
}
const escapeRegExp = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

const JS_DECLARED = /(?<![\w$.])export\s+(?:(?:default|declare)\s+)*(?:async\s+)?(?:abstract\s+)?(?:function\b\s*(?:\*\s*)?|(?:class|const\s+enum|const|let|var|interface|type|enum|namespace|module)\b\s*)([A-Za-z_$][\w$]*)/g;
const JS_LIST = /(?<![\w$.])export\s+(?:type\s+)?\{([^}]*)\}?/g;
// export * as X, export default X, export = X, exports.X =, module.exports.X =, module.exports = X
const JS_NAMED = /(?<![\w$.])(?:export\s*\*\s*as\s+([A-Za-z_$][\w$]*)|export\s+default\s+([A-Za-z_$][\w$]*)[ \t]*(?:;|$)|export\s*=\s*([A-Za-z_$][\w$]*)|(?:module\s*\.\s*)?exports\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)|module\s*\.\s*exports\s*=\s*([A-Za-z_$][\w$]*)[ \t]*(?:;|$))/gm;
const CJS_OBJECT = /(?<![\w$.])module\s*\.\s*exports\s*=\s*\{/g;
function jsNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(JS_DECLARED)) names.add(m[1]);
  for (const m of code.matchAll(JS_LIST)) for (const item of m[1].split(",")) names.add(item.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim());
  for (const m of code.matchAll(JS_NAMED)) names.add(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]);
  let until = 0;
  for (const m of code.matchAll(CJS_OBJECT)) {
    if (m.index < until) continue; // already read as part of an earlier object
    const open = m.index + m[0].length - 1, close = closing(code, open);
    until = close < 0 ? code.length : close;
    for (const member of topLevel(code.slice(open + 1, until))) {
      const key = /^\s*(?:(?:async|get|set)\s+)?\*?\s*([A-Za-z_$][\w$]*)/.exec(member)?.[1];
      if (key) names.add(key);
    }
  }
  return names;
}

const PY_DEFINED = /^(?:(?:async[ \t]+)?def|class)[ \t]+(\w+)|^([A-Za-z_]\w*)[ \t]*(?::[^\n=]*)?=(?!=)/gm;
const PY_IMPORTED = /^(?:from[ \t]+[\w.]+[ \t]+)?import[ \t]+(\([^)]*\)?|[^\n;]*)/gm;
function pyNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(PY_DEFINED)) names.add(m[1] ?? m[2]);
  // Top-level imports bind names too: a package's __init__.py exports what it imports.
  for (const m of code.matchAll(PY_IMPORTED)) for (const item of m[1].replace(/[()\\]/g, " ").split(",")) {
    const name = item.trim().split(/\s+as\s+/).pop()!.split(".")[0].trim();
    if (/^[A-Za-z_]\w*$/.test(name)) names.add(name);
  }
  return names;
}

// C++ patterns stay within a line or a bounded run wherever they can, so model-written text cannot
// make them backtrack for long.
const MACRO = String.raw`(?:\[\[[^\]\n]*\]\]|alignas\s*\([^)\n]*\)|__declspec\s*\([^)\n]*\)|[A-Z][A-Z0-9_]*)`; // class GAME_API UThing
// One word of a return type. A statement keyword means the line is a call, not a declaration.
const TYPE_WORD = String.raw`(?:\[\[[^\]\n]*\]\]|"[^"\n]*"|[A-Z][A-Z0-9_]*[ \t]*\([^()\n]*\)|(?!(?:return|else|case|default|new|delete|throw|goto|co_return|co_await|co_yield|do|if|while|for|switch|sizeof)\b)[A-Za-z_][\w:]*(?:[ \t]*<(?:[^;{}<>]|<[^;{}<>]*>)*>)?)`;
// Return type words share a line; only the name may follow on the next one.
const RETURN_TYPE = String.raw`(?:${TYPE_WORD}[ \t*&]+)*${TYPE_WORD}(?:[ \t*&]+|[ \t*&]*\r?\n[ \t*&]*)`;
function cppType(code: string, name: string): boolean {
  const n = escapeRegExp(name);
  // `} Name;` closes `typedef struct { … } Name;` (or declares a variable of an unnamed type).
  return new RegExp(String.raw`\b(?:(?:class|struct|union|enum)\s+(?:${MACRO}\s+)*|namespace\s+(?:\w+\s*::\s*)*)${n}\b|\busing\s+${n}\s*=|` +
    String.raw`\btypedef\b[^;{}]{0,300}\b${n}\s*;|\}\s*${n}\s*;`).test(code);
}
// A declaration starts a line, or follows a brace, a semicolon or an access specifier (one-line classes).
const cppFunction = (name: string, flags: string) =>
  new RegExp(String.raw`(?:^|[{};]|\b(?:public|private|protected)[ \t]*:)[ \t]*${RETURN_TYPE}${escapeRegExp(name)}\s*\(`, flags);
// The parameter list at `open` is followed by a body, past qualifiers and initializers.
const hasBody = (code: string, open: number) => {
  const close = closing(code, open, 2000);
  return close > 0 && /^[^;{}]*\{/.test(code.slice(close + 1, close + 400));
};
/** `Owner::name` has a body: written out of the class (`bool Owner::name(…) {`), or inside Owner's own body. */
function cppDefines(code: string, owner: string[], name: string): boolean {
  const chain = owner.map(escapeRegExp).join(String.raw`\s*::\s*`);
  const outside = new RegExp(String.raw`(?:^|[{};])[ \t]*(?:${RETURN_TYPE})?(?:\w+\s*::\s*)*${chain}\s*::\s*${escapeRegExp(name)}\s*\(`, "gm");
  if ([...code.matchAll(outside)].some(m => hasBody(code, m.index + m[0].length - 1))) return true;
  const bodies = new RegExp(String.raw`\b(?:class|struct|union|namespace)\s+(?:${MACRO}\s+)*(?:\w+\s*::\s*)*${escapeRegExp(owner[owner.length - 1])}\b[^;{}]{0,1000}\{`, "g");
  let until = 0;
  for (const m of code.matchAll(bodies)) {
    if (m.index < until) continue; // nested in a body already searched
    const open = m.index + m[0].length - 1, close = closing(code, open), body = code.slice(open, until = close < 0 ? code.length : close);
    if ([...body.matchAll(cppFunction(name, "gm"))].some(d => hasBody(body, d.index + d[0].length - 1))) return true;
  }
  return false;
}

export function checkExports(files: CheckFiles, file: string, symbols: string[]): CheckResult {
  const source = own(files.frozen, file) ?? own(files.candidate, file), language = languageOf(file);
  if (source === undefined) {
    return { status: "Fail", message: `${file} is missing`, feedback: [clip(`${file} does not exist${symbols.length ? `; it must export ${symbols.join(", ")}` : ""}.`)] };
  }
  if (!language) return { status: "Unknown", message: `Exports cannot be read from ${file}`, feedback: [] };
  const code = scan(source, language).code, missing: string[] = [];
  if (language === "cpp") {
    let module: string[] | undefined;
    const everywhere = () => module ??= [...Object.entries(files.frozen), ...Object.entries(files.candidate)]
      .filter(([path]) => languageOf(path) === "cpp").map(([, text]) => scan(text, "cpp").code);
    for (const symbol of symbols) {
      const owner = symbol.replace(/^::/, "").split("::").map(part => part.trim()), name = owner.pop()!;
      if (!owner.length) {
        if (!cppType(code, name) && !cppFunction(name, "m").test(code)) missing.push(`${file} must export ${symbol}.`);
        continue;
      }
      // The owner is declared here, or this file holds the definition of a member declared elsewhere.
      const last = owner[owner.length - 1], defined = everywhere().some(text => cppDefines(text, owner, name));
      const declared = cppType(code, last) || (cppDefines(code, owner, name) && everywhere().some(text => cppType(text, last)));
      const needs = [!declared && `declare ${last}`, !defined && `define ${symbol}(…) with a body`].filter(Boolean);
      if (needs.length) missing.push(`${file} must export ${symbol}: ${needs.join(" and ")}.`);
    }
  } else {
    const names = language === "python" ? pyNames(code) : jsNames(code);
    for (const symbol of symbols) if (!names.has(symbol)) missing.push(`${file} must export ${symbol}.`);
  }
  return missing.length
    ? { status: "Fail", message: `${count(missing.length, "symbol is", "symbols are")} missing from ${file}`, feedback: limited(missing) }
    : { status: "Pass", message: "Every symbol is exported", feedback: [] };
}

/** Frozen files are the engineer's, so only the candidate's imports are held to the rules. */
export function checkImports(files: CheckFiles, pattern: string, rules: { allow: string[]; deny: string[] }): CheckResult {
  const paths = matching(files.candidate, pattern);
  if (!paths.length) {
    return { status: "Fail", message: `No candidate file matches "${clip(pattern, 80)}"`,
      feedback: [clip(`The contract checks the imports of files matching "${pattern}", but no file matches it.`)] };
  }
  const deny = rules.deny.map(glob), allow = rules.allow.map(glob), violations: string[] = [];
  for (const path of paths) for (const { specifier, line } of extractImports(path, files.candidate[path])) {
    const target = resolveImport(path, specifier), hit = (expression: RegExp) => expression.test(target) || expression.test(specifier);
    if (deny.some(hit) || (allow.length && !allow.some(hit))) {
      violations.push(`${path}:${line} ${verb(path)} "${specifier}"${target === specifier ? "" : ` (${target})`}, which the contract does not allow.`);
    }
  }
  return violations.length
    ? { status: "Fail", message: `${count(violations.length, "import breaks", "imports break")} the contract's rules`, feedback: limited(violations) }
    : { status: "Pass", message: "Every import follows the contract's rules", feedback: [] };
}

export function checkForbidden(files: CheckFiles, pattern: string, regex: string, message?: string): CheckResult {
  const shown = `/${clip(regex, 60)}/`;
  let expression: RegExp;
  try { expression = new RegExp(regex, "gm"); }
  catch { return { status: "Unknown", message: `${shown} is not a valid regular expression`, feedback: [] }; }
  const paths = matching(files.candidate, pattern), hits: string[] = [];
  for (const path of paths) {
    const source = files.candidate[path], language = languageOf(path), line = lineOf(source);
    // Files of other languages (HTML, CSS…) are searched as written.
    for (const m of (language ? scan(source, language).code : source).matchAll(expression)) {
      const used = clip(source.slice(m.index, m.index + m[0].length).replace(/\s+/g, " ").trim(), 60);
      hits.push(`${path}:${line(m.index)} uses "${used}"${message ? `: ${message}` : `, which matches the forbidden pattern /${regex}/.`}`);
    }
  }
  if (hits.length) return { status: "Fail", message: `${count(hits.length, "forbidden use", "forbidden uses")} of ${shown}`, feedback: limited(hits) };
  return { status: "Pass", message: paths.length ? `No file uses ${shown}` : `No candidate file matches "${clip(pattern, 80)}"`, feedback: [] };
}

/** Run before any test executes: a candidate may read only files of the module, packages and system
 * headers, never a path outside the root. */
export function checkImportBoundary(files: CheckFiles): CheckResult {
  const problems: string[] = [];
  for (const path of Object.keys(files.candidate).sort()) {
    const cpp = languageOf(path) === "cpp";
    for (const { specifier, line } of extractImports(path, files.candidate[path])) {
      const angle = cpp && specifier.startsWith("<"), value = angle ? specifier.slice(1, -1) : specifier;
      const target = angle ? normalize(value) : resolveImport(path, specifier);
      // A system header or a package path can still climb out with "..".
      if (ABSOLUTE.test(value) || leaves(target) || (target === specifier && leaves(normalize(value)))) {
        problems.push(`${path}:${line} ${verb(path)} "${specifier}": files may only ${cpp ? "include files of the module or system headers" : "import files of the module or installed packages"}.`);
      }
    }
  }
  return problems.length
    ? { status: "Fail", message: `${count(problems.length, "import reaches", "imports reach")} outside the module`, feedback: limited(problems) }
    : { status: "Pass", message: "Every import stays inside the module", feedback: [] };
}
