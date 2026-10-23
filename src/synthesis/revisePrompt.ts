// What revise() shows a model writing one file of a module. Pure functions of the run's state, so a
// prompt can be rebuilt (and its hash checked) from a run record. Small models copy the file they are
// shown when they cannot tell what to change, so the result of the last check comes first-hand: which
// failures point into this file, the line each cites, the assertion that failed and the test around it.

export interface RevisePromptInput {
  file: string;
  artifacts: string[];
  module: string;
  description: string;
  /** What this kind of file is (LANGUAGE_HINTS). */
  hint: string;
  /** The flow's focused task for this file: it replaces the contract and the peer files. */
  instruction?: string;
  frozen: Array<[string, string]>;
  /** Visible test files only, never a hidden gate's. */
  tests: Array<[string, string]>;
  /** The candidate as it is now. */
  files: Record<string, string>;
  /** The flow's feedback items, as verify() made them ("gate: item"). */
  feedback: string[];
  /** The flow passed feedback that is not a list of strings (shown as JSON, as before). */
  other?: unknown;
  /** The first iteration, before any check. */
  first: boolean;
  /** The evaluation the feedback came from, by its visible gates. */
  checked?: { passed: number; total: number; hardPassed: number; hardTotal: number };
  /** The answer protocol: one file (source), a JSON object (json), or SEARCH/REPLACE blocks (edit). */
  reply: "source" | "json" | "edit";
  /** Only the first failure that points into this file: the file came back unchanged. */
  focus?: boolean;
  /** No "/no_think": the request thinks first. */
  thinking?: boolean;
}

/** The most the result of the last check takes in a prompt, as the feedback did before. */
export const FEEDBACK_CHARS = 4500;
const FROZEN_CHARS = 8000, TESTS_CHARS = 6000, CURRENT_CHARS = 10_000, PEER_CHARS = 4000, PEERS_CHARS = 10_000;

const fenceOf = (file: string) => /\.(?:m|c)?ts$/.test(file) ? "ts" : /\.(?:m|c)?js$/.test(file) ? "js" : /\.py$/.test(file) ? "python"
  : /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/.test(file) ? "cpp" : file.split(".").pop() ?? "";
const fenced = (name: string, text: string) => `\`\`\`${fenceOf(name)}\n${text}\n\`\`\``;
/** Files one after another, each named and fenced, within a total. */
function blocks(entries: Array<[string, string]>, each: number, total: number): string {
  let out = "";
  for (const [name, text] of entries) {
    const room = total - out.length - name.length - 20;
    if (room <= 200) break;
    out += `${out ? "\n" : ""}--- ${name}\n${fenced(name, text.slice(0, Math.min(each, room)))}`;
  }
  return out;
}

const TEST_START = /^\s*(?:test|it|describe)\s*\(|^\s*(?:async\s+)?def test_|^\s*(?:LC_)?TEST\s*\(/;
/** The test a line belongs to: from its start (at or above the line) to the next test, at most 25 lines.
 * Undefined for a line in no test (a file that failed to load reports line 1). */
export function testAt(source: string, line: number): { start: number; body: string } | undefined {
  const lines = source.split("\n");
  let start = line - 1;
  while (start >= 0 && !TEST_START.test(lines[start] ?? "")) start--;
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (TEST_START.test(lines[i]!)) { end = i; break; }
  return { start: start + 1, body: lines.slice(start, Math.min(end, start + 25)).join("\n").trimEnd() };
}
/** The candidate files a test uses: the names its file imports from each one (JavaScript, TypeScript or
 * Python imports), found in the test's body. */
export function filesUsedByTest(source: string, line: number, candidates: string[]): string[] {
  const test = testAt(source, line);
  if (!test) return [];
  const imports: Array<{ names: string[]; target: string }> = [];
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    imports.push({ names: match[1]!.split(",").map(item => item.replace(/\btype\b/, "").split(/\s+as\s+/).pop()!.trim()).filter(Boolean), target: match[2]!.replace(/^(?:\.\.?\/)+/, "") });
  }
  // Python: "from src.router import Router", a relative "from .router import Router", and a
  // parenthesized list over several lines; never past the end of its line otherwise.
  for (const match of source.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[ \t\w,]+)/gm)) {
    const module = match[1]!.replace(/^\.+/, "");
    if (!module) continue;
    imports.push({ names: match[2]!.replace(/[()]/g, "").split(",").map(item => item.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean), target: `${module.replace(/\./g, "/")}.py` });
  }
  const used = new Set<string>();
  for (const { names, target } of imports) {
    const file = candidates.find(candidate => candidate === target || target.endsWith(`/${candidate}`) || candidate.endsWith(`/${target}`));
    if (file && names.some(name => new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(test.body))) used.add(file);
  }
  return [...used];
}

/** "[tests/a.test.ts:17]": the failed case's test and line, at the end of a test item. */
const caseRefs = /\[([^\]\s:]+\.[A-Za-z]+):(\d+)\]/g;
const caseRef = { exec: (item: string) => [...item.matchAll(caseRefs)].at(-1) ?? null };
/** "(at tests/a.test.ts:20)" or ", called at tests/a.test.ts:20": the line of the test that failed. */
const atRef = /(?:\(at |called at )([^():\s,]+):(\d+)/;
/** Each place an item cites in a candidate file ("src/a.ts:12"). */
function citedLines(item: string, files: Record<string, string>): Array<{ file: string; line: number; text: string }> {
  const found: Array<{ file: string; line: number; text: string }> = [];
  for (const match of item.matchAll(/(?<![\w./-])([\w./-]+\.[A-Za-z]+):(\d+)/g)) {
    const file = match[1]!, line = Number(match[2]);
    const text = files[file]?.split("\n")[line - 1]?.trim();
    if (text && !found.some(item => item.file === file && item.line === line)) found.push({ file, line, text });
  }
  return found.slice(0, 2);
}
/** Whether an item mentions a file ("src/a.ts:3", "src/a.ts imports", "loads calculator.js once"). */
const names = (item: string, file: string) => {
  const at = item.indexOf(file);
  if (at < 0) return false;
  const before = item[at - 1], after = item[at + file.length];
  return (before === undefined || /[\s("'`[,]/.test(before)) && (after === undefined || /[\s:)"'`,.;]/.test(after));
};

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether a feedback item is about a file: the file is its subject ("index.html must …", "src/a.ts:3
 * imports …", "calculator.js: …" after the gate's id), a place in it is cited ("(src/a.ts:12)"), or it
 * is the only candidate file the item mentions. A file merely mentioned beside another ("index.html must
 * load calculator.js once") is not: the fix is in the subject. */
export function pointsAt(item: string, file: string, candidates: string[]): boolean {
  const body = item.replace(/^[A-Za-z_]\w*: /, "");
  if (body.startsWith(file) && /^(?:$|[\s:,])/.test(body.slice(file.length))) return true;
  if (new RegExp(`(?<![\\w./-])${escaped(file)}:\\d+`).test(item)) return true;
  const mentioned = candidates.filter(candidate => names(item, candidate));
  return mentioned.length === 1 && mentioned[0] === file;
}

/** The candidate files the feedback points at: an item is about it, or a failed visible test uses it. */
export function implicatedFiles(feedback: string[], files: Record<string, string>, tests: Array<[string, string]>): Set<string> {
  const found = new Set<string>();
  const candidates = Object.keys(files);
  for (const item of feedback) {
    for (const file of candidates) if (pointsAt(item, file, candidates)) found.add(file);
    const ref = caseRef.exec(item), test = ref && tests.find(([name]) => name === ref[1]);
    if (test) for (const file of filesUsedByTest(test[1], Number(ref![2]), candidates)) found.add(file);
  }
  return found;
}

interface Problem { item: string; context: string[]; body?: string; ours: boolean }
function problems(input: RevisePromptInput): Problem[] {
  return input.feedback.map(item => {
    const context = citedLines(item, input.files).map(cited => `${cited.file}:${cited.line} is: ${cited.text.slice(0, 160)}`);
    const ref = caseRef.exec(item), test = ref ? input.tests.find(([name]) => name === ref[1]) : undefined;
    const at = atRef.exec(item), atTest = at ? input.tests.find(([name]) => name === at[1]) : undefined;
    const assertion = atTest?.[1].split("\n")[Number(at![2]) - 1]?.trim();
    if (assertion) context.push(`${at![1]}:${at![2]} is: ${assertion.slice(0, 160)}`);
    const found = test ? testAt(test[1], Number(ref![2])) : undefined;
    const candidates = Object.keys(input.files);
    const ours = pointsAt(item, input.file, candidates) || (!!test && filesUsedByTest(test[1], Number(ref![2]), candidates).includes(input.file));
    return { item, context, ...(found ? { body: found.body } : {}), ours };
  });
}
/** The result of the last check within FEEDBACK_CHARS: every item first, then the cited lines, then the
 * tests' bodies while they fit. */
function resultSection(input: RevisePromptInput): string {
  const head = "# Result of the last check";
  if (!input.feedback.length) {
    const text = input.other !== undefined ? JSON.stringify(input.other).slice(0, FEEDBACK_CHARS) : input.first ? "none yet: this is the first attempt." : "none.";
    return `${head}\n${text}`;
  }
  const all = problems(input);
  const counts = input.checked ? `\n${input.checked.passed} of ${input.checked.total} tests passed; ${input.checked.hardPassed} of ${input.checked.hardTotal} required checks passed.` : "";
  const render = (level: 0 | 1 | 2) => {
    const show = (problem: Problem, index: number) => [`${index + 1}. ${problem.item}`,
      ...(level >= 1 ? problem.context.map(line => `   ${line}`) : []),
      ...(level >= 2 && problem.body ? ["   The test:", ...problem.body.split("\n").map(line => `     ${line}`)] : [])].join("\n");
    if (input.focus) {
      const first = all.find(problem => problem.ours);
      if (first) return `${head}${counts}\nFix this failure in ${input.file} now, and leave the rest of the file as it is; the other failures come one at a time after it:\n${show(first, 0)}`;
    }
    const mine = all.filter(problem => problem.ours), rest = all.filter(problem => !problem.ours);
    return [`${head}${counts}`,
      mine.length ? `In ${input.file}, or in tests that use it:\n${mine.map(show).join("\n")}` : "",
      rest.length ? `${mine.length ? "Elsewhere" : "Problems"} (the cause may still be in ${input.file}):\n${rest.map(show).join("\n")}` : ""].filter(Boolean).join("\n\n");
  };
  for (const level of [2, 1] as const) { const text = render(level); if (text.length <= FEEDBACK_CHARS) return text; }
  const text = render(0);
  return text.length > FEEDBACK_CHARS ? `${text.slice(0, FEEDBACK_CHARS - 1)}…` : text;
}

const EDIT_REPLY = (file: string) => `Answer with the change to ${file} only, as one or more blocks of this form, and nothing else:
<<<<<<< SEARCH
lines copied exactly from ${file} now
=======
the lines that replace them
>>>>>>> REPLACE`;

export function revisePrompt(input: RevisePromptInput): { system: string; prompt: string } {
  const { file } = input;
  const web = /\.(?:js|html|css)$/.test(file);
  const sections = [`Implement only the file ${file}. Other files: ${input.artifacts.filter(item => item !== file).join(", ") || "none"}.\n${input.hint}`];
  sections.push(input.instruction
    ? `# Your focused task for this file\nModule: ${input.module}. This scoped task is supplied by the authored flow; the full contract is independently verified after generation.\n${input.instruction}`
    : `# Contract (the whole module; write only ${file}'s part)\n${input.description}`);
  if (input.frozen.length) sections.push(`# Frozen interface files, written by the engineer: implement them exactly and never change them\n${blocks(input.frozen, FROZEN_CHARS, FROZEN_CHARS)}`);
  if (input.tests.length) sections.push(`# The engineer's tests that must pass (they import the module's files; never copy them into ${file})\n${blocks(input.tests, TESTS_CHARS, TESTS_CHARS)}`);
  const peers = Object.entries(input.files).filter(([name]) => name !== file);
  if (peers.length && !input.instruction) sections.push(`# The module's other files as they are now (use their exports exactly as written)\n${blocks(peers, PEER_CHARS, PEERS_CHARS)}`);
  sections.push(resultSection(input));
  const current = input.files[file];
  sections.push(current ? `# ${file} now${input.feedback.length ? " (the version checked above: change what makes it fail, keep what works)" : ""}\n${fenced(file, current.slice(0, CURRENT_CHARS))}`
    : `# ${file} now\n(empty)`);
  const reply = input.reply === "edit" && current ? EDIT_REPLY(file)
    : input.reply === "json" ? "Return an object with exactly one key, content, containing the complete file text. No markdown fences inside content. Do not explain."
    : `Return ONLY the complete source code of ${file}. No JSON. No explanations. At most one code fence.`;
  const finish = `${web ? "Use plain, minimal code under 100 lines." : "Keep the code plain and as short as the contract allows."} Finish ${input.reply === "json" ? "the JSON object" : "the response"} as soon as ${input.reply === "edit" ? "the blocks are" : "this single file is"} complete.${input.thinking ? "" : " /no_think"}`;
  sections.push(`${reply}\n${finish}`);
  const output = input.reply === "json" ? "Output only JSON with a content string." : input.reply === "edit" ? "Output only SEARCH/REPLACE blocks for this file." : "Output only source code, not JSON or explanations.";
  return {
    system: `You implement only ${file}, one small file of a software module. Follow the exact public interface in the contract and use the other files' exports as they are written. The contract describes the whole module; implement only this file's responsibility. ${output}`,
    prompt: sections.join("\n\n")
  };
}

/** SEARCH/REPLACE blocks applied to a file: each SEARCH must occur exactly once (as written, or with
 * every line trimmed). Undefined when there is no block or one does not apply. */
export function applyEditBlocks(current: string, reply: string): string | undefined {
  // Each delimiter is a whole line: a "// ==========" banner inside the code never ends a block.
  const found = [...reply.matchAll(/^<{7} ?SEARCH[ \t]*\r?\n([\s\S]*?)\r?\n={7}[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?^>{7} ?REPLACE[ \t]*$/gm)];
  if (!found.length) return undefined;
  let text = current;
  for (const [, search, replace] of found) {
    if (!search!.trim()) return undefined;
    if (text.split(search!).length === 2) { text = text.replace(search!, () => replace!); continue; }
    const lines = text.split("\n"), want = search!.split("\n").map(line => line.trim());
    const at: number[] = [];
    for (let i = 0; i + want.length <= lines.length; i++) if (want.every((line, j) => lines[i + j]!.trim() === line)) at.push(i);
    if (at.length !== 1) return undefined;
    lines.splice(at[0]!, want.length, ...replace!.split("\n"));
    text = lines.join("\n");
  }
  return text;
}
