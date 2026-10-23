import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeInSandbox } from "../agents/Terminal";
import { runCommand } from "../../utils/runCommand";
import { nodeTestIsolationFlag } from "./sandbox";
import { LC_NODE_REPORTER, LC_PYTHON_RUNNER, LC_TEST_HPP } from "./support";
import type { CheckCase, CheckFiles, CheckResult, SandboxProvider } from "./types";

export interface TestRunRequest {
  files: CheckFiles;
  /** Suite files to run (keys of files.suite); one language per request. */
  tests: string[];
  /** For running the tests; a C++ build gets its own 90 s. */
  timeoutMs: number;
  /** Feedback gives counts only, never test names (sealed tests). */
  hidden?: boolean;
  signal?: AbortSignal;
  sandbox: SandboxProvider;
  /** A folder of its own is created inside for this run and removed afterwards. */
  workRoot: string;
}

type Runner = "node" | "python" | "cpp";
type Run = Awaited<ReturnType<typeof runCommand>>;
const BUILD_TIMEOUT_MS = 90_000;
const SUPPORT: Record<Runner, [string, string]> = {
  node: ["lc-reporter.mjs", LC_NODE_REPORTER], python: ["lc_unittest_runner.py", LC_PYTHON_RUNNER], cpp: ["lc_test.hpp", LC_TEST_HPP]
};
// Names the run itself writes at the root (a file named tmp would also block the sandbox's TMPDIR, <work>/tmp).
const RESERVED: Record<Runner, string[]> = { node: ["lc-reporter.mjs"], python: ["lc_unittest_runner.py"], cpp: ["lc_test.hpp", "lc_tests"] };
const runnerOf = (file: string): Runner | undefined =>
  /\.(?:ts|mts|js|mjs|cjs)$/.test(file) ? "node" : /\.py$/.test(file) ? "python" : /\.(?:cpp|cc|cxx)$/.test(file) ? "cpp" : undefined;

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const unknown = (message: string, feedback: string[] = []): CheckResult => ({ status: "Unknown", message, feedback });
/** A file named "-x" would otherwise read as an option. */
const operand = (file: string) => file.startsWith("-") ? `./${file}` : file;
/** Compiler and crash lines name system files by absolute path; the model needs only their names. */
const shortPaths = (text: string) => text.replace(/(^|[\s'"(=])\/(?:[^\s'"():/]+\/)+([^\s'"():/]+)/g, "$1$2");

const searchPath = () => (process.env.PATH ?? "").split(path.delimiter).filter(dir => path.isAbsolute(dir));
const underHome = (file: string) => file === os.homedir() || file.startsWith(`${os.homedir()}${path.sep}`);
const isExecutable = async (file: string) => {
  try { await fs.access(file, constants.X_OK); return (await fs.stat(file)).isFile(); } catch { return false; }
};
/** On Windows the executable is a file, not a mode bit: a program is any existing file (node.exe, python.exe). */
const isProgram = async (file: string) => process.platform === "win32" ? fs.stat(file).then(stat => stat.isFile(), () => false) : isExecutable(file);
/** The Node runtime the app ships for the Windows sandbox (never the user's), set by the app. */
const shippedNode = (): string | undefined => process.env.LC_SANDBOX_NODE && existsSync(process.env.LC_SANDBOX_NODE) ? process.env.LC_SANDBOX_NODE : undefined;
const answers = new Map<string, Promise<string | undefined>>();
/** Asks a trusted tool outside the sandbox (xcrun, node --version). A success is kept for the app's lifetime. */
function ask(executable: string, args: string[]): Promise<string | undefined> {
  const key = [executable, ...args].join("\0");
  let answer = answers.get(key);
  if (!answer) {
    answer = runCommand(executable, args, os.tmpdir(), 20_000).then(result => result.exitCode === 0 && result.stdout.trim() || undefined, () => undefined);
    answers.set(key, answer);
    void answer.then(value => { if (value === undefined) answers.delete(key); });
  }
  return answer;
}

const versionParts = (version: string) => version.replace(/^v/, "").split(".").map(part => Number.parseInt(part, 10) || 0);
const atLeast = (version: string, major: number, minor: number) => {
  const [a = 0, b = 0] = versionParts(version);
  return a > major || a === major && b >= minor;
};
async function findNode(typescript: boolean): Promise<{ executable: string } | { problem: string }> {
  const [major, minor] = typescript ? [22, 18] : [22, 0];
  const problem = (seen?: string) => ({ problem: `${typescript ? "TypeScript" : "JavaScript"} contract tests need Node.js ${major}.${minor} or newer${seen ? `; found ${seen}` : ", which was not found"}.` });
  // On Windows the app ships the sandbox's Node runtime; nothing of the user's PATH is run.
  if (process.platform === "win32") {
    const node = shippedNode();
    if (!node) return { problem: "The sandbox's bundled Node runtime was not found in this install." };
    const version = await ask(node, ["--version"]);
    return version && atLeast(version, major, minor) ? { executable: node } : problem(version);
  }
  if (!process.versions.electron) return atLeast(process.versions.node, major, minor) ? { executable: process.execPath } : problem(`v${process.versions.node}`);
  // The desktop app's own binary is Electron: look where people install node.
  const nvm = path.join(os.homedir(), ".nvm", "versions", "node");
  const newest = (await fs.readdir(nvm).catch(() => [] as string[])).filter(name => /^v\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => versionParts(a).reduce((order, part, i) => order || part - versionParts(b)[i]!, 0)).pop();
  let seen: string | undefined;
  for (const dir of new Set([...searchPath(), "/opt/homebrew/bin", "/usr/local/bin", ...(newest ? [path.join(nvm, newest, "bin")] : [])])) {
    const candidate = path.join(dir, "node");
    const version = await isExecutable(candidate) ? await ask(candidate, ["--version"]) : undefined;
    if (version && atLeast(version, major, minor)) return { executable: candidate };
    seen ??= version;
  }
  return problem(seen);
}
async function findPython(): Promise<string | undefined> {
  // On Windows the sandbox can read a Python only where all application packages may (under Program
  // Files); one installed elsewhere (the common C:\PythonNN) is unreadable there, so the check is Unknown.
  if (process.platform === "win32") {
    const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432]
      .filter((dir): dir is string => Boolean(dir)).map(dir => path.resolve(dir));
    const within = (file: string) => programFiles.some(root => file.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`));
    for (const dir of searchPath()) for (const name of ["python.exe", "python3.exe"]) {
      const candidate = path.join(dir, name);
      if (within(candidate) && await isProgram(candidate)) return candidate;
    }
    return undefined;
  }
  for (const candidate of new Set([...searchPath().map(dir => path.join(dir, "python3")), "/usr/bin/python3"])) {
    // The sandbox cannot read the home folder (pyenv shims, virtual environments).
    if (underHome(candidate) || !await isExecutable(candidate)) continue;
    // On macOS /usr/bin/python3 is a shim that fails inside the sandbox; xcrun names the real binary.
    if (process.platform === "darwin" && candidate === "/usr/bin/python3") return ask("/usr/bin/xcrun", ["--find", "python3"]);
    return candidate;
  }
  return undefined;
}
async function findCompiler(): Promise<{ executable: string; flags: string[] } | undefined> {
  if (process.platform === "darwin") {
    // The toolchain's clang++ (not the /usr/bin shim) must be told the SDK: both come from xcrun, outside the sandbox.
    const [compiler, sdk] = await Promise.all([ask("/usr/bin/xcrun", ["--find", "clang++"]), ask("/usr/bin/xcrun", ["--show-sdk-path"])]);
    return compiler ? { executable: compiler, flags: sdk ? ["-isysroot", sdk] : [] } : undefined;
  }
  for (const name of ["clang++", "g++"]) for (const dir of searchPath()) {
    const candidate = path.join(dir, name);
    if (!underHome(candidate) && await isExecutable(candidate)) return { executable: candidate, flags: [] };
  }
  return undefined;
}
const realDir = async (file: string) => path.dirname(await fs.realpath(file).catch(() => file));

/** Turns the run's absolute paths in a message into relative ones, so none of the machine's folders
 * leaves: the work folder (under either name a run folder has: on macOS /var is /private/var) becomes ".",
 * the work root "..". Longest first, so a path is never cut by a shorter one inside it. On Windows the
 * same paths come back with "\" or as file:///C:/… URLs with "/", which are stripped too. */
export function pathCleaner(work: string, given: string, win = process.platform === "win32"): (text: string) => string {
  // The paths are this platform's: on Windows they are parsed as Windows paths wherever this runs.
  const P = win ? path.win32 : path;
  const roots = [...[work, given].map(root => [root, "", "."] as const),
    ...[P.dirname(work), P.dirname(given)].filter(root => root !== P.parse(root).root).map(root => [root, "../", ".."] as const)]
    .sort((a, b) => b[0].length - a[0].length);
  return (text: string) => roots.reduce((result, [root, inside, bare]) => {
    const forward = root.replace(/\\/g, "/");
    let out = result;
    // The folder with a trailing separator (in each form a message may carry it) becomes `inside` first,
    // so a Windows "<root>\" is cut before the bare "<root>" would turn its separator into part of ".".
    for (const prefix of [`file://${root}/`, `${root}/`, ...(win ? [`${root}\\`, `file:///${forward}/`, `${forward}/`] : [])]) out = out.split(prefix).join(inside);
    for (const bareForm of [root, ...(win ? [forward] : [])]) out = out.split(bareForm).join(bare);
    return out;
  }, text);
}

const safePath = (file: string) => file.length > 0 && file.length <= 512 && !file.startsWith("/") && !/[\\\0]/.test(file) &&
  file.split("/").every(part => part !== "" && part !== "." && part !== "..");
/** Every file at its path under one root, or why they cannot share it. */
function layout(files: CheckFiles, reserved: string[]): { entries: Array<[string, string]> } | { problem: string } {
  // macOS (and Windows) folders ignore case: src/A.ts and src/a.ts would be one file.
  const fold = (file: string) => process.platform === "linux" ? file : file.toLowerCase();
  const owners = new Map<string, string>();
  const entries: Array<[string, string]> = [];
  for (const [kind, map] of [["candidate", files.candidate], ["frozen", files.frozen], ["test", files.suite]] as const) {
    for (const [file, content] of Object.entries(map)) {
      if (!safePath(file)) return { problem: `The ${kind} file "${clip(file, 100)}" is not a relative path inside the module.` };
      const owner = owners.get(fold(file));
      if (owner) return { problem: `${file} is both a ${owner} file and a ${kind} file.` };
      owners.set(fold(file), kind);
      entries.push([file, String(content)]);
    }
  }
  for (const [file] of entries) {
    const name = reserved.find(item => fold(file) === fold(item) || fold(file).startsWith(`${fold(item)}/`)) ?? (fold(file) === "tmp" ? "tmp" : undefined);
    if (name) return { problem: `${file} uses the name ${name}, which the test run needs for its own files.` };
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/"), owner = owners.get(fold(folder));
      if (owner) return { problem: `${folder} is a ${owner} file and also the folder of ${file}.` };
    }
  }
  return { entries };
}

interface Report { cases: CheckCase[]; starts: string[]; errors: string[]; done?: { total: number; failed: number }; lines: number }
/** The runner's JSON lines, signed with this run's token. Anything else on stdout, the tests' own output
 * or a line the code under test made up, is ignored. */
function parseReport(stdout: string, clean: (text: string) => string, token: string): Report {
  const report: Report = { cases: [], starts: [], errors: [], lines: 0 };
  const text = (value: unknown, limit: number) => typeof value === "string" && value ? clip(clean(value), limit) : undefined;
  for (const raw of stdout.split("\n")) {
    const at = raw.indexOf('{"lc":');
    if (at < 0) continue;
    let item: Record<string, unknown>;
    try { item = JSON.parse(raw.slice(at).trimEnd()); } catch { continue; }
    if (!item || typeof item !== "object" || item.t !== token) continue;
    report.lines++;
    const name = text(item.name, 300);
    if (item.lc === "case" && name && (item.status === "pass" || item.status === "fail")) {
      const found: CheckCase = { name, status: item.status };
      const file = text(item.file, 300), message = text(item.message, 500), expected = text(item.expected, 200), actual = text(item.actual, 200);
      if (file) found.file = file;
      if (Number.isInteger(item.line) && (item.line as number) > 0) found.line = item.line as number;
      if (message) found.message = message;
      if (expected !== undefined) found.expected = expected;
      if (actual !== undefined) found.actual = actual;
      report.cases.push(found);
    } else if (item.lc === "start" && name) report.starts.push(name);
    else if (item.lc === "error" && text(item.message, 500)) report.errors.push(text(item.message, 500)!);
    else if (item.lc === "done" && Number.isInteger(item.total) && Number.isInteger(item.failed)) report.done = { total: item.total as number, failed: item.failed as number };
  }
  return report;
}
/** Tests that started but never reported: what a hang or a crash interrupted. */
function interrupted(report: Report): string[] {
  const reported = report.cases.map(item => item.name);
  return report.starts.filter(name => {
    const index = reported.indexOf(name);
    if (index >= 0) { reported.splice(index, 1); return false; }
    // A node file is settled by any of its cases; a parent by its children.
    return !report.cases.some(item => item.file === name || item.name.startsWith(`${name} › `)) &&
      !report.starts.some(other => other.startsWith(`${name} › `));
  });
}
/** Said when the values a failed comparison shows print exactly alike: what differs is what printing hides. */
export const SAME_PRINT_NOTE = "they differ in type or prototype (a number vs a string, an Object.create(null) object)";
/** A printed value that is not the whole value: clipped here or by the printer (more items or
 * characters, an object or array past its depth). Two of them alike say nothing about the values. */
const partial = (text: string) => /…|\.\.\. \d+ more (?:item|character)|\[(?:Object|Array|Circular)\b/.test(text);
const caseFeedback = (item: CheckCase) => {
  const alike = item.expected !== undefined && item.actual !== undefined && item.expected === item.actual && !partial(item.expected);
  const where = item.file ? ` [${item.file}${item.line ? `:${item.line}` : ""}]` : "";
  const head = `${clip(item.name, 100)}: `;
  // The location always fits: it says which test failed, and where its source is.
  const room = 300 - head.length - where.length;
  // A value keeps its own spaces ('a  b' is not 'a b'); only its line breaks become spaces.
  const flat = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();
  const printed = alike ? ` (expected and actual both print ${clip(flat(item.expected!), 40)}: ${SAME_PRINT_NOTE})`
    : item.expected !== undefined || item.actual !== undefined
    ? ` (expected ${clip(flat(item.expected ?? "undefined"), 80)}, actual ${clip(flat(item.actual ?? "undefined"), 80)})` : "";
  const values = room - 40 > 1 ? clip(printed, room - 40) : "";
  return clip(head + clip(oneLine(item.message ?? "failed"), Math.max(1, room - values.length)) + values + where, 300);
};
/** A value imported with `import type` is gone when the code runs, a trap small models fall into
 * ("ReferenceError: Pattern is not defined" six times over): said once, before the failed cases. */
export function typeImportHints(cases: CheckCase[], candidate: Record<string, string>): string[] {
  const hints = new Map<string, string>();
  for (const item of cases) {
    const found = /ReferenceError: ([A-Za-z_$][\w$]*) is not defined \(([^():\s]+):\d+\)/.exec(item.message ?? "");
    const source = found && candidate[found[2]];
    if (!found || !source) continue;
    const [, name, file] = found, word = name.replace(/\$/g, "\\$");
    if (!new RegExp(`import\\s+type\\s*\\{[^}]*\\b${word}\\b[^}]*\\}|import\\s+type\\s+${word}\\b|import\\s*\\{[^}]*\\btype\\s+${word}\\b`).test(source)) continue;
    hints.set(`${file}:${name}`, `${file} imports ${name} with "import type", which is removed when the code runs, so ${name} is not defined where the code uses it as a value (new ${name}, a call): import it with a plain import instead.`);
  }
  return [...hints.values()];
}
/** The line that says why a process died: a sanitizer report, a failed assert(), an abort. */
function crashLine(stderr: string, clean: (text: string) => string): string | undefined {
  const lines = stderr.split("\n").map(line => line.trim()).filter(line => line && !/WARNING:|^#\d+ /.test(line));
  const line = lines.find(item => /ERROR: \w*Sanitizer|runtime error:|Assertion failed|Assertion `|assertion failed|libc\+\+abi:|terminate called|Fatal Python error|\bAbort(?:ed| trap)?\b|Segmentation fault|Bus error|Illegal instruction/.test(item))
    ?? lines.find(item => /\b(?:Error|Exception)\b/.test(item)) ?? lines.at(-1);
  if (!line) return undefined;
  // A shell reports a signal as "./lc_tests: line 1: 123 Abort trap: 6 ..."; only the signal matters.
  const signal = line.match(/\b(?:Abort trap|Segmentation fault|Bus error|Illegal instruction|Killed|Trace\/BPT trap)(?:: \d+)?/)?.[0];
  // Sanitizer lines carry the pid and registers ("==12==ERROR: ... at pc 0x.. bp 0x.. sp 0x.."), noise to a model.
  const text = signal && /^\S+: line \d+:/.test(line) ? signal : line.replace(/^==\d+==\s*/, "").replace(/\s+(?:at )?\(?pc 0x[\da-f]+.*$/i, "");
  return clip(oneLine(shortPaths(clean(text))), 240);
}

function judge(run: Run, report: Report, request: TestRunRequest, runner: Runner, clean: (text: string) => string): CheckResult {
  const { hidden } = request, cases = report.cases;
  const failed = cases.filter(item => item.status === "fail");
  const total = Math.max(cases.length, report.done?.total ?? 0), failures = Math.max(failed.length, report.done?.failed ?? 0);
  const caseItems = [...hidden ? [] : typeImportHints(failed, request.files.candidate), ...failed.map(caseFeedback)];
  const open = interrupted(report);
  // The engineer's UI sees what a hang or a crash interrupted as failed cases too.
  const stopped = (message: string) => [...cases, ...open.map((name): CheckCase => ({ name, status: "fail", message }))];
  const fail = (message: string, feedback: string[], all = cases): CheckResult => ({ status: "Fail", message, feedback: feedback.slice(0, 8), cases: all });
  if (run.timedOut) {
    const message = `Timed out after ${seconds(request.timeoutMs)}`;
    return fail(message, hidden ? [`The sealed tests timed out after ${seconds(request.timeoutMs)}.`]
      : [`${message}${open.length ? ` while running ${clip(open.join(", "), 200)}` : ""}.`, ...caseItems], stopped(message));
  }
  if (run.exitCode !== 0 && !(report.done && failures > 0)) {
    const line = crashLine(run.stderr, clean);
    const message = `Crashed (exit ${run.exitCode}) ${cases.length ? `after ${plural(cases.length, "test")}` : "before any test finished"}`;
    const first = `${message}${open.length ? ` while running ${clip(open.join(", "), 120)}` : ""}${line ? `: ${line}` : ""}`;
    return fail(message, hidden ? [`The sealed tests crashed (exit ${run.exitCode}) after ${plural(cases.length, "test")}.`]
      : [clip(first, 300), ...report.errors.map(item => clip(oneLine(item), 300)), ...caseItems], stopped(line ? `${message}: ${line}` : message));
  }
  if (!report.lines) {
    // Exit 0 before any signed line: the code under test ended the process (or, in C++, brought a main()
    // of its own, which replaces the tests'). Either way the candidate kept its tests from running.
    const message = "The tests ended before reporting any result";
    return fail(message, hidden ? ["The sealed tests ended before reporting any result."]
      : [runner === "cpp" ? `${message}: if a source file defines main(), remove it (the tests bring their own).` : `${message}: the code under test must not exit the process.`]);
  }
  if (!report.done) {
    const message = `Stopped early (exit 0) after ${plural(cases.length, "test")}`;
    return fail(message, hidden ? ["The sealed tests stopped before finishing."]
      : [`${message}${open.length ? ` while running ${clip(open.join(", "), 120)}` : ""}: does the code under test exit the process?`, ...caseItems], stopped(message));
  }
  if (!total) return unknown("No tests ran", []);
  const message = `${total - failures} of ${plural(total, "test")} passed`;
  if (failures) return fail(message, hidden ? [`${failures} of ${total} sealed tests failed.`] : caseItems.length ? caseItems : [`${message}.`]);
  return { status: "Pass", message, feedback: [], cases };
}

/** The first compiler or linker errors, without the generic "linker command failed" line. */
function buildErrors(output: string, clean: (text: string) => string): string[] {
  // In a UTF-8 locale g++ quotes with ‘ ’; the model reads the same ' ' clang uses.
  const lines = output.split("\n").map(line => clean(line).replace(/[‘’]/g, "'").trim()).filter(Boolean);
  const found: Array<{ text: string; from: string }> = [];
  let pending: { text: string; from: string } | undefined;
  lines.forEach((line, i) => {
    if (/linker command failed|ld returned \d+ exit status/.test(line)) return;
    // An error inside a system header (a template) is ours where the first note in a module file points.
    const note = line.match(/^([^/\s][^:\s]*):(\d+):\d+: note: /);
    if (note && pending) { pending.from = ` (from ${note[1]}:${note[2]})`; pending = undefined; return; }
    // ld64 names an undefined symbol on the line after "Undefined symbols".
    if (/^Undefined symbols/.test(line)) found.push({ text: `Undefined symbol: ${lines[i + 1]?.replace(/, referenced from:$/, "") ?? "?"}`, from: "" });
    else if (/\berror\b:|undefined reference to|duplicate symbol|multiple definition of/i.test(line)) {
      found.push({ text: shortPaths(line), from: "" });
      pending = line.startsWith("/") ? found.at(-1) : undefined;
    }
  });
  if (!found.length) return lines.filter(line => /error/i.test(line)).concat(lines.slice(-1)).map(line => clip(shortPaths(line), 300));
  return found.map(item => clip(item.text, 300 - item.from.length) + item.from);
}
const missingSanitizer = /cannot find -l?(?:asan|ubsan)|libclang_rt\.(?:asan|ubsan)|lib(?:asan|ubsan)[\w.]*: No such file|unsupported option '-fsanitize|-fsanitize=\S+ (?:is )?not supported/i;

/** Runs the contract's own tests against the candidate in a sandbox and turns the result into a gate status. */
export async function runContractTests(request: TestRunRequest): Promise<CheckResult> {
  request.signal?.throwIfAborted();
  const tests = [...new Set(request.tests)];
  if (!tests.length) return unknown("The contract names no test files");
  const missing = tests.find(file => !Object.hasOwn(request.files.suite, file));
  if (missing) return unknown(`${missing} is not among the contract's test files`);
  const unsupported = tests.find(file => !runnerOf(file));
  if (unsupported) return unknown(`${unsupported}: contract tests are .ts, .mts, .js, .mjs, .cjs, .py, .cpp, .cc or .cxx files`);
  const runners = new Set(tests.map(file => runnerOf(file)!));
  if (runners.size > 1) return unknown(`One check runs one language's tests: ${tests.join(", ")} mixes ${[...runners].join(" and ")}`);
  const runner = [...runners][0]!;
  const planned = layout(request.files, RESERVED[runner]);
  if ("problem" in planned) return unknown(planned.problem);
  const unavailable = await request.sandbox.unavailable();
  if (unavailable) return unknown(unavailable);

  let tool: { executable: string; readable: string[]; flags: string[] };
  if (runner === "node") {
    const node = await findNode(tests.some(file => /\.m?ts$/.test(file)));
    if ("problem" in node) return unknown(node.problem);
    tool = { executable: node.executable, readable: [path.dirname(node.executable), await realDir(node.executable)], flags: [] };
  } else if (runner === "python") {
    const python = await findPython();
    if (!python) return unknown(`Python contract tests need python3, which was not found${process.platform === "darwin" ? " (xcode-select --install provides it)" : process.platform === "win32" ? " under Program Files, where the sandbox can read it" : ""}`);
    // On Windows the sandbox never opens up a folder outside the app's own roots, so the interpreter's
    // parent (C:\Program Files) is not added — it is readable only through its own ALL APPLICATION
    // PACKAGES inheritance. Elsewhere the parent is bound read-only so a shim can reach its real binary.
    const parent = process.platform === "win32" ? [] : [path.dirname(await realDir(python))];
    tool = { executable: python, readable: [path.dirname(python), await realDir(python), ...parent], flags: [] };
  } else if (process.platform === "win32") {
    return unknown("C++ contract tests are not supported in the Windows sandbox yet.");
  } else {
    const compiler = await findCompiler();
    if (!compiler) return unknown(`C++ contract tests need ${process.platform === "darwin" ? "clang++ (xcode-select --install provides it)" : "clang++ or g++"}, which was not found`);
    tool = { executable: compiler.executable, readable: [path.dirname(compiler.executable), await realDir(compiler.executable)], flags: compiler.flags };
  }

  let given: string | undefined;
  try {
    await fs.mkdir(request.workRoot, { recursive: true });
    given = await fs.mkdtemp(path.join(request.workRoot, "run-"));
    const work = await fs.realpath(given);
    const clean = pathCleaner(work, given);
    for (const [file, content] of [...planned.entries, SUPPORT[runner]]) {
      const target = path.join(work, ...file.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { flag: "wx" });
    }
    // The support files take this token from the environment and remove it before the code under test
    // loads, then sign their lines with it: printing a result line is not enough to fake one.
    const token = randomBytes(12).toString("hex");
    const execute = (executable: string, args: string[], timeoutMs: number) => {
      const wrapped = request.sandbox.wrap(executable, args, work, tool.readable);
      return runCommand(wrapped.executable, wrapped.args, work, timeoutMs, request.signal, undefined, { env: { ...wrapped.env, LC_REPORT_TOKEN: token } });
    };
    let run: Run;
    if (runner === "node") {
      const strip = tests.some(file => /\.m?ts$/.test(file)) ? ["--experimental-strip-types"] : [];
      // On Windows the tests run in one process (isolation none) and symlinks are kept, or node fails to
      // load a main script (lstat of a drive root is refused inside the sandbox).
      const win = process.platform === "win32" ? ["--preserve-symlinks", "--preserve-symlinks-main", await nodeTestIsolationFlag(tool.executable)] : [];
      run = await execute(tool.executable, [...win, "--test", ...strip, "--test-reporter=./lc-reporter.mjs", "--test-reporter-destination=stdout", ...tests.map(operand)], request.timeoutMs);
    } else if (runner === "python") {
      run = await execute(tool.executable, ["-I", "-B", "lc_unittest_runner.py", ...tests], request.timeoutMs);
    } else {
      const all = planned.entries.map(([file]) => file);
      const sources = Object.keys({ ...request.files.candidate, ...request.files.frozen }).filter(file => /\.(?:c|cc|cpp|cxx)$/.test(file)).sort();
      const includes = [...new Set(all.filter(file => /\.(?:h|hh|hpp|hxx|inl|ipp|tpp)$/.test(file)).map(file => path.posix.dirname(file)))]
        .filter(dir => dir !== ".").sort().map(dir => `-I${dir}`);
      const output = ["-I.", ...includes, "-o", "lc_tests", ...[...sources, ...tests].map(operand)];
      const flags = [...tool.flags, "-std=c++20", "-O0", "-g", "-fno-omit-frame-pointer"];
      let build = await execute(tool.executable, [...flags, "-fsanitize=address,undefined", ...output], BUILD_TIMEOUT_MS);
      // Some Linux toolchains ship without the sanitizer runtimes: build once more without them.
      if (build.exitCode !== 0 && !build.timedOut && missingSanitizer.test(build.stderr + build.stdout)) build = await execute(tool.executable, [...flags, ...output], BUILD_TIMEOUT_MS);
      if (build.timedOut) return { status: "Fail", message: `Build timed out after ${seconds(BUILD_TIMEOUT_MS)}`, feedback: [request.hidden ? "The build failed." : `The build timed out after ${seconds(BUILD_TIMEOUT_MS)}.`] };
      if (build.exitCode !== 0) {
        const errors = buildErrors(`${build.stderr}\n${build.stdout}`, clean);
        const first = errors[0]?.replace(/^(.+?:\d+):\d+: (?:fatal )?error: /, "$1: ");
        return request.hidden ? { status: "Fail", message: "Build failed", feedback: ["The build failed."] }
          : { status: "Fail", message: first ? `Build failed: ${clip(first, 200)}` : "Build failed", feedback: errors.slice(0, 3) };
      }
      // Through sh, a signal reads as 128 + n (134 for abort) on macOS too, where sandbox-exec execs in place.
      run = await execute("/bin/sh", ["-c", '"$0" "$@"; exit $?', "./lc_tests"], request.timeoutMs);
    }
    return judge(run, parseReport(run.stdout, clean, token), request, runner, clean);
  } catch (error) {
    // A cancelled run rejects; anything else (an unwritable work root, a failed spawn) is the machine's, not the model's.
    if (request.signal?.aborted) throw error;
    return unknown(`The tests could not run: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // The code under test ran in this folder: emptied inside the sandbox, where a link it left leads
    // a delete nowhere but the folder (the app never deletes it recursively itself).
    if (given) { const folder = given; await removeInSandbox(request.sandbox, folder); await remove(folder, false); }
  }
}

/** Removes a run's folder, even one the code under test locked (chmod 000): only real folders are unlocked, never link targets. */
async function remove(folder: string, recursive = true): Promise<void> {
  // What removeInSandbox could not empty stays: only an empty folder is removed here then.
  if (!recursive) { await fs.rmdir(folder).catch(() => undefined); return; }
  if (await fs.rm(folder, { recursive: true, force: true }).then(() => true, () => false)) return;
  const unlock = async (dir: string): Promise<void> => {
    await fs.chmod(dir, 0o700).catch(() => {});
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await unlock(path.join(dir, entry.name));
  };
  await unlock(folder);
  await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
}
