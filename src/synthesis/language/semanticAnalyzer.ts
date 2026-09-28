import {
  CallExpression, CompileOptions, Diagnostic, Expression, FlowProgram, SourceSpan, SpecProgram, Statement
} from "./types";

type ValueType = "string" | "number" | "boolean" | "none" | "duration" | "bytes" | "cost" |
  "array" | "modelList" | "selectedModel" | "model" | "module" | "specRef" | "frozenSpec" |
  "candidate" | "evidence" | "verdict" | "status" | "feedback" | "review" | "design" | "tests" | "context" | "result" | "unknown";
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
  "models.select": { returns: "selectedModel", required: 1, max: 1, parameters: [["modelList"]], named: { max_size: ["bytes"], prefer: ["string"], provider: ["string"] } },
  "models.load": { returns: "model", required: 1, max: 1, parameters: [["selectedModel"]], async: true },
  model: { returns: "model", required: 1, max: 1, parameters: [["string"]] },
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
  stagnant: { returns: "boolean", required: 1, max: 1, parameters: [["number"]] }
};
const METHODS: Record<string, FunctionDefinition> = {
  revise: { returns: "candidate", required: 2, max: 4, parameters: [["candidate"], ["frozenSpec"]], named: { file: ["string"], format: ["string"], instruction: ["string"] }, async: true },
  propose: { returns: "design", required: 1, max: 2, parameters: [["frozenSpec"], ["context"]], async: true },
  inspect: { returns: "review", required: 2, max: 3, parameters: [["candidate"]], async: true },
  propose_tests: { returns: "tests", required: 1, max: 2, parameters: [["frozenSpec"], ["candidate"]], async: true },
  reconsider: { returns: "design", required: 2, max: 4, parameters: [["frozenSpec"], ["design"]], async: true }
};
const STATUSES = new Set(["Pass", "Fail", "Unknown", "Blocked", "Unresolved", "NeedsReview"]);
const FORBIDDEN_MEMBERS = new Set(["__proto__", "prototype", "constructor"]);

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
  const artifacts = new Set<string>();
  for (const artifact of spec.artifacts) {
    if (!artifact || artifact.startsWith("/") || artifact.includes("\\") || artifact.includes(":") || artifact.split("/").some((part) => ["", ".", ".."].includes(part))) {
      error("SPEC_ARTIFACT_PATH", `Artifact '${artifact}' must be a normalized relative file path.`);
    }
    if (artifacts.has(artifact)) error("SPEC_DUPLICATE_ARTIFACT", `Duplicate artifact '${artifact}'.`);
    artifacts.add(artifact);
  }
  const supported = new Set(options.supportedSpecSections ?? []);
  for (const section of spec.sections) {
    if (!supported.has(section.name)) error("SPEC_UNSUPPORTED_SECTION", `Section '${section.name}' is preserved as source, but requires a trusted evaluator adapter before it can be accepted.`, section.span);
  }
  // Target metadata must also be honored: accepting engine/platform claims without an adapter is misleading.
  for (const [key, value] of Object.entries(spec.target)) {
    if (key === "language" && ["JavaScript", "Javascript", "JS"].includes(String(value))) continue;
    if (supported.has(`target.${key}`)) continue;
    error("SPEC_UNSUPPORTED_TARGET", `Target '${key} = ${String(value)}' requires a registered target adapter.`);
  }
  return diagnostics;
}

export function analyzeFlow(flow: FlowProgram, spec: SpecProgram | undefined, options: CompileOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, message: string, span: SourceSpan) => diagnostics.push({ severity: "error" as const, code, message, span, path: options.flowPath });
  if (spec && flow.module !== spec.module) error("FLOW_MODULE", `Flow implements '${flow.module}', but the contract declares '${spec.module}'.`, flow.span);
  if (spec && flow.evaluator !== spec.evaluator) error("FLOW_EVALUATOR", `Flow evaluator '${flow.evaluator}' does not match '${spec.evaluator}'.`, flow.span);
  if (!Number.isSafeInteger(flow.limits.iterations) || flow.limits.iterations < 1) error("FLOW_ITERATION_LIMIT", "Declare a positive finite integer iteration limit.", flow.span);
  if (!Number.isFinite(flow.limits.timeMs) || flow.limits.timeMs <= 0) error("FLOW_TIME_LIMIT", "Declare a positive finite time limit.", flow.span);
  if (flow.limits.costUsd !== undefined && (!Number.isFinite(flow.limits.costUsd) || flow.limits.costUsd < 0)) error("FLOW_COST_LIMIT", "Cost must be finite and non-negative.", flow.span);
  if (flow.body.filter((statement) => statement.kind === "limit").length > 1) error("FLOW_DUPLICATE_LIMIT", "Declare budgets once at the top level.", flow.span);
  const policies = flow.body.filter((statement) => statement.kind === "assign" && statement.name === "policy");
  if (policies.length !== 1) error("FLOW_POLICY", "Declare exactly one top-level policy = \"local-files-v1\".", flow.span);

  type Symbols = Map<string, ValueType>;
  const numeric = (type: ValueType) => ["number", "duration", "bytes", "cost"].includes(type);
  const compatible = (actual: ValueType, wanted: ValueType[]) => actual === "unknown" || wanted.includes(actual);
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
      case "array": expression.items.forEach((item) => infer(item, symbols, passGuard)); return "array";
      case "member": {
        const object = infer(expression.object, symbols, passGuard);
        if (FORBIDDEN_MEMBERS.has(expression.property)) error("FLOW_MEMBER", `Member '${expression.property}' is not accessible in LC Flow.`, expression.span);
        const fields: Partial<Record<ValueType, Record<string, ValueType>>> = {
          module: { spec: "specRef" }, verdict: { status: "status", violations: "feedback" },
          evidence: { status: "status" }, review: { notes: "feedback", violations: "feedback" },
          selectedModel: { id: "string", displayName: "string", sizeBytes: "bytes", providerId: "string" },
          candidate: { id: "string", path: "string", hash: "string" }, array: { length: "number" }, modelList: { length: "number" }
        };
        const objectFields = fields[object];
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
    if (signature?.async && !awaited) error("FLOW_AWAIT_REQUIRED", `Action '${name}' requires await.`, call.span);
    if (["accept", "needs_review", "unresolved"].includes(name ?? "") && !terminalReturn) error("FLOW_TERMINAL_RETURN", `Terminal action '${name}' must be the direct expression of a return statement.`, call.span);
    if (name === "accept" && !passGuard) error("FLOW_ACCEPT_GUARD", "accept() must be inside a branch guarded by a verified verdict.status == Pass.", call.span);
    const positional = call.args.filter((arg) => arg.name === undefined);
    if (signature && (positional.length < signature.required || positional.length > signature.max)) error("FLOW_ARGUMENT_COUNT", `Action '${name}' expects ${signature.required === signature.max ? signature.required : `${signature.required}–${signature.max}`} positional arguments.`, call.span);
    let index = 0;
    let namedSeen = false;
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
      }
      if (expected && !compatible(type, expected)) error("FLOW_TYPE", `Action '${name}' expects ${expected.join(" or ")}, received ${type}.`, arg.value.span);
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
          if (statement.name === "policy" && (blockDepth !== 0 || statement.value.kind !== "literal" || statement.value.value !== "local-files-v1")) error("FLOW_POLICY", "The supported policy is a top-level literal: policy = \"local-files-v1\".", statement.span);
          if (STATUSES.has(statement.name) || statement.name === flow.module || Object.hasOwn(FUNCTIONS, statement.name)) error("FLOW_RESERVED_NAME", `Name '${statement.name}' is reserved.`, statement.span);
          const type = infer(statement.value, symbols, passGuard);
          const previous = symbols.get(statement.name);
          if (previous && previous !== type && previous !== "none" && type !== "none" && previous !== "unknown" && type !== "unknown") error("FLOW_ASSIGNMENT_TYPE", `Variable '${statement.name}' cannot change from ${previous} to ${type}.`, statement.span);
          symbols.set(statement.name, type);
          break;
        }
        case "expression": infer(statement.expression, symbols, passGuard); break;
        case "return":
          if (!statement.value) error("FLOW_RETURN", "A flow must return accept(), needs_review(), or unresolved().", statement.span);
          else if (infer(statement.value, symbols, passGuard, false, true) !== "result") error("FLOW_RETURN", "A flow must return a synthesis result.", statement.span);
          break;
        case "continue":
          if (!loopDepth) error("FLOW_CONTINUE", "continue is only valid inside a while loop.", statement.span);
          break;
        case "while": {
          if (!compatible(infer(statement.condition, symbols, passGuard), ["boolean"])) error("FLOW_TYPE", "while requires a boolean condition.", statement.condition.span);
          const loopSymbols = new Map(symbols);
          walk(statement.body, loopSymbols, loopDepth + 1, blockDepth + 1, passGuard);
          // A loop may execute zero times. Only existing variables remain definitely assigned.
          for (const [name, type] of symbols) if (type === "none" && loopSymbols.has(name)) symbols.set(name, loopSymbols.get(name)!);
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
