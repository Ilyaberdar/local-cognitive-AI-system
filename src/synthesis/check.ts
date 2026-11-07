import { compileProgram, SpecProgram } from "./language";
import { supportedEvaluators } from "./evaluatorIds";
import { isProjectRelative } from "./pathRules";

// What a contract and its flow say about themselves wherever they are: the compiler's diagnostics, the
// limits of this runtime (V1, local files), the module's name and its test files. The app's module
// screen adds what depends on this computer (providers, consent, sandbox); `synthesis check` and the
// authoring skill run only this, offline. Nothing here reads the app's settings or data.

export interface SourceDiagnostic {severity: "error" | "warning"; code: string; message: string; file?: string; line: number; column: number}

/** Source in the languages the contract checks know, plus the web files of the calculator. */
export const ARTIFACT_TYPES = /\.(?:js|mjs|cjs|ts|mts|cts|py|c|cc|cpp|cxx|h|hh|hpp|hxx|inl|json|html|css|txt|md)$/;
export const MAX_SUITE_FILES = 24;
/** The most interpreter steps a flow may declare with `limit steps`. */
export const MAX_STEPS = 1_000_000;

/** The contract's test files: its tests section and every file a Tests gate runs. */
export const suiteFiles = (spec: SpecProgram): string[] => [...new Set([...(spec.tests ?? []),
  ...spec.gates.flatMap(gate => gate.check?.kind === "tests" ? gate.check.files : [])])];

/** What this runtime can run, as diagnostics: Run refuses the errors, and a module shows them as soon
 * as it is opened. */
export function profileDiagnostics(compiled: ReturnType<typeof compileProgram>, specPath: string, flowPath: string): SourceDiagnostic[] {
  const found: SourceDiagnostic[] = [];
  const add = (severity: "error" | "warning", code: string, message: string, file: string) => found.push({severity, code, message, file, line: 1, column: 1});
  if (!compiled.spec || !compiled.flow) return found;
  if (compiled.flow.limits.iterations < 1 || compiled.flow.limits.iterations > 32 || compiled.flow.limits.timeMs > 7200000) {
    add("error", "FLOW_LIMIT_RANGE", "V1 supports at most 32 iterations and 120 minutes per run.", flowPath);
  }
  if ((compiled.flow.limits.steps ?? 0) > MAX_STEPS) add("error", "FLOW_LIMIT_RANGE", `A run takes at most ${MAX_STEPS.toLocaleString("en")} steps.`, flowPath);
  if ((!compiled.spec.artifacts.length && !compiled.spec.areas?.length) || compiled.spec.artifacts.length > 12 || (compiled.spec.areas?.length ?? 0) > 12) add("error", "SPEC_ARTIFACT_LIMIT", "Declare 1 to 12 artifact files, or a files area, and at most 12 areas.", specPath);
  if ((compiled.spec.frozen ?? []).length > 12) add("error", "SPEC_ARTIFACT_LIMIT", "Declare at most 12 frozen files.", specPath);
  for (const file of [...compiled.spec.artifacts, ...compiled.spec.frozen ?? []]) {
    if (!isProjectRelative(file)) { add("error", "SPEC_ARTIFACT_PATH", `${file}: use a project-relative path without spaces, hidden folders or "..".`, specPath); continue; }
    if (!ARTIFACT_TYPES.test(file)) add("error", "SPEC_ARTIFACT_TYPE", `${file}: local-files-v1 supports source files (JavaScript, TypeScript, Python, C and C++), json, html, css, txt and md.`, specPath);
  }
  const suite = suiteFiles(compiled.spec);
  if (suite.length > MAX_SUITE_FILES) add("error", "SPEC_TEST_LIMIT", `Declare at most ${MAX_SUITE_FILES} test files.`, specPath);
  for (const file of suite) {
    if (!isProjectRelative(file)) add("error", "SPEC_TEST_PATH", `${file}: use a path relative to the contract's folder, without spaces, hidden folders or "..".`, specPath);
  }
  for (const gate of compiled.spec.gates) {
    if (!gate.check && (compiled.spec.evaluator !== "calculator-v1" || !supportedEvaluators.has(gate.evaluatorId))) {
      add("warning", "SPEC_EVALUATOR_UNREGISTERED", `No trusted evaluator is registered for ${gate.evaluatorId}: the gate ${gate.id} will be Unknown and cannot pass.`, specPath);
    }
  }
  return found;
}

/** A module's two sources checked together: the compiler, then (when it found no error) the runtime's
 * limits, then whether the contract declares the module its file is named for. */
export function sourceDiagnostics(sources: {name: string; specPath: string; flowPath: string; specSource: string; flowSource: string}) {
  const {name, specPath, flowPath} = sources;
  const compiled = compileProgram(sources.specSource, sources.flowSource, {specPath, flowPath});
  const diagnostics: SourceDiagnostic[] = [...compiled.diagnostics.map(item => ({severity: item.severity, code: item.code, message: item.message, file: item.path, line: item.span.start.line, column: item.span.start.column})),
    // What Run would refuse is shown before it: the module is not "valid" only to fail at Run.
    ...(compiled.diagnostics.some(item => item.severity === "error") ? [] : profileDiagnostics(compiled, specPath, flowPath))];
  if (compiled.spec?.module !== name) diagnostics.push({severity: "error", code: "MODULE_NAME", message: "Filename and module declaration must match.", file: specPath, line: 1, column: 1});
  return {compiled, diagnostics};
}

/** The contract's test files that are not next to it. `exists` answers for a path relative to the
 * folder the module's paths are relative to (the project, or the folder `synthesis check` was given). */
export async function missingTests(spec: SpecProgram | undefined, specPath: string, exists: (relative: string) => Promise<boolean>): Promise<SourceDiagnostic[]> {
  const folder = specPath.includes("/") ? specPath.slice(0, specPath.lastIndexOf("/")) : ".";
  const missing: SourceDiagnostic[] = [];
  for (const file of spec ? suiteFiles(spec) : []) {
    const relative = folder === "." ? file : `${folder}/${file}`;
    if (!await exists(relative)) missing.push({severity: "error", code: "SPEC_TEST_MISSING", message: `Test file ${file} was not found next to the contract (${relative}).`, file: specPath, line: 1, column: 1});
  }
  return missing;
}

const CLAUSE = /\[C(\d{1,3})\]/g;
const clausesIn = (text: string) => new Set([...text.matchAll(CLAUSE)].map(match => `C${Number(match[1])}`));
/** The clauses a description numbers as [C1], [C2]…, in order. */
export const contractClauses = (description: string): string[] => [...clausesIn(description)];
/** When the description numbers its clauses ([C1], [C2]…), each should have a test that names it, as
 * in test("[C3] refuses a fractional request"): a clause no test checks is one a run can accept code
 * that ignores. Warnings only: a run still decides by the gates. `tests`: each test file's text. */
export function clauseCoverage(spec: SpecProgram | undefined, specPath: string, tests: Record<string, string>): SourceDiagnostic[] {
  const clauses = spec ? contractClauses(spec.description) : [];
  if (!clauses.length) return [];
  const found: SourceDiagnostic[] = [];
  const named = new Map<string, string[]>();
  for (const [file, text] of Object.entries(tests)) for (const clause of clausesIn(text)) named.set(clause, [...named.get(clause) ?? [], file]);
  for (const clause of clauses) {
    if (!named.has(clause)) found.push({severity: "warning", code: "SPEC_CLAUSE_UNTESTED", message: `No test names clause [${clause}]: name a test after it, such as "[${clause}] …", so a candidate that ignores it fails.`, file: specPath, line: 1, column: 1});
  }
  for (const [clause, files] of named) {
    if (!clauses.includes(clause)) found.push({severity: "warning", code: "SPEC_CLAUSE_UNKNOWN", message: `${files.join(", ")} name${files.length === 1 ? "s" : ""} [${clause}], which the description does not number.`, file: specPath, line: 1, column: 1});
  }
  return found;
}
