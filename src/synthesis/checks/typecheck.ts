// The candidate's TypeScript, type-checked in this process: never run, never emitted. Node strips the
// types when the tests run, so a wrong call (TS2554), a class imported with `import type` and then
// constructed (TS1361) or a property that is not there reach the tests only as a confusing runtime
// failure, or none. The compiler sees only the candidate's and the engineer's frozen files and the
// visible tests (never a hidden one), as the runner lays them out, and TypeScript's own lib files: no
// node_modules, no tsconfig, no plugins. It reports what it finds in the candidate and in those tests
// (a call a test makes with the wrong arguments), with the candidate's line it concerns.
import path from "node:path";
import type { CheckFiles, CheckResult } from "./types";

type TS = typeof import("typescript");
let compiler: TS | undefined;
/** Loaded on the first check: it is a large module the app does not need before. */
const typescript = (): TS => compiler ??= require("typescript") as TS;

const TS_FILE = /\.(?:m|c)?ts$/;
/** At most this much TypeScript is checked at once; more is not judged (Unknown). */
const MAX_CHECKED_BYTES = 512 * 1024;
/** What a check reports: a few items, each one message with the lines it is on. */
const MAX_ITEMS = 6, MAX_LINES = 6;
/** Messages about what this check cannot see, not about the candidate: Node's own types (no @types/node
 * here) and modules outside the candidate. */
const NOT_THE_CANDIDATES = new Set([2580, 2591, 2592, 2593, 2688, 2875]);
const ROOT = "/lc-candidate";
/** Errors that fail when the code runs, most direct first: a type-only import used as a value, a call
 * with the wrong arguments, a missing export, default export, name or module, something not callable. */
const FAILS_AT_RUN_TIME = [1361, 2554, 2555, 2305, 2614, 2613, 1192, 2304, 2307, 2349, 2351, 2348, 2339];

/** Whether a candidate holds TypeScript this check reads. */
export const hasTypeScript = (files: Record<string, string>) => Object.keys(files).some(file => TS_FILE.test(file) && !file.endsWith(".d.ts"));

/** `tests`: the visible test files (keys of files.suite) read with the candidate; never a hidden one. */
export function checkTypes(files: CheckFiles, tests: string[] = []): CheckResult {
  const sources: Record<string, string> = {};
  const visible = tests.filter(file => TS_FILE.test(file) && Object.hasOwn(files.suite, file));
  for (const [file, content] of [...Object.entries(files.frozen), ...visible.map(file => [file, files.suite[file]!] as const), ...Object.entries(files.candidate)]) {
    if (TS_FILE.test(file)) sources[file] = String(content);
  }
  const roots = [...Object.keys(files.candidate).filter(file => TS_FILE.test(file)), ...visible];
  const reported = (file: string) => Object.hasOwn(files.candidate, file) || visible.includes(file);
  if (!Object.keys(files.candidate).some(file => TS_FILE.test(file))) return { status: "Pass", message: "No TypeScript to check", feedback: [] };
  if (Object.values(sources).reduce((sum, text) => sum + Buffer.byteLength(text), 0) > MAX_CHECKED_BYTES) {
    return { status: "Unknown", message: `More than ${MAX_CHECKED_BYTES / 1024} KiB of TypeScript: not type-checked`, feedback: [] };
  }
  let ts: TS;
  try { ts = typescript(); } catch { return { status: "Unknown", message: "The TypeScript compiler is not available here", feedback: [] }; }
  const libDirectory = path.dirname(ts.getDefaultLibFilePath({}));
  // As the runner runs TypeScript: ES modules (the folder's package is "type": "module"), local
  // imports with their .ts extension, a type imported with `import type`, erasable syntax only.
  const options: import("typescript").CompilerOptions = {
    noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true, strict: false, noImplicitAny: false,
    types: [], lib: ["lib.es2023.d.ts", "lib.dom.d.ts"], skipLibCheck: true, noLib: false, allowJs: false, resolveJsonModule: false,
    noResolve: false, plugins: []
  };
  const virtual = (file: string) => file.startsWith(`${ROOT}/`) ? file.slice(ROOT.length + 1) : undefined;
  const directories = new Set([ROOT, ...Object.keys(sources).flatMap(file => file.split("/").slice(0, -1).map((_, i, parts) => `${ROOT}/${parts.slice(0, i + 1).join("/")}`))]);
  const inLib = (file: string) => path.dirname(file) === libDirectory;
  const read = (file: string): string | undefined => {
    if (file === `${ROOT}/package.json`) return '{"type":"module"}';
    const name = virtual(file);
    if (name !== undefined) return Object.hasOwn(sources, name) ? sources[name] : undefined;
    return inLib(file) ? ts.sys.readFile(file) : undefined;
  };
  const host: import("typescript").CompilerHost = {
    getSourceFile: (file, language) => { const text = read(file); return text === undefined ? undefined : ts.createSourceFile(file, text, language, true); },
    getDefaultLibFileName: () => path.join(libDirectory, "lib.d.ts"),
    writeFile: () => undefined,
    getCurrentDirectory: () => ROOT,
    getCanonicalFileName: file => file,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: file => read(file) !== undefined,
    readFile: read,
    // Nothing outside the candidate resolves: no node_modules, no @types.
    directoryExists: directory => directories.has(directory.replace(/\/$/, "")) || inLib(path.join(directory, "x")),
    getDirectories: () => [],
    realpath: file => file
  };
  let diagnostics: readonly import("typescript").Diagnostic[];
  try {
    const program = ts.createProgram(roots.map(file => `${ROOT}/${file}`), options, host);
    diagnostics = ts.getPreEmitDiagnostics(program);
  } catch (error) {
    return { status: "Unknown", message: `The TypeScript check could not run: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`, feedback: [] };
  }
  // One item per message and file, with every line it is on: "src/a.ts:3,9: … (TS2554)".
  const grouped = new Map<string, { file: string; lines: number[]; text: string; code: number }>();
  const lineOf = (source: import("typescript").SourceFile, at: number | undefined) => source.getLineAndCharacterOfPosition(at ?? 0).line + 1;
  for (const item of diagnostics) {
    const file = item.file && virtual(item.file.fileName);
    if (item.category !== ts.DiagnosticCategory.Error || !file || !reported(file)) continue;
    if (NOT_THE_CANDIDATES.has(item.code)) continue;
    // Where in the candidate it is declared, for an error a test's call makes ("tryAcquire(tokens: number)").
    const related = item.relatedInformation?.find(info => info.file && virtual(info.file.fileName) !== file && Object.hasOwn(files.candidate, virtual(info.file.fileName) ?? ""));
    const declared = related?.file ? ` (${ts.flattenDiagnosticMessageText(related.messageText, " ").replace(/\.$/, "")}: ${virtual(related.file.fileName)}:${lineOf(related.file, related.start)})` : "";
    const text = `${ts.flattenDiagnosticMessageText(item.messageText, " ")}${declared}`.replaceAll(`${ROOT}/`, "").replaceAll(ROOT, ".");
    // A module outside the candidate (node:, a package) is not something this check can read.
    if ((item.code === 2307 || item.code === 2792) && /'(?!\.{1,2}\/)[^']+'/.test(text)) continue;
    const line = lineOf(item.file!, item.start);
    const key = `${file}\0${item.code}\0${text}`;
    const found = grouped.get(key);
    if (found) { if (!found.lines.includes(line)) found.lines.push(line); } else grouped.set(key, { file, lines: [line], text, code: item.code });
  }
  // What fails when the code runs first (a type-only import used as a value, a wrong call, a missing
  // export or name), then the rest, by file and line.
  const rank = (code: number) => FAILS_AT_RUN_TIME.includes(code) ? FAILS_AT_RUN_TIME.indexOf(code) : FAILS_AT_RUN_TIME.length;
  const items = [...grouped.values()].sort((a, b) => rank(a.code) - rank(b.code) || a.file.localeCompare(b.file) || a.lines[0]! - b.lines[0]!);
  if (!items.length) return { status: "Pass", message: "No type errors", feedback: [] };
  const count = items.reduce((sum, item) => sum + item.lines.length, 0);
  return {
    status: "Fail",
    message: `${count} type error${count === 1 ? "" : "s"} in ${new Set(items.map(item => item.file)).size} file${new Set(items.map(item => item.file)).size === 1 ? "" : "s"}`,
    feedback: items.slice(0, MAX_ITEMS).map(item => {
      const text = `${item.file}:${item.lines.slice(0, MAX_LINES).join(",")}: ${item.text} (TS${item.code})`;
      return text.length > 300 ? `${text.slice(0, 288)}… (TS${item.code})` : text;
    })
  };
}
