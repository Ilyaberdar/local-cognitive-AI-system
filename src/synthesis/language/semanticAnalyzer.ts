import {
  CallExpression, CompileOptions, ContractCheck, Diagnostic, Expression, FlowProgram, SourceSpan, SpecProgram, Statement
} from "./types";
import { matchesGlob as globMatch } from "../checks/architecture";

/** "array" holds values of unknown types; `array:T` only values of type T (`array:none`: an empty literal). */
type ValueType = "string" | "number" | "boolean" | "none" | "duration" | "bytes" | "cost" |
  "array" | `array:${string}` | "modelList" | "selectedModel" | "model" | "module" | "specRef" | "frozenSpec" |
  "candidate" | "evidence" | "verdict" | "status" | "feedback" | "review" | "design" | "tests" | "context" | "result" |
  "permission" | "agent" | "taskResult" | "unknown";
const isArray = (type: ValueType) => type === "array" || type === "modelList" || type.startsWith("array:");
/** The type of an array's elements: what `list[i]` and `for (item in list)` give. */
const elementOf = (type: ValueType): ValueType => type === "modelList" ? "selectedModel" : type.startsWith("array:") ? type.slice(6) as ValueType : "unknown";
const arrayOf = (type: ValueType): ValueType => type === "unknown" ? "array" : `array:${type}`;
interface FunctionDefinition {
  returns: ValueType;
  required: number;
  max: number;
  parameters?: ValueType[][];
  named?: Record<string, ValueType[]>;
  async?: boolean;
}
const FUNCTIONS: Record<string, FunctionDefinition> = {
  "models.list": { returns: "modelList", required: 0, max: 0, named: { provider: ["string"] }, async: true },
  "models.select": { returns: "selectedModel", required: 1, max: 1, parameters: [["modelList"]], named: { max_size: ["bytes"], prefer: ["string"], provider: ["string"], id: ["string"] } },
  "models.load": { returns: "model", required: 1, max: 1, parameters: [["selectedModel"]], async: true },
  model: { returns: "model", required: 1, max: 1, parameters: [["string"]], named: { provider: ["string"] } },
  freeze: { returns: "frozenSpec", required: 1, max: 1, parameters: [["specRef"]] },
  checkout: { returns: "candidate", required: 1, max: 1, parameters: [["string"]] },
  inspect: { returns: "context", required: 1, max: 1, parameters: [["array"]] },
  accepted: { returns: "boolean", required: 2, max: 2, parameters: [["candidate"], ["frozenSpec"]] },
  evaluate: { returns: "evidence", required: 2, max: 3, parameters: [["candidate"], ["frozenSpec"], ["tests"]], named: { supplemental: ["tests"] }, async: true },
  verify: { returns: "verdict", required: 2, max: 2, parameters: [["frozenSpec"], ["evidence"]] },
  checkpoint: { returns: "none", required: 1, max: 8 },
  accept: { returns: "result", required: 2, max: 2, parameters: [["candidate"], ["evidence"]] },
  needs_review: { returns: "result", required: 1, max: 1, parameters: [["evidence"]] },
  unresolved: { returns: "result", required: 0, max: 1, parameters: [["string"]] },
  merge: { returns: "feedback", required: 1, max: 8 },
  stagnant: { returns: "boolean", required: 1, max: 1, parameters: [["number"]] },
  // Computed by the interpreter itself: no runtime action, no event.
  range: { returns: "array:number", required: 1, max: 1, parameters: [["number"]] },
  append: { returns: "array", required: 2, max: 2, parameters: [["array"]] },
  // agents-v1: agents with file rights, run in parallel.
  "files.read": { returns: "permission", required: 1, max: 12, parameters: Array(12).fill(["string"]) },
  "files.write": { returns: "permission", required: 1, max: 12, parameters: Array(12).fill(["string"]) },
  "files.delete": { returns: "permission", required: 1, max: 12, parameters: Array(12).fill(["string"]) },
  agent: { returns: "agent", required: 0, max: 1, parameters: [["model"]], named: { provider: ["string"], model: ["string"], tools: ["array:permission"], instructions: ["string"], steps: ["number"] } },
  parallel_map: { returns: "array:taskResult", required: 2, max: 2, parameters: [["agent", "array:agent"], ["array:string"]], named: { concurrency: ["number"], on_error: ["string"] }, async: true }
};
/** What only agents-v1 may use. */
const AGENT_CALLS = new Set(["files.read", "files.write", "files.delete", "agent", "parallel_map"]);
const AGENT_METHODS = new Set(["split", "synthesize"]);
const METHODS: Record<string, FunctionDefinition> = {
  revise: { returns: "candidate", required: 2, max: 4, parameters: [["candidate"], ["frozenSpec"]], named: { file: ["string"], format: ["string"], instruction: ["string"] }, async: true },
  propose: { returns: "design", required: 1, max: 2, parameters: [["frozenSpec"], ["context"]], async: true },
  inspect: { returns: "review", required: 2, max: 3, parameters: [["candidate"]], async: true },
  propose_tests: { returns: "tests", required: 1, max: 2, parameters: [["frozenSpec"], ["candidate"]], async: true },
  reconsider: { returns: "design", required: 2, max: 4, parameters: [["frozenSpec"], ["design"]], async: true },
  split: { returns: "array:string", required: 2, max: 3, parameters: [["string"], ["number"], ["context"]], named: { paths: ["permission"], instruction: ["string"] }, async: true },
  synthesize: { returns: "candidate", required: 3, max: 3, parameters: [["candidate"], ["frozenSpec"], ["array:taskResult"]], named: { file: ["string"], instruction: ["string"] }, async: true }
};
const STATUSES = new Set(["Pass", "Fail", "Unknown", "Blocked", "Unresolved", "NeedsReview"]);
/** What a run may use: local llama.cpp models only, also cloud models by API key, also agents. */
export const POLICIES = ["local-files-v1", "cloud-files-v1", "agents-v1"] as const;
const POLICY_LIST = POLICIES.map((policy) => `"${policy}"`).join(", ");
/** Calls that name a provider: the flow states it literally, so where data goes is known before Run. */
const PROVIDER_CALLS = new Set(["models.list", "models.select", "model", "agent"]);
const FORBIDDEN_MEMBERS = new Set(["__proto__", "prototype", "constructor"]);

/** The providers a flow names (provider = "..."), each with where it is named. */
export function namedProviders(flow: FlowProgram): Array<{ provider: string; span: SourceSpan }> {
  const found: Array<{ provider: string; span: SourceSpan }> = [];
  const pending: Array<Statement | Expression> = [...flow.body];
  while (pending.length) {
    const node = pending.pop()!;
    switch (node.kind) {
      case "assign": pending.push(node.value); break;
      case "expression": case "await": pending.push(node.expression); break;
      case "if": pending.push(node.condition, ...node.then, ...node.else); break;
      case "while": pending.push(node.condition, ...node.body); break;
      case "for": pending.push(node.iterable, ...node.body); break;
      case "index": pending.push(node.object, node.index); break;
      case "return": if (node.value) pending.push(node.value); break;
      case "array": pending.push(...node.items); break;
      case "member": pending.push(node.object); break;
      case "unary": pending.push(node.operand); break;
      case "binary": pending.push(node.left, node.right); break;
      case "call": {
        for (const arg of node.args) {
          if (arg.name === "provider" && arg.value.kind === "literal" && typeof arg.value.value === "string") found.push({ provider: arg.value.value, span: arg.value.span });
          pending.push(arg.value);
        }
        pending.push(node.callee);
        break;
      }
    }
  }
  return found.sort((a, b) => a.span.start.offset - b.span.start.offset);
}

/** Resolve only named language intrinsics, never arbitrary host object methods. */
export function callName(expression: Expression): string | undefined {
  if (expression.kind === "identifier") return expression.name;
  if (expression.kind === "member") {
    const parent = callName(expression.object);
    return parent ? `${parent}.${expression.property}` : undefined;
  }
  return undefined;
}

export function analyzeSpec(spec: SpecProgram, options: CompileOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, message: string, span = spec.span) => diagnostics.push({ severity: "error" as const, code, message, span, path: options.specPath });
  if (!spec.version.trim()) error("SPEC_VERSION", "A module version must not be empty.");
  if (!spec.evaluator) error("SPEC_EVALUATOR", "Declare an evaluate group for acceptance.");
  if (!spec.gates.some((gate) => gate.severity === "hard")) error("SPEC_HARD_GATE", "Acceptance requires at least one hard evaluator gate.");
  const gates = new Set<string>();
  for (const gate of spec.gates) {
    if (gates.has(gate.id)) error("SPEC_DUPLICATE_GATE", `Duplicate gate '${gate.id}'.`, gate.span);
    gates.add(gate.id);
    if (!gate.evaluatorId.trim()) error("SPEC_EVALUATOR_ID", "Evaluator IDs must not be empty.", gate.span);
  }
  const normalized = (file: string) => !!file && !file.startsWith("/") && !file.includes("\\") && !file.includes(":") && !file.split("/").some((part) => ["", ".", ".."].includes(part));
  // Artifacts and frozen files share the checkout folder, and the test files join them in one folder
  // when the tests run: a path may appear only once across the three.
  const paths = new Map<string, string>();
  const claim = (file: string, kind: string, code: string) => {
    if (!normalized(file)) error(code, `${kind} '${file}' must be a normalized relative file path.`);
    const previous = paths.get(file);
    if (previous) error(previous === kind ? "SPEC_DUPLICATE_ARTIFACT" : "SPEC_PATH_CONFLICT", previous === kind ? `Duplicate ${kind.toLowerCase()} '${file}'.` : `'${file}' is both ${previous.toLowerCase()} and ${kind.toLowerCase()}: each path may appear once.`);
    else paths.set(file, kind);
  };
  for (const file of spec.artifacts) claim(file, "Artifact", "SPEC_ARTIFACT_PATH");
  for (const area of spec.areas ?? []) if (!filePattern(area)) error("SPEC_ARTIFACT_PATH", `files '${area}' must be a relative pattern such as "notes/**" or "notes/*.md", without hidden folders or "..".`);
  for (const file of spec.frozen ?? []) claim(file, "Frozen file", "SPEC_ARTIFACT_PATH");
  const suite = new Set(spec.tests ?? []);
  for (const gate of spec.gates) if (gate.check?.kind === "tests") gate.check.files.forEach((file) => suite.add(file));
  for (const file of suite) claim(file, "Test file", "SPEC_TEST_PATH");
  for (const gate of spec.gates) if (gate.check) checkGate(gate.check, gate.span);

  const supported = new Set(options.supportedSpecSections ?? []);
  for (const section of spec.sections) {
    if (!supported.has(section.name)) error("SPEC_UNSUPPORTED_SECTION", `Section '${section.name}' is preserved as source, but requires a trusted evaluator adapter before it can be accepted.`, section.span);
  }
  // Target metadata must also be honored: accepting engine/platform claims without an adapter is misleading.
  for (const [key, value] of Object.entries(spec.target)) {
    if (key === "language" && TARGET_LANGUAGES.has(String(value))) continue;
    if (supported.has(`target.${key}`)) continue;
    error("SPEC_UNSUPPORTED_TARGET", key === "language"
      ? `Target language '${String(value)}' is not supported: use JavaScript, TypeScript, Python or Cpp.`
      : `Target '${key} = ${String(value)}' requires a registered target adapter.`);
  }
  return diagnostics;

  function checkGate(check: ContractCheck, span: SourceSpan): void {
    const artifact = (file: string) => spec.artifacts.includes(file) || (spec.frozen ?? []).includes(file);
    switch (check.kind) {
      case "tests": {
        const runners = new Set(check.files.map(testRunner));
        if (runners.has(undefined)) error("SPEC_TEST_TYPE", "Test files run as .ts/.mts/.js/.mjs/.cjs (Node.js), .py (Python) or .cpp/.cc/.cxx (C++).", span);
        else if (runners.size > 1) error("SPEC_TEST_TYPE", "One Tests gate runs files of one language; split them into several gates.", span);
        if (check.timeoutMs !== undefined && (check.timeoutMs < 1000 || check.timeoutMs > 120000)) error("SPEC_TEST_TIMEOUT", "Tests timeout must be between 1s and 120s.", span);
        break;
      }
      case "exports":
        if (!artifact(check.file)) error("SPEC_CHECK_FILE", `Exports names '${check.file}', which is neither an artifact nor a frozen file.`, span);
        for (const symbol of check.symbols) if (!/^[A-Za-z_$][A-Za-z0-9_$]*(::[A-Za-z_][A-Za-z0-9_]*)*$/.test(symbol)) error("SPEC_CHECK_SYMBOL", `'${symbol}' is not a symbol name.`, span);
        break;
      case "imports":
        if (!check.pattern || [...check.allow, ...check.deny].some((item) => !item || item.length > 200)) error("SPEC_CHECK_PATTERN", "Imports patterns must be non-empty, at most 200 characters.", span);
        break;
      case "grounded":
        if (!spec.artifacts.includes(check.file) && !(spec.areas ?? []).some((area) => globMatch(check.file, area))) error("SPEC_CHECK_FILE", `Grounded names '${check.file}', which is not a file of the candidate (an artifact or in a files area).`, span);
        break;
      case "forbid":
        if (!check.pattern) error("SPEC_CHECK_PATTERN", "Forbid needs a file pattern.", span);
        if (!check.regex || check.regex.length > 300) error("SPEC_CHECK_PATTERN", "Forbid's pattern must be 1–300 characters.", span);
        else try { new RegExp(check.regex, "gm"); } catch (failure) { error("SPEC_CHECK_PATTERN", `Forbid's pattern is not a valid regular expression: ${(failure as Error).message}`, span); }
        if ((check.message?.length ?? 0) > 200) error("SPEC_CHECK_PATTERN", "Forbid's message must be at most 200 characters.", span);
        break;
    }
  }
}

/** A project-relative path pattern: segments of letters, digits, _ - . and the wildcards * and **. */
export function filePattern(pattern: string): boolean {
  return !!pattern && pattern.length <= 240 && pattern.split("/").every((part) => part === "**" || (/^[A-Za-z0-9_*-][A-Za-z0-9_.*-]*$/.test(part) && part !== "node_modules" && !part.includes("**")));
}
const TARGET_LANGUAGES = new Set(["JavaScript", "Javascript", "JS", "TypeScript", "Typescript", "TS", "Python", "Cpp", "CPP"]);
/** Which runner a test file needs, by its extension. */
export function testRunner(file: string): "node" | "python" | "cpp" | undefined {
  if (/\.(?:ts|mts|js|mjs|cjs)$/.test(file)) return "node";
  if (/\.py$/.test(file)) return "python";
  if (/\.(?:cpp|cc|cxx)$/.test(file)) return "cpp";
  return undefined;
}

export function analyzeFlow(flow: FlowProgram, spec: SpecProgram | undefined, options: CompileOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, message: string, span: SourceSpan) => diagnostics.push({ severity: "error" as const, code, message, span, path: options.flowPath });
  if (spec && flow.module !== spec.module) error("FLOW_MODULE", `Flow implements '${flow.module}', but the contract declares '${spec.module}'.`, flow.span);
  if (spec && flow.evaluator !== spec.evaluator) error("FLOW_EVALUATOR", `Flow evaluator '${flow.evaluator}' does not match '${spec.evaluator}'.`, flow.span);
  if (!Number.isSafeInteger(flow.limits.iterations) || flow.limits.iterations < 1) error("FLOW_ITERATION_LIMIT", "Declare a positive finite integer iteration limit.", flow.span);
  if (!Number.isFinite(flow.limits.timeMs) || flow.limits.timeMs <= 0) error("FLOW_TIME_LIMIT", "Declare a positive finite time limit.", flow.span);
  if (flow.limits.costUsd !== undefined && (!Number.isFinite(flow.limits.costUsd) || flow.limits.costUsd < 0)) error("FLOW_COST_LIMIT", "Cost must be finite and non-negative.", flow.span);
  if (flow.limits.steps !== undefined && (!Number.isSafeInteger(flow.limits.steps) || flow.limits.steps < 1)) error("FLOW_STEP_LIMIT", "Steps must be a positive whole number.", flow.span);
  if (flow.body.filter((statement) => statement.kind === "limit").length > 1) error("FLOW_DUPLICATE_LIMIT", "Declare budgets once at the top level.", flow.span);
  const policies = flow.body.filter((statement) => statement.kind === "assign" && statement.name === "policy");
  if (policies.length !== 1) error("FLOW_POLICY", `Declare exactly one top-level policy: ${POLICY_LIST}.`, flow.span);
  const policy = flow.policy;

  type Symbols = Map<string, ValueType>;
  const numeric = (type: ValueType) => ["number", "duration", "bytes", "cost"].includes(type);
  const compatible = (actual: ValueType, wanted: ValueType[]) => actual === "unknown" || wanted.includes(actual) ||
    // Any array where an array is wanted; an empty or untyped array where a typed one is.
    (isArray(actual) && wanted.some((type) => type === "array" || (type.startsWith("array:") && ["array", "array:none"].includes(actual))));
  /** Whether a variable of one type may be assigned the other: the same type, or an array whose element type becomes known. */
  const assignable = (previous: ValueType, next: ValueType) => previous === next || ["none", "unknown"].includes(previous) || ["none", "unknown"].includes(next) ||
    (isArray(previous) && isArray(next) && [previous, next].some((type) => type === "array" || type === "array:none"));
  function infer(expression: Expression, symbols: Symbols, passGuard: boolean, awaited = false, terminalReturn = false): ValueType {
    switch (expression.kind) {
      case "literal": {
        if (expression.value === null) return "none";
        if (typeof expression.value === "string") return "string";
        if (typeof expression.value === "boolean") return "boolean";
        if (!expression.unit) return "number";
        if (["ms", "s", "m", "h"].includes(expression.unit)) return "duration";
        if (["B", "KiB", "MiB", "GiB"].includes(expression.unit)) return "bytes";
        return "cost";
      }
      case "identifier": {
        if (STATUSES.has(expression.name)) return "status";
        if (expression.name === flow.module) return "module";
        const known = symbols.get(expression.name);
        if (!known) error("FLOW_UNDEFINED_NAME", `Variable '${expression.name}' has not been assigned on every path.`, expression.span);
        return known ?? "unknown";
      }
      case "array": {
        const types = new Set(expression.items.map((item) => infer(item, symbols, passGuard)));
        if (!types.size) return "array:none";
        return types.size === 1 ? arrayOf([...types][0]) : "array";
      }
      case "index": {
        const object = infer(expression.object, symbols, passGuard);
        const index = infer(expression.index, symbols, passGuard);
        if (!compatible(index, ["number"])) error("FLOW_INDEX", "An index is a whole number: list[0].", expression.index.span);
        if (!isArray(object)) { if (object !== "unknown") error("FLOW_INDEX", `Type '${object}' cannot be indexed; only lists can.`, expression.span); return "unknown"; }
        return elementOf(object);
      }
      case "member": {
        const object = infer(expression.object, symbols, passGuard);
        if (FORBIDDEN_MEMBERS.has(expression.property)) error("FLOW_MEMBER", `Member '${expression.property}' is not accessible in LC Flow.`, expression.span);
        const fields: Partial<Record<ValueType, Record<string, ValueType>>> = {
          module: { spec: "specRef" }, verdict: { status: "status", violations: "feedback" },
          evidence: { status: "status" }, review: { notes: "feedback", violations: "feedback" },
          selectedModel: { id: "string", displayName: "string", sizeBytes: "bytes", providerId: "string" },
          candidate: { id: "string", path: "string", hash: "string" }, array: { length: "number" }, modelList: { length: "number" },
          taskResult: { ok: "boolean", output: "string", error: "string", task: "string", files: "array:string", index: "number" },
          "array:taskResult": { length: "number", completed: "number", failed: "number" }
        };
        const objectFields = fields[object] ?? (isArray(object) ? fields.array : undefined);
        if (objectFields && Object.hasOwn(objectFields, expression.property)) return objectFields[expression.property];
        if (object !== "unknown") error("FLOW_MEMBER", `Type '${object}' has no supported member '${expression.property}'.`, expression.span);
        return "unknown";
      }
      case "await": {
        if (expression.expression.kind !== "call") error("FLOW_AWAIT", "await must wrap a runtime action call.", expression.span);
        return infer(expression.expression, symbols, passGuard, true);
      }
      case "unary": {
        const operand = infer(expression.operand, symbols, passGuard);
        if (expression.operator === "!") {
          if (!compatible(operand, ["boolean"])) error("FLOW_TYPE", "Logical negation requires a boolean.", expression.span);
          return "boolean";
        }
        if (!numeric(operand) && operand !== "unknown") error("FLOW_TYPE", "Numeric negation requires a number or quantity.", expression.span);
        return operand;
      }
      case "binary": {
        const left = infer(expression.left, symbols, passGuard);
        const right = infer(expression.right, symbols, passGuard);
        if (["&&", "||"].includes(expression.operator)) {
          if (!compatible(left, ["boolean"]) || !compatible(right, ["boolean"])) error("FLOW_TYPE", "Logical operators require booleans.", expression.span);
          return "boolean";
        }
        if (["==", "!=", "<", "<=", ">", ">="].includes(expression.operator)) {
          if (left !== right && left !== "unknown" && right !== "unknown" && left !== "none" && right !== "none") error("FLOW_TYPE", `Cannot compare '${left}' with '${right}'.`, expression.span);
          if (!["==", "!="].includes(expression.operator) && (!numeric(left) || !numeric(right))) error("FLOW_TYPE", "Ordered comparisons require matching numeric quantities.", expression.span);
          return "boolean";
        }
        if (expression.operator === "+" && left === "string" && right === "string") return "string";
        if (!numeric(left) || !numeric(right) || (left !== right && !(["*", "/"].includes(expression.operator) && right === "number"))) error("FLOW_TYPE", "Arithmetic requires compatible numeric quantities.", expression.span);
        return left;
      }
      case "call": return inferCall(expression, symbols, passGuard, awaited, terminalReturn);
    }
  }

  function inferCall(call: CallExpression, symbols: Symbols, passGuard: boolean, awaited: boolean, terminalReturn: boolean): ValueType {
    const name = callName(call.callee);
    let signature = name && Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
    if (!signature && call.callee.kind === "member" && Object.hasOwn(METHODS, call.callee.property)) {
      const receiver = infer(call.callee.object, symbols, passGuard);
      if (receiver === "model") signature = METHODS[call.callee.property];
    }
    if (!signature) error("FLOW_UNKNOWN_CALL", `Unsupported action '${name ?? "expression"}'. Calls must resolve to registered runtime actions or model role methods.`, call.span);
    const agentCall = AGENT_CALLS.has(name ?? "") || (!!signature && call.callee.kind === "member" && AGENT_METHODS.has(call.callee.property) && !Object.hasOwn(FUNCTIONS, name ?? ""));
    if (agentCall && policy !== "agents-v1") error("FLOW_POLICY_CAPABILITY", `'${name}' needs policy = "agents-v1".`, call.span);
    if (name?.startsWith("files.")) for (const arg of call.args) {
      if (arg.value.kind === "literal" && typeof arg.value.value === "string" && !filePattern(arg.value.value)) error("FLOW_FILE_PATTERN", `'${arg.value.value}' is not a project-relative pattern: use forms such as "src/**", "docs/*.md" or "review/notes/**", without hidden folders or "..".`, arg.value.span);
    }
    if (name === "agent") {
      const role = call.args.some((arg) => !arg.name), provider = call.args.some((arg) => arg.name === "provider"), model = call.args.some((arg) => arg.name === "model");
      if (role ? provider || model : !(provider && model)) error("FLOW_AGENT_MODEL", "An agent names its model once: agent(role, tools = [...]) with a loaded role, or agent(provider = \"...\", model = \"...\", tools = [...]).", call.span);
    }
    if (name === "parallel_map") {
      const onError = call.args.find((arg) => arg.name === "on_error")?.value;
      if (onError && !(onError.kind === "literal" && (onError.value === "collect" || onError.value === "fail"))) error("FLOW_TYPE", "on_error is \"collect\" (every task runs; failures are results) or \"fail\" (the first failure stops the others).", onError.span);
    }
    if (signature?.async && !awaited) error("FLOW_AWAIT_REQUIRED", `Action '${name}' requires await.`, call.span);
    if (["accept", "needs_review", "unresolved"].includes(name ?? "") && !terminalReturn) error("FLOW_TERMINAL_RETURN", `Terminal action '${name}' must be the direct expression of a return statement.`, call.span);
    if (name === "accept" && !passGuard) error("FLOW_ACCEPT_GUARD", "accept() must be inside a branch guarded by a verified verdict.status == Pass.", call.span);
    const provider = PROVIDER_CALLS.has(name ?? "") ? call.args.find((arg) => arg.name === "provider")?.value : undefined;
    if (provider) {
      const literal = provider.kind === "literal" && typeof provider.value === "string" ? provider.value : undefined;
      if (literal === undefined) error("FLOW_PROVIDER_LITERAL", "Name the provider as a string, such as provider = \"openai\": the flow shows where its data goes before it runs.", provider.span);
      else if (policy === "local-files-v1" && literal !== "llamacpp") error("FLOW_POLICY_PROVIDER", `local-files-v1 runs local llama.cpp models only. Use policy = "cloud-files-v1" to call ${literal}.`, provider.span);
    }
    const positional = call.args.filter((arg) => arg.name === undefined);
    if (signature && (positional.length < signature.required || positional.length > signature.max)) error("FLOW_ARGUMENT_COUNT", `Action '${name}' expects ${signature.required === signature.max ? signature.required : `${signature.required}–${signature.max}`} positional arguments.`, call.span);
    let index = 0;
    let namedSeen = false;
    const positionalTypes: ValueType[] = [];
    const names = new Set<string>();
    for (const arg of call.args) {
      const type = infer(arg.value, symbols, passGuard);
      let expected: ValueType[] | undefined;
      if (arg.name) {
        namedSeen = true;
        if (names.has(arg.name)) error("FLOW_DUPLICATE_ARGUMENT", `Argument '${arg.name}' is repeated.`, arg.value.span);
        names.add(arg.name);
        expected = signature?.named && Object.hasOwn(signature.named, arg.name) ? signature.named[arg.name] : undefined;
        if (signature && !Object.hasOwn(signature.named ?? {}, arg.name)) error("FLOW_NAMED_ARGUMENT", `Unknown argument '${arg.name}' for '${name}'.`, arg.value.span);
      } else {
        if (namedSeen) error("FLOW_ARGUMENT_ORDER", "Positional arguments must come before named arguments.", arg.value.span);
        expected = signature?.parameters?.[index++];
        positionalTypes.push(type);
      }
      if (expected && !compatible(type, expected)) error("FLOW_TYPE", `Action '${name}' expects ${expected.join(" or ")}, received ${type}.`, arg.value.span);
    }
    if (name === "append" && positional.length === 2) {
      // A new list with the item at its end; the list's element type follows the items.
      const [list, item] = positionalTypes;
      if (!isArray(list)) return "array";
      const element = elementOf(list);
      if (list === "array:none" || list === "array") return list === "array" ? "array" : arrayOf(item);
      if (element !== item && element !== "unknown" && item !== "unknown") { error("FLOW_TYPE", `append adds a ${item} to a list of ${element}.`, call.span); return list; }
      return list;
    }
    return signature?.returns ?? "unknown";
  }

  function guardsPass(expression: Expression, symbols: Symbols): boolean {
    if (expression.kind !== "binary") return false;
    if (expression.operator === "&&") return guardsPass(expression.left, symbols) || guardsPass(expression.right, symbols);
    if (expression.operator !== "==") return false;
    const match = (status: Expression, expected: Expression) => status.kind === "member" && status.property === "status" &&
      status.object.kind === "identifier" && symbols.get(status.object.name) === "verdict" &&
      expected.kind === "identifier" && expected.name === "Pass";
    return match(expression.left, expression.right) || match(expression.right, expression.left);
  }

  function walk(body: Statement[], symbols: Symbols, loopDepth: number, blockDepth: number, passGuard: boolean): void {
    for (const statement of body) {
      switch (statement.kind) {
        case "limit":
          if (blockDepth !== 0) error("FLOW_LIMIT_SCOPE", "Budgets must be declared at the top level.", statement.span);
          break;
        case "assign": {
          if (statement.name === "policy" && (blockDepth !== 0 || statement.value.kind !== "literal" || !(POLICIES as readonly unknown[]).includes(statement.value.value))) error("FLOW_POLICY", `The policy is a top-level literal: ${POLICY_LIST}.`, statement.span);
          if (STATUSES.has(statement.name) || statement.name === flow.module || Object.hasOwn(FUNCTIONS, statement.name)) error("FLOW_RESERVED_NAME", `Name '${statement.name}' is reserved.`, statement.span);
          const type = infer(statement.value, symbols, passGuard);
          const previous = symbols.get(statement.name);
          if (previous && !assignable(previous, type)) error("FLOW_ASSIGNMENT_TYPE", `Variable '${statement.name}' cannot change from ${previous} to ${type}.`, statement.span);
          // An empty list keeps the element type it had; a list's element type, once known, stays.
          symbols.set(statement.name, previous && isArray(previous) && previous !== "array:none" && (type === "array:none" || type === "array") ? previous : type);
          break;
        }
        case "expression": infer(statement.expression, symbols, passGuard); break;
        case "return":
          if (!statement.value) error("FLOW_RETURN", "A flow must return accept(), needs_review(), or unresolved().", statement.span);
          else if (infer(statement.value, symbols, passGuard, false, true) !== "result") error("FLOW_RETURN", "A flow must return a synthesis result.", statement.span);
          break;
        case "continue":
          if (!loopDepth) error("FLOW_CONTINUE", "continue is only valid inside a while or for loop.", statement.span);
          break;
        case "for": {
          const list = infer(statement.iterable, symbols, passGuard);
          if (!isArray(list) && list !== "unknown") error("FLOW_TYPE", `for goes through a list; '${list}' is not one.`, statement.iterable.span);
          if (symbols.has(statement.variable) || STATUSES.has(statement.variable) || statement.variable === flow.module || Object.hasOwn(FUNCTIONS, statement.variable) || statement.variable === "policy") {
            error("FLOW_FOR_VARIABLE", `The loop variable '${statement.variable}' must be a new name; it exists only inside the loop.`, statement.span);
          }
          const loopSymbols = new Map(symbols);
          loopSymbols.set(statement.variable, elementOf(list));
          walk(statement.body, loopSymbols, loopDepth + 1, blockDepth + 1, passGuard);
          // A list may be empty: only existing variables remain assigned, and an empty list may learn its element type.
          for (const [name, type] of symbols) if ((type === "none" || type === "array:none") && loopSymbols.has(name)) symbols.set(name, loopSymbols.get(name)!);
          break;
        }
        case "while": {
          if (!compatible(infer(statement.condition, symbols, passGuard), ["boolean"])) error("FLOW_TYPE", "while requires a boolean condition.", statement.condition.span);
          const loopSymbols = new Map(symbols);
          walk(statement.body, loopSymbols, loopDepth + 1, blockDepth + 1, passGuard);
          // A loop may execute zero times. Only existing variables remain definitely assigned.
          for (const [name, type] of symbols) if ((type === "none" || type === "array:none") && loopSymbols.has(name)) symbols.set(name, loopSymbols.get(name)!);
          break;
        }
        case "if": {
          if (!compatible(infer(statement.condition, symbols, passGuard), ["boolean"])) error("FLOW_TYPE", "if requires a boolean condition.", statement.condition.span);
          const thenSymbols = new Map(symbols);
          const elseSymbols = new Map(symbols);
          walk(statement.then, thenSymbols, loopDepth, blockDepth + 1, passGuard || guardsPass(statement.condition, symbols));
          walk(statement.else, elseSymbols, loopDepth, blockDepth + 1, passGuard);
          for (const [name, type] of thenSymbols) {
            if (elseSymbols.has(name)) symbols.set(name, elseSymbols.get(name) === type ? type : "unknown");
          }
          break;
        }
      }
    }
  }
  walk(flow.body, new Map(), 0, 0, false);
  return diagnostics;
}
