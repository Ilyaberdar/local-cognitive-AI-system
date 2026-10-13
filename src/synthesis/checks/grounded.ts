import type { CheckFiles, CheckResult } from "./types";

/** What a reference names in the project: the file's line count, or undefined when it does not exist. */
export type ProjectLines = (path: string) => Promise<number | undefined>;
export interface Reference { path: string; start?: number; end?: number; line: number }

// A path with a folder ("src/a.ts"), optionally with a line or range (":12", ":12-20"). A bare name
// ("Node.js", "REPORT.md") is not taken for a reference, and neither is a URL.
const REFERENCE = /(?<![\w/.:@-])((?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)+[A-Za-z0-9_-][A-Za-z0-9_.-]*\.[A-Za-z0-9]{1,10})(?::(\d{1,7})(?:\s*[-–]\s*(\d{1,7}))?)?/g;

/** Every path:line reference of a text, with the line of the text it is on. */
export function references(text: string): Reference[] {
  const found: Reference[] = [];
  for (const [index, row] of text.split("\n").entries()) {
    for (const match of row.matchAll(REFERENCE)) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(row.slice(Math.max(0, match.index - 12), match.index + 3))) continue;
      const start = match[2] ? Number(match[2]) : undefined, end = match[3] ? Number(match[3]) : undefined;
      found.push({ path: match[1].replace(/[.,;:]+$/, ""), line: index + 1, ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) });
    }
  }
  return found;
}

/** Grounded("REPORT.md", min = N): every file and line the text cites exists, and it cites at least N files. */
export async function checkGrounded(files: CheckFiles, file: string, min: number, lines: ProjectLines): Promise<CheckResult> {
  const text = files.candidate[file];
  if (text === undefined) return { status: "Fail", message: `${file} is missing`, feedback: [`${file} does not exist yet: write it.`] };
  const cited = references(text);
  const problems: string[] = [];
  const known = new Map<string, number | undefined>();
  for (const reference of cited) {
    if (!known.has(reference.path)) known.set(reference.path, await lines(reference.path));
    const count = known.get(reference.path);
    const at = `${file}:${reference.line}`;
    if (count === undefined) problems.push(`${at} cites ${reference.path}, which does not exist in the project.`);
    else if (reference.start !== undefined && (reference.start < 1 || reference.start > count)) problems.push(`${at} cites ${reference.path}:${reference.start}, but ${reference.path} has ${count} lines.`);
    else if (reference.end !== undefined && (reference.end < (reference.start ?? 1) || reference.end > count)) problems.push(`${at} cites ${reference.path}:${reference.start}-${reference.end}, but ${reference.path} has ${count} lines.`);
  }
  const valid = [...known].filter(([, count]) => count !== undefined).length;
  if (problems.length) {
    return { status: "Fail", message: `${problems.length} of ${cited.length} references in ${file} do not hold`, feedback: [...new Set(problems)].slice(0, 8) };
  }
  if (valid < min) return { status: "Fail", message: `${file} cites ${valid} project files; the contract asks for at least ${min}`,
    feedback: [`${file} cites ${valid} files of the project (as path or path:line); the contract asks for at least ${min}.`] };
  return { status: "Pass", message: `Every one of ${cited.length} references (${valid} files) in ${file} holds`, feedback: [] };
}
