import { referenceKey, references } from "./references";
import type { CheckFiles, CheckResult, GroundedReference } from "./types";

/** What a reference names in the project: the file's line count, or undefined when it does not exist. */
export type ProjectLines = (path: string) => Promise<number | undefined>;
/** Grounded("REPORT.md", min = N): every file and line the text cites exists, and it cites at least N files. */
export async function checkGrounded(files: CheckFiles, file: string, min: number, lines: ProjectLines): Promise<CheckResult> {
  const text = files.candidate[file];
  if (text === undefined) return { status: "Fail", message: `${file} is missing`, feedback: [`${file} does not exist yet: write it.`] };
  const cited = references(text);
  const problems: string[] = [];
  const known = new Map<string, number | undefined>();
  // Each cited place once, with what was found: the Changes view marks the ones that do not hold.
  const checked = new Map<string, GroundedReference>();
  for (const reference of cited) {
    if (!known.has(reference.path)) known.set(reference.path, await lines(reference.path));
    const count = known.get(reference.path);
    const at = `${file}:${reference.line}`;
    let status: GroundedReference["status"] = "ok";
    if (count === undefined) { status = "missing"; problems.push(`${at} cites ${reference.path}, which does not exist in the project.`); }
    else if (reference.start !== undefined && (reference.start < 1 || reference.start > count)) { status = "range"; problems.push(`${at} cites ${reference.path}:${reference.start}, but ${reference.path} has ${count} lines.`); }
    else if (reference.end !== undefined && (reference.end < (reference.start ?? 1) || reference.end > count)) { status = "range"; problems.push(`${at} cites ${reference.path}:${reference.start}-${reference.end}, but ${reference.path} has ${count} lines.`); }
    const key = referenceKey(reference);
    if (!checked.has(key) && checked.size < 500) checked.set(key, { path: reference.path, ...(reference.start !== undefined ? { start: reference.start } : {}),
      ...(reference.end !== undefined ? { end: reference.end } : {}), status, ...(count !== undefined ? { lines: count } : {}) });
  }
  const valid = [...known].filter(([, count]) => count !== undefined).length;
  const grounded = { file, references: [...checked.values()] };
  if (problems.length) {
    return { status: "Fail", message: `${problems.length} of ${cited.length} references in ${file} do not hold`, feedback: [...new Set(problems)].slice(0, 8), grounded };
  }
  if (valid < min) return { status: "Fail", message: `${file} cites ${valid} project files; the contract asks for at least ${min}`,
    feedback: [`${file} cites ${valid} files of the project (as path or path:line); the contract asks for at least ${min}.`], grounded };
  return { status: "Pass", message: `Every one of ${cited.length} references (${valid} files) in ${file} holds`, feedback: [], grounded };
}
