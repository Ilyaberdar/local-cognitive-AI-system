import fs from "node:fs/promises";
import path from "node:path";
import { clauseCoverage, missingTests, SourceDiagnostic, sourceDiagnostics, suiteFiles } from "./check";

// `synthesis check <path>`: the contract checks of check.ts on files on disk, with no app, server or
// data folder, for an engineer or a coding agent writing a module in an editor. The authoring skill
// ships the same code bundled as scripts/check.mjs.

export interface ModuleCheck {module: string; specPath: string; flowPath: string; valid: boolean; diagnostics: SourceDiagnostic[]}

const MODULE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const IGNORED = new Set(["node_modules", "dist", "build", "release", "coverage", "vendor", "target", "Binaries", "Intermediate", "DerivedDataCache"]);
const MAX_SOURCE_BYTES = 128 * 1024, MAX_SUITE_BYTES = 512 * 1024, MAX_MODULES = 100, MAX_DEPTH = 12;
const posix = (file: string) => file.split(path.sep).join("/");

/** The .lcspec files under a folder, as discovery finds them: no hidden, dependency or build folders. */
async function contracts(folder: string, depth = 0, found: string[] = []): Promise<string[]> {
  for (const entry of (await fs.readdir(folder, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    if (found.length >= MAX_MODULES) break;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory() && !IGNORED.has(entry.name) && depth < MAX_DEPTH) await contracts(full, depth + 1, found);
    else if (entry.isFile() && entry.name.endsWith(".lcspec")) found.push(full);
  }
  return found;
}

async function readSource(file: string): Promise<string | {error: string}> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_SOURCE_BYTES) return {error: `holds ${Math.ceil(stat.size / 1024)} KiB; the app reads at most ${MAX_SOURCE_BYTES / 1024} KiB.`};
    return await fs.readFile(file, "utf8");
  } catch (error) { return {error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "is missing." : "could not be read."}; }
}

/** Checks one module: `specFile` is its .lcspec; its .lcflow is beside it. Paths in the diagnostics are
 * relative to `base` (the folder the command ran in). */
export async function checkModule(specFile: string, base = process.cwd()): Promise<ModuleCheck> {
  const name = path.basename(specFile, ".lcspec");
  const flowFile = path.join(path.dirname(specFile), `${name}.lcflow`);
  const specPath = posix(path.relative(base, specFile)), flowPath = posix(path.relative(base, flowFile));
  const unread: SourceDiagnostic[] = [];
  if (!MODULE_NAME.test(name)) unread.push({severity: "error", code: "MODULE_NAME", message: `${name}: a module's name starts with a letter and has only letters, digits and underscores (at most 64).`, file: specPath, line: 1, column: 1});
  const specSource = await readSource(specFile), flowSource = await readSource(flowFile);
  for (const [source, file] of [[specSource, specPath], [flowSource, flowPath]] as const) {
    if (typeof source !== "string") unread.push({severity: "error", code: "SOURCE_READ", message: `${file} ${source.error}`, file, line: 1, column: 1});
  }
  if (unread.length || typeof specSource !== "string" || typeof flowSource !== "string") return {module: name, specPath, flowPath, valid: false, diagnostics: unread};
  const {compiled, diagnostics} = sourceDiagnostics({name, specPath, flowPath, specSource, flowSource});
  const exists = async (relative: string) => { try { return (await fs.stat(path.resolve(base, relative))).isFile(); } catch { return false; } };
  diagnostics.push(...await missingTests(compiled.spec, specPath, exists));
  // Which clauses the tests name, from the tests that can be read (the rest are reported missing).
  const tests: Record<string, string> = {};
  let total = 0;
  for (const file of compiled.spec ? suiteFiles(compiled.spec) : []) {
    try { const text = await fs.readFile(path.join(path.dirname(specFile), file), "utf8"); total += Buffer.byteLength(text); tests[file] = text; } catch { /* Reported as SPEC_TEST_MISSING. */ }
  }
  if (total > MAX_SUITE_BYTES) diagnostics.push({severity: "error", code: "SPEC_TEST_LIMIT", message: "The contract's test files may hold at most 512 KiB together.", file: specPath, line: 1, column: 1});
  diagnostics.push(...clauseCoverage(compiled.spec, specPath, tests, specSource));
  return {module: compiled.spec?.module ?? name, specPath, flowPath, valid: !diagnostics.some(item => item.severity === "error"), diagnostics};
}

/** Every module at a path: a .lcspec file, or each one under a folder. */
export async function checkModules(target: string, base = process.cwd()): Promise<ModuleCheck[]> {
  const full = path.resolve(base, target);
  const stat = await fs.stat(full).catch(() => undefined);
  if (!stat) throw new Error(`${target} does not exist.`);
  const specs = stat.isDirectory() ? await contracts(full) : full.endsWith(".lcspec") ? [full] : [];
  if (!specs.length) throw new Error(stat.isDirectory() ? `No .lcspec file under ${target}.` : `${target} is not a .lcspec file or a folder.`);
  return Promise.all(specs.map(spec => checkModule(spec, base)));
}

/** What a terminal or an agent reads: one line a problem (path:line:column severity CODE message),
 * then one line a module. */
export function formatChecks(checks: ModuleCheck[]): string {
  const lines: string[] = [];
  for (const check of checks) {
    for (const item of check.diagnostics) lines.push(`${item.file ?? check.specPath}:${item.line}:${item.column} ${item.severity} ${item.code} ${item.message}`);
    const errors = check.diagnostics.filter(item => item.severity === "error").length, warnings = check.diagnostics.length - errors;
    lines.push(`${check.module}: ${errors || warnings ? `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}` : "ok"} (${check.specPath})`);
  }
  return lines.join("\n");
}

/** `check [path] [--json]` for the bundled script: 0 when no module has an error, 1 when one has, 64 on
 * a wrong call. */
export async function runCheckCommand(argv: string[], write: (text: string) => void = text => process.stdout.write(text), fail: (text: string) => void = text => process.stderr.write(text)): Promise<number> {
  const json = argv.includes("--json");
  const rest = argv.filter(argument => argument !== "--json");
  if (rest.length > 1 || rest.some(argument => argument.startsWith("-"))) { fail("Usage: check [<module.lcspec | folder>] [--json]\n"); return 64; }
  try {
    const checks = await checkModules(rest[0] ?? ".");
    write(`${json ? JSON.stringify(checks, null, 2) : formatChecks(checks)}\n`);
    return checks.every(check => check.valid) ? 0 : 1;
  } catch (error) { fail(`${error instanceof Error ? error.message : String(error)}\n`); return 64; }
}
