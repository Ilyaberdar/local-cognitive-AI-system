import { clauseCoverage, contractClauses, missingTests, SourceDiagnostic, sourceDiagnostics, suiteFiles } from "./check";
import { DIAGNOSTIC_FIXES, EXAMPLES, LANGUAGE_REFERENCE } from "./knowledge/pack.generated";
import { parseSpec } from "./language";
import { isProjectRelative } from "./pathRules";
import { FlowModel, flowTemplate } from "./templates";

// A module drafted by a model from the user's description: the contract and the engineer's tests,
// written as the authoring skill teaches (the same reference and examples), checked as `synthesis
// check` checks, and sent back with the problems until it holds. The flow is not the model's: it is
// derived from the contract's files. Nothing here writes to the project; a draft becomes the user's
// module only when they save it.

export const DRAFT_LANGUAGES = ["TypeScript", "JavaScript", "Python", "Cpp"] as const;
export type DraftLanguage = typeof DRAFT_LANGUAGES[number];
export const MAX_DESCRIPTION_CHARS = 6000;
const MAX_TEST_FILES = 24, MAX_TEST_BYTES = 512 * 1024;

const TEST_RUNNERS: Record<DraftLanguage, string> = {
  TypeScript: "node:test with node:assert/strict, in .ts files that import the module by relative path with its .ts extension (../src/name.ts)",
  JavaScript: "node:test with node:assert/strict, in .mjs files that import the module by relative path (../src/name.mjs)",
  Python: "unittest, in tests/test_*.py files that import the module as a package path (from src.name import thing), for Python 3.9",
  Cpp: "lc_test.hpp (LC_TEST, LC_CHECK, LC_CHECK_EQ, LC_CHECK_NEAR, LC_CHECK_THROWS) in .cpp files that include the module's header"
};
const FENCE: Record<DraftLanguage, string> = {TypeScript: "ts", JavaScript: "js", Python: "python", Cpp: "cpp"};

const example = (language: DraftLanguage) => EXAMPLES.find(item => item.language === (language === "JavaScript" ? "TypeScript" : language))!;
const block = (path: string, fence: string, text: string) => `### ${path}\n\`\`\`${fence}\n${text.replace(/\n$/, "")}\n\`\`\``;

/** What the model is asked: the reference, one complete example in the module's language, the rules
 * of a draft, and the user's description. */
export function draftPrompt(input: {name: string; language: DraftLanguage; output: string; description: string}): {system: string; prompt: string} {
  const sample = example(input.language);
  const fence = FENCE[input.language === "JavaScript" ? "TypeScript" : input.language];
  const system = `You write Local Cognitive Synthesis contracts (.lcspec) and the engineer's tests that decide whether code a model writes later is accepted. You never write the module's implementation.

${LANGUAGE_REFERENCE}

# A complete module in ${sample.language}

${block(`${sample.name}.lcspec`, "lcspec", sample.spec)}

${Object.entries(sample.tests).map(([file, text]) => block(file, fence, text)).join("\n\n")}

# How to answer

- Write the contract and every test file it names, each as a heading with its path and one fenced block, in this order: \`### ${input.name}.lcspec\`, then \`### tests/...\` for each test file. Nothing else: no flow (the app writes it), no implementation, no explanations.
- The contract declares \`module ${input.name} version "1"\`, \`target { language = ${input.language}; }\` and \`evaluate "contract-v1"\`.
- The description is one line of numbered clauses, [C1] [C2] …: the exact public interface (files, names, signatures, types), every behavior, every failure case and the error it raises, and what the code may not use. Each clause is observable and checkable.
- Declare only files the model writes (\`file\`), at most 12, dependencies first, with paths relative to the output folder: never repeat the output folder in them. No \`frozen\` files and no \`files\` areas.
- Gates: \`Exports\` for the public names, \`Imports\` for allowed dependencies, \`Forbid\` where the description bans something (clocks, randomness, I/O, network), and \`Tests\` for behavior. Mark a gate that checks a clause with a comment, such as \`// [C7]\`. Never \`hidden = true\`: sealed tests are the engineer's own.
- Tests use ${TEST_RUNNERS[input.language]}. Name every test after the clauses it checks, such as "[C3] refuses a fractional request" (in Python a docstring, in C++ a comment above LC_TEST), so that every clause is checked by a test or a marked gate. Test the edges a careless implementation gets wrong: empty input, zero, fractions, limits, the exact error type. Tests are deterministic: no network, no real time, no randomness.`;
  const prompt = `Module name: ${input.name}
Language: ${input.language}
Output folder (where the module's files go): ${input.output}

What the module must do, in the user's words:
${input.description.trim()}

Write the contract and its tests.`;
  return {system, prompt};
}

/** The next request after a check found problems: the last answer, each problem with its fix, and the
 * same rules. */
export function repairPrompt(prompt: string, answer: string, problems: SourceDiagnostic[]): string {
  const lines = problems.slice(0, 20).map(item => `- ${item.file ?? ""}:${item.line}:${item.column} ${item.severity} ${item.code}: ${item.message}${DIAGNOSTIC_FIXES[item.code] ? ` Fix: ${DIAGNOSTIC_FIXES[item.code]}` : ""}`);
  return `${prompt}

# Your last answer

${answer.trim()}

# The check found these problems

${lines.join("\n")}

Write the corrected contract and every test file again, complete, in the same format.`;
}

/** The contract and test files of an answer: each `### path` heading followed by one fenced block. A
 * flow, implementation files and anything else are left out and named. */
export function parseDraft(text: string, name: string): {spec?: string; tests: Record<string, string>; ignored: string[]} {
  const tests: Record<string, string> = {}, ignored: string[] = [];
  let spec: string | undefined;
  for (const match of text.matchAll(/^#{1,4}[ \t]*`?([^\n`]+?)`?[ \t]*\n+```[\w+#.-]*[ \t]*\n([\s\S]*?)\n```/gm)) {
    const file = match[1]!.trim(), body = `${match[2]!}\n`;
    if (file === `${name}.lcspec` || (file.endsWith(".lcspec") && spec === undefined)) spec ??= body;
    else if (file.startsWith("tests/") && isProjectRelative(file)) tests[file] = body;
    else ignored.push(file);
  }
  return {spec, tests, ignored};
}

/** The flow a draft runs with: the standard loop over the contract's files, or none while the contract
 * does not parse. */
export function draftFlow(name: string, spec: string, output: string, model: FlowModel): string | undefined {
  const parsed = parseSpec(spec);
  if (!parsed.ast || parsed.diagnostics.some(item => item.severity === "error")) return undefined;
  return flowTemplate(name, parsed.ast.artifacts, {output, model, iterations: parsed.ast.artifacts.length > 1 ? 10 : 6, minutes: parsed.ast.artifacts.length > 1 ? 40 : 20});
}

/** A draft checked as `synthesis check` checks a module, plus what a draft may not be: sealed tests and
 * frozen files (the engineer's own), or test files no gate runs. Paths are where Save will write them. */
export async function checkDraft(input: {name: string; specPath: string; flowPath: string; spec: string; flow?: string; tests: Record<string, string>; output?: string}) {
  const {name, specPath, flowPath} = input;
  const flowSource = input.flow ?? `implement ${name} using "contract-v1" { limit iterations 1, time 1m; policy = "local-files-v1"; return unresolved(); }`;
  const {compiled, diagnostics} = sourceDiagnostics({name, specPath, flowPath, specSource: input.spec, flowSource});
  // While the contract does not parse, the stand-in flow's complaints are about a contract that is not there.
  const found: SourceDiagnostic[] = input.flow ? diagnostics : diagnostics.filter(item => item.file !== flowPath);
  const add = (code: string, message: string, severity: "error" | "warning" = "error") => found.push({severity, code, message, file: specPath, line: 1, column: 1});
  const spec = compiled.spec;
  if (spec) {
    if (spec.frozen.length) add("DRAFT_FROZEN", "A draft declares no frozen files: those are the engineer's, written before a run. Declare only the files the model writes.");
    if (spec.areas.length) add("DRAFT_AREA", "A draft declares no files areas: declare each file the model writes.");
    for (const gate of spec.gates) if (gate.check?.kind === "tests" && gate.check.hidden) add("DRAFT_HIDDEN", `The gate ${gate.id} seals its tests (hidden = true): sealed tests are the engineer's own. Make it a visible Tests gate.`);
    // A small model repeats the output folder in the files' paths, which nests the module in itself.
    const output = input.output?.replace(/\/+$/, "");
    for (const file of output ? spec.artifacts.filter(item => item.startsWith(`${output}/`)) : []) {
      const inside = file.slice(output!.length + 1);
      add("DRAFT_OUTPUT_REPEATED", `${file} repeats the output folder: it would be written to ${output}/${file}. Declare it as "${inside}" (paths in artifacts are relative to the output folder), and import it from tests as ../${inside}.`, "warning");
    }
    const suite = suiteFiles(spec);
    for (const file of Object.keys(input.tests)) if (!suite.includes(file)) add("DRAFT_TEST_UNUSED", `${file} is written, but no gate runs it and the tests section does not name it.`, "warning");
  }
  const folder = specPath.includes("/") ? specPath.slice(0, specPath.lastIndexOf("/") + 1) : "";
  found.push(...await missingTests(spec, specPath, async relative => Object.hasOwn(input.tests, relative.slice(folder.length))));
  const limit = testLimits(input.tests);
  if (limit) add("SPEC_TEST_LIMIT", limit);
  found.push(...clauseCoverage(spec, specPath, input.tests, input.spec));
  return {compiled, diagnostics: found, clauses: spec ? contractClauses(spec.description) : [], valid: !found.some(item => item.severity === "error")};
}

/** Whether a draft's test files are within what a contract may hold. */
export function testLimits(tests: Record<string, string>): string | undefined {
  if (Object.keys(tests).length > MAX_TEST_FILES) return `A draft holds at most ${MAX_TEST_FILES} test files.`;
  if (Object.values(tests).reduce((sum, text) => sum + Buffer.byteLength(text), 0) > MAX_TEST_BYTES) return "A draft's test files hold at most 512 KiB together.";
  return undefined;
}

