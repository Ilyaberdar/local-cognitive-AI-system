import assert from "node:assert/strict";
import test from "node:test";
import { compileProgram, lex, parseFlow, parseSpec, Statement } from "../src/synthesis/language";

const specSource = `module Calculator version "1" {
  target { language = JavaScript; }
  description = "Build a calculator with a working UI.";
  artifacts { file "calculator.js"; file "index.html"; }
  evaluate "calculator-v1" {
    hard arithmetic = Pass("calculator-arithmetic-v1");
    hard ui = Pass("calculator-ui-v1");
  }
}`;
const flowSource = `implement Calculator using "calculator-v1" {
  limit iterations 8, time 10m, cost 0usd;
  policy = "local-files-v1";
  available = await models.list(provider = "llamacpp");
  selected = models.select(available, max_size = 2GiB, prefer = "qwen2.5-1.5b");
  developer = await models.load(selected);
  spec = freeze(Calculator.spec);
  candidate = checkout("calculator");
  feedback = none;
  while (!accepted(candidate, spec)) {
    candidate = await developer.revise(candidate, spec, feedback);
    evidence = await evaluate(candidate, spec);
    verdict = verify(spec, evidence);
    checkpoint(candidate, evidence, verdict);
    if (verdict.status == Pass) { return accept(candidate, evidence); }
    if (verdict.status == Unknown) { return needs_review(evidence); }
    feedback = verdict.violations;
  }
  return unresolved();
}`;
const codes = (spec = specSource, flow = flowSource) => compileProgram(spec, flow).diagnostics.map((item) => item.code);
const wrap = (body: string) => `implement Calculator using "calculator-v1" { limit iterations 4, time 1m; policy = "local-files-v1"; ${body} }`;

test("DSL compiles authored contract and actual imperative local-model repair loop", () => {
  const compiled = compileProgram(specSource, flowSource);
  assert.deepEqual(compiled.diagnostics, []);
  assert.deepEqual(compiled.spec?.artifacts, ["calculator.js", "index.html"]);
  assert.equal(compiled.spec?.target.language, "JavaScript");
  assert.equal(compiled.spec?.gates[0].evaluatorId, "calculator-arithmetic-v1");
  assert.deepEqual(compiled.flow?.limits, { iterations: 8, timeMs: 600_000, costUsd: 0 });
  const loop = compiled.flow?.body.find((statement) => statement.kind === "while");
  assert.equal(loop?.kind, "while");
  assert.equal(loop?.condition.kind, "unary");
  assert.equal(loop?.body[0].kind, "assign");
});

test("lexer preserves comments and locations, normalizes units and decodes string escapes", () => {
  const result = lex('// hello\nlimit time 1.5s; /* there */ "a\\n\\u0042" 2MiB 0usd');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.comments.length, 2);
  assert.deepEqual(result.tokens[0].span.start, { offset: 9, line: 2, column: 1 });
  assert.equal(result.tokens[2].value, 1500);
  assert.equal(result.tokens[2].unit, "s");
  assert.equal(result.tokens.find((token) => token.kind === "string")?.value, "a\nB");
  assert.equal(result.tokens.find((token) => token.unit === "MiB")?.value, 2 * 1024 ** 2);
});

test("parser gives multiplication precedence and short-circuit operators their own AST", () => {
  const parsed = parseFlow(wrap("x = 1 + 2 * 3; okay = x >= 7 && !(x != 7); if (okay) { x = x - 1; } else { x = x + 1; } return unresolved();"));
  assert.deepEqual(parsed.diagnostics, []);
  const assignment = parsed.ast!.body[2];
  assert.equal(assignment.kind, "assign");
  if (assignment.kind !== "assign" || assignment.value.kind !== "binary") assert.fail("Expected binary expression");
  assert.equal(assignment.value.operator, "+");
  assert.equal(assignment.value.right.kind, "binary");
  assert.deepEqual(codes(specSource, wrap("x = 1 + 2 * 3; okay = x >= 7 && !(x != 7); if (okay) { x = x - 1; } else { x = x + 1; } return unresolved();")), []);
});

test("spec parser retains Unreal domain source, compiler refuses unimplemented acceptance semantics", () => {
  const source = `module AbilitySystem version "1" {
    target { engine = UnrealEngine; language = Cpp; multiplayer = true; }
    interface { ActivateAbility(handle: AbilityHandle) -> ActivationResult; }
    behavior { activation { requires = AbilityGranted; on_failure = StateUnchanged; } }
    invariants { "ability.cost_once" { SuccessfulActivation(a) implies CostApplications(a) <= 1; } }
    architecture { hard "single_authority" { client cannot commit authoritative gameplay state; } }
    evaluate "ability-system-v1" { hard authority = Pass("server-authority-v1"); }
  }`;
  const parsed = parseSpec(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.ast?.sections.map((section) => section.name), ["interface", "behavior", "invariants", "architecture"]);
  assert.ok(parsed.ast?.sections[2].source.includes("CostApplications(a) <= 1"));
  const result = compileProgram(source, `implement AbilitySystem using "ability-system-v1" { limit iterations 2, time 1m; return unresolved(); }`);
  assert.equal(result.diagnostics.filter((item) => item.code === "SPEC_UNSUPPORTED_SECTION").length, 4);
  assert.ok(result.diagnostics.some((item) => item.code === "SPEC_UNSUPPORTED_TARGET"));
});

test("compiler requires bounded iterations and finite time and validates units", () => {
  assert.ok(codes(specSource, flowSource.replace("limit iterations 8, time 10m, cost 0usd;", "")).includes("FLOW_ITERATION_LIMIT"));
  assert.ok(codes(specSource, flowSource.replace("time 10m", "time 0ms")).includes("FLOW_TIME_LIMIT"));
  assert.ok(codes(specSource, flowSource.replace("iterations 8", "iterations 1.5")).includes("FLOW_ITERATION_LIMIT"));
  assert.ok(codes(specSource, flowSource.replace("time 10m", "time 3MiB")).includes("FLOW_LIMIT_UNIT"));
  assert.ok(codes(specSource, flowSource.replace("time 10m", "time 1e999m")).includes("LEX_NUMBER"));
  assert.ok(codes(specSource, flowSource.replace("2GiB", "2GB")).includes("LEX_UNIT"));
  assert.ok(codes(specSource, wrap("if (true) { limit iterations 2, time 1s; } return unresolved();")).includes("FLOW_LIMIT_SCOPE"));
});

test("variable assignment and branch analysis catch undefined names", () => {
  assert.ok(codes(specSource, flowSource.replace("models.load(selected)", "models.load(missing)")).includes("FLOW_UNDEFINED_NAME"));
  assert.ok(codes(specSource, wrap("if (true) { value = 1; } checkpoint(value); return unresolved();")).includes("FLOW_UNDEFINED_NAME"));
  assert.deepEqual(codes(specSource, wrap("if (true) { value = 1; } else { value = 2; } checkpoint(value); return unresolved();")), []);
  assert.ok(codes(specSource, wrap("while (true) { value = 1; } checkpoint(value); return unresolved();")).includes("FLOW_UNDEFINED_NAME"));
  assert.ok(codes(specSource, wrap("continue; return unresolved();")).includes("FLOW_CONTINUE"));
});

test("typed intrinsics reject arbitrary host execution, bad arguments and missing await", () => {
  assert.ok(codes(specSource, wrap('result = eval("process.exit()"); return unresolved();')).includes("FLOW_UNKNOWN_CALL"));
  assert.ok(codes(specSource, wrap('result = process.exit(); return unresolved();')).includes("FLOW_UNKNOWN_CALL"));
  assert.ok(codes(specSource, wrap('x = "text"; x.constructor(); return unresolved();')).includes("FLOW_UNKNOWN_CALL"));
  assert.ok(codes(specSource, flowSource.replace("await models.load(selected)", "models.load(selected)")).includes("FLOW_AWAIT_REQUIRED"));
  assert.ok(codes(specSource, flowSource.replace("max_size = 2GiB", "max_size = 10ms")).includes("FLOW_TYPE"));
  assert.ok(codes(specSource, flowSource.replace("max_size = 2GiB", "maximum = 2GiB")).includes("FLOW_NAMED_ARGUMENT"));
  assert.ok(codes(specSource, flowSource.replace("max_size = 2GiB", "__proto__ = 2GiB")).includes("FLOW_NAMED_ARGUMENT"));
  assert.ok(codes(specSource, flowSource.replace("models.load(selected)", "models.load(selected, selected)")).includes("FLOW_ARGUMENT_COUNT"));
  assert.ok(codes(specSource, flowSource.replace("verify(spec, evidence)", "verify(spec, candidate)")).includes("FLOW_TYPE"));
});

test("acceptance must be guarded by a verifier verdict, not arbitrary booleans or reviewer data", () => {
  assert.ok(codes(specSource, flowSource.replace("if (verdict.status == Pass)", "if (true)")).includes("FLOW_ACCEPT_GUARD"));
  assert.ok(codes(specSource, flowSource.replace("verdict.status == Pass", "verdict.status == Unknown")).includes("FLOW_ACCEPT_GUARD"));
  assert.ok(codes(specSource, flowSource.replace("verdict.status == Pass", "verdict.status == Pass || true")).includes("FLOW_ACCEPT_GUARD"));
  assert.deepEqual(codes(specSource, flowSource.replace("verdict.status == Pass", "verdict.status == Pass && true")), []);
  assert.deepEqual(codes(specSource, flowSource.replace("verdict.status == Pass", "Pass == verdict.status")), []);
  assert.ok(codes(specSource, wrap("Pass = true; return unresolved();")).includes("FLOW_RESERVED_NAME"));
});

test("module/evaluator mismatches and duplicate contracts cannot be compiled silently", () => {
  assert.ok(codes(specSource, flowSource.replace("implement Calculator", "implement Other")).includes("FLOW_MODULE"));
  assert.ok(codes(specSource, flowSource.replace('using "calculator-v1"', 'using "other"')).includes("FLOW_EVALUATOR"));
  assert.ok(codes(specSource.replace("hard ui", "hard arithmetic")).includes("SPEC_DUPLICATE_GATE"));
  assert.ok(codes(specSource.replace("hard arithmetic", "soft arithmetic").replace("hard ui", "soft ui")).includes("SPEC_HARD_GATE"));
  assert.ok(codes(specSource.replace('file "index.html"', 'file "../outside.txt"')).includes("SPEC_ARTIFACT_PATH"));
});

test("malformed syntax has actionable path, line and column diagnostics", () => {
  const result = compileProgram(specSource, flowSource.replace("feedback = none;", "feedback = ;"), { flowPath: "Synthesis/Calculator/Calculator.lcflow" });
  const syntax = result.diagnostics.find((diagnostic) => diagnostic.code === "PARSE_SYNTAX");
  assert.equal(syntax?.path, "Synthesis/Calculator/Calculator.lcflow");
  assert.ok(syntax!.span.start.line > 1);
  assert.ok(syntax!.span.start.column > 1);
  assert.match(syntax!.message, /expression/);
  assert.ok(lex('"unterminated').diagnostics.some((item) => item.code === "LEX_UNTERMINATED_STRING"));
  assert.ok(lex("/* unterminated").diagnostics.some((item) => item.code === "LEX_UNTERMINATED_COMMENT"));
});

test("data arrays, comments and keywords inside strings do not confuse the parser", () => {
  const flow = wrap(`/* if (false) { */
    paths = ["if", "}", "Source/Game/Character",];
    context = inspect(paths);
    // while (true) {}
    return unresolved("the word while is text");
  `);
  const result = compileProgram(specSource, flow);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.flow?.comments.length, 2);
});

test("unit arithmetic rejects crossing dimensions", () => {
  assert.ok(codes(specSource, wrap("valid = 10ms < 2GiB; return unresolved();")).includes("FLOW_TYPE"));
  assert.ok(codes(specSource, wrap("value = 10ms + 2GiB; return unresolved();")).includes("FLOW_TYPE"));
  assert.deepEqual(codes(specSource, wrap("value = 10ms + 1s; valid = value < 2s; return unresolved();")), []);
});

test("syntax resource limits fail with diagnostics instead of overflowing the host stack", () => {
  assert.ok(parseFlow(" ".repeat(256 * 1024 + 1)).diagnostics.some((item) => item.code === "SOURCE_TOO_LARGE"));
  assert.ok(parseFlow(wrap(`x = ${"(".repeat(150)}1${")".repeat(150)};`)).diagnostics.some((item) => item.code === "PARSE_SYNTAX"));
  assert.ok(parseFlow(wrap(`x = ${"1 + ".repeat(150)}1;`)).diagnostics.some((item) => item.code === "PARSE_SYNTAX"));
  assert.ok(parseFlow(wrap("x = 1;".repeat(5000))).diagnostics.some((item) => item.code === "LEX_TOKEN_LIMIT"));
});

test("source spans track the executed statements and nested flow steps", () => {
  const parsed = parseFlow(flowSource);
  const sourceFor = (statement: Statement) => flowSource.slice(statement.span.start.offset, statement.span.end.offset);
  const loop = parsed.ast!.body.find((statement) => statement.kind === "while")!;
  assert.match(sourceFor(loop), /^while \(!accepted/);
  assert.equal(loop.kind, "while");
  if (loop.kind === "while") assert.match(sourceFor(loop.body[0]), /^candidate = await developer\.revise/);
});

test("compiler aligns model fields, explicit file revisions and policy with runtime capabilities", () => {
  assert.deepEqual(codes(specSource, flowSource.replace("developer = await models.load(selected);", "checkpoint(selected.id, selected.displayName, selected.sizeBytes, selected.providerId); developer = await models.load(selected);").replace("developer.revise(candidate, spec, feedback)", "developer.revise(candidate, spec, feedback, file = \"calculator.js\")")), []);
  assert.ok(codes(specSource, flowSource.replace("models.load(selected)", "models.load(\"model-id\")")).includes("FLOW_TYPE"));
  assert.ok(codes(specSource, flowSource.replace('policy = "local-files-v1";', 'policy = "anything-goes";')).includes("FLOW_POLICY"));
  assert.ok(codes(specSource, flowSource.replace('policy = "local-files-v1";', '')).includes("FLOW_POLICY"));
});

test("terminal result actions are allowed only as direct return expressions", () => {
  for (const replacement of [
    "accept(candidate, evidence); return unresolved();",
    "saved = accept(candidate, evidence); return saved;",
    "checkpoint(accept(candidate, evidence)); return unresolved();",
    "return await accept(candidate, evidence);"
  ]) assert.ok(codes(specSource, flowSource.replace("return accept(candidate, evidence);", replacement)).includes("FLOW_TERMINAL_RETURN"));
  assert.ok(codes(specSource, wrap("unresolved(); return unresolved();")).includes("FLOW_TERMINAL_RETURN"));
  assert.ok(codes(specSource, flowSource.replace("return needs_review(evidence);", "needs_review(evidence); return unresolved();")).includes("FLOW_TERMINAL_RETURN"));
});

test("review notes have a distinct type and unsupported evidence/feedback members fail compilation", () => {
  assert.deepEqual(codes(specSource, flowSource.replace("feedback = verdict.violations;", "review = await developer.inspect(candidate, evidence); feedback = merge(verdict.violations, review.notes);")), []);
  assert.ok(codes(specSource, flowSource.replace("feedback = verdict.violations;", "feedback = evidence.violations;")).includes("FLOW_MEMBER"));
  assert.ok(codes(specSource, flowSource.replace("feedback = verdict.violations;", "feedback = merge(verdict.violations); checkpoint(feedback.notes);")).includes("FLOW_MEMBER"));
});

test("per-file source generation accepts typed format and focused instruction arguments", () => {
  const flow = flowSource.replace("developer.revise(candidate, spec, feedback)", "developer.revise(candidate, spec, feedback, file = \"calculator.js\", format = \"source\", instruction = \"Implement arithmetic only.\")");
  assert.deepEqual(codes(specSource, flow), []);
  assert.ok(codes(specSource, flow.replace('format = "source"', "format = 1")).includes("FLOW_TYPE"));
  assert.ok(codes(specSource, flow.replace('instruction = "Implement arithmetic only."', "instruction = true")).includes("FLOW_TYPE"));
});
