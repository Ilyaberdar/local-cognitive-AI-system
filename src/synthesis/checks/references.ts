// The path:line references a text cites: Grounded checks them, and the Changes view links them.
// No imports, so the frontend bundles this same file.

/** A cited path, optionally with a line or range; `line` is the text's line it is on (from 1),
 * `column` where it starts on that line (from 0) and `raw` what was written. */
export interface Reference { path: string; start?: number; end?: number; line: number; column: number; raw: string }

// A path with a folder ("src/a.ts"), optionally with a line or range (":12", ":12-20"). A bare name
// ("Node.js", "REPORT.md") is not taken for a reference, and neither is a URL. Tokens are found by a
// pattern without nested choices and checked in code, so a long line a model wrote stays fast.
const TOKEN = /[A-Za-z0-9_./-]+(?::\d{1,7}(?:[-–]\d{1,7})?)?/g;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/** Every path:line reference of a text, with where it is in the text. */
export function references(text: string): Reference[] {
  const found: Reference[] = [];
  for (const [index, row] of text.split("\n").entries()) {
    for (const match of row.matchAll(TOKEN)) {
      const before = row.slice(Math.max(0, match.index - 3), match.index);
      if (before.endsWith("://") || /[\w@:]$/.test(before)) continue;
      const raw = match[0].replace(/[.,;:]+$/, "");
      const at = raw.search(/:\d/);
      const [token, line] = at < 0 ? [raw, ""] : [raw.slice(0, at), raw.slice(at + 1)];
      const parts = token.split("/");
      if (parts.length < 2 || !parts.every(part => SEGMENT.test(part)) || !/\.[A-Za-z0-9]{1,10}$/.test(parts[parts.length - 1]!)) continue;
      const [start, end] = line ? line.split(/[-–]/).map(Number) : [];
      found.push({ path: token, line: index + 1, column: match.index, raw, ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) });
    }
  }
  return found;
}

/** One key per cited place: the same path and lines wherever the text cites them. */
export const referenceKey = (reference: Pick<Reference, "path" | "start" | "end">) => `${reference.path}:${reference.start ?? ""}-${reference.end ?? ""}`;
