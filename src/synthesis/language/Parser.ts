import { joinSpans, lex } from "./Lexer";
import {
  CallArgument, CallExpression, ContractCheck, Diagnostic, Expression, FlowLimits, FlowProgram, ParseResult, SourceSpan,
  SpecProgram, SpecSection, Statement, Token
} from "./types";

const GATE_FORMS = "Pass(\"evaluator-id\"), Tests(\"tests/a.test.ts\"), Exports(\"src/a.ts\", [\"Name\"]), Imports(\"src/**\", allow = [...], deny = [...]) or Forbid(\"src/**\", \"pattern\")";
const text = (expression: Expression | undefined): string | undefined =>
  expression?.kind === "literal" && typeof expression.value === "string" ? expression.value : undefined;
const texts = (expression: Expression | undefined): string[] | undefined => {
  if (expression?.kind !== "array") return undefined;
  const values = expression.items.map(text);
  return values.every((value): value is string => value !== undefined) ? values : undefined;
};
/** A gate's call as the adapter it names and, for a built-in check, its arguments; or why not. */
function gateCall(call: CallExpression): { evaluatorId: string; check?: ContractCheck } | string {
  const name = call.callee.kind === "identifier" ? call.callee.name : "";
  const positional = call.args.filter((arg) => !arg.name).map((arg) => arg.value);
  const named = new Map(call.args.filter((arg) => arg.name).map((arg) => [arg.name!, arg.value]));
  const unknown = [...named.keys()].find((key) => !({ Tests: ["timeout", "hidden"], Imports: ["allow", "deny"], Forbid: ["message"] } as Record<string, string[]>)[name]?.includes(key));
  if (unknown) return `${name || "This gate"} has no argument '${unknown}'.`;
  switch (name) {
    case "Pass": {
      const id = text(positional[0]);
      return positional.length === 1 && id !== undefined ? { evaluatorId: id } : "Pass takes one evaluator ID string.";
    }
    case "Tests": {
      const files = positional.map(text);
      if (!files.length || !files.every((file): file is string => file !== undefined)) return "Tests takes the contract's test files as strings.";
      const timeout = named.get("timeout"), hidden = named.get("hidden");
      if (timeout && (timeout.kind !== "literal" || typeof timeout.value !== "number" || !["ms", "s", "m"].includes(timeout.unit ?? ""))) return "Tests timeout must be a duration such as 30s.";
      if (hidden && (hidden.kind !== "literal" || typeof hidden.value !== "boolean")) return "Tests hidden must be true or false.";
      return { evaluatorId: "contract-tests-v1", check: { kind: "tests", files,
        ...(timeout ? { timeoutMs: Number((timeout as { value: number }).value) } : {}), ...(hidden ? { hidden: (hidden as { value: boolean }).value } : {}) } };
    }
    case "Exports": {
      const file = text(positional[0]), symbols = texts(positional[1]);
      return positional.length === 2 && file !== undefined && symbols?.length ? { evaluatorId: "contract-exports-v1", check: { kind: "exports", file, symbols } }
        : "Exports takes a file and a list of symbol names: Exports(\"src/a.ts\", [\"Name\"]).";
    }
    case "Imports": {
      const pattern = text(positional[0]), allow = named.has("allow") ? texts(named.get("allow")) : [], deny = named.has("deny") ? texts(named.get("deny")) : [];
      if (positional.length !== 1 || pattern === undefined || !allow || !deny) return "Imports takes a file pattern and allow = [...] and/or deny = [...] lists of strings.";
      return allow.length || deny.length ? { evaluatorId: "contract-imports-v1", check: { kind: "imports", pattern, allow, deny } } : "Imports needs an allow or a deny list.";
    }
    case "Forbid": {
      const pattern = text(positional[0]), regex = text(positional[1]), message = named.has("message") ? text(named.get("message")) : undefined;
      if (positional.length !== 2 || pattern === undefined || regex === undefined || (named.has("message") && message === undefined)) return "Forbid takes a file pattern and a regular expression: Forbid(\"src/**\", \"Date\\\\.now\").";
      return { evaluatorId: "contract-forbid-v1", check: { kind: "forbid", pattern, regex, ...(message !== undefined ? { message } : {}) } };
    }
    default: return `Gates use ${GATE_FORMS}.`;
  }
}

class ParseFailure extends Error {}
const PRECEDENCE: Record<string, number> = {
  "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4,
  "+": 5, "-": 5, "*": 6, "/": 6, "%": 6
};

class Parser {
  private readonly scan;
  private offset = 0;
  private depth = 0;
  readonly diagnostics: Diagnostic[];

  constructor(private readonly source: string, private readonly path?: string) {
    this.scan = lex(source, path);
    this.diagnostics = this.scan.diagnostics;
  }

  private get current(): Token { return this.scan.tokens[this.offset]; }
  private get previous(): Token { return this.scan.tokens[Math.max(0, this.offset - 1)]; }
  private next(): Token { const token = this.current; if (token.kind !== "eof") this.offset++; return token; }
  private at(text: string): boolean { return this.current.text === text; }
  private atEnd(): boolean { return this.current.kind === "eof"; }
  private consume(text: string): boolean { if (!this.at(text)) return false; this.next(); return true; }
  private diagnostic(code: string, message: string, span = this.current.span): void {
    this.diagnostics.push({ severity: "error", code, message, span, path: this.path });
  }
  private fail(message: string): never {
    this.diagnostic("PARSE_SYNTAX", message);
    throw new ParseFailure(message);
  }
  private expect(text: string): Token {
    if (!this.at(text)) this.fail(`Expected '${text}', found ${this.current.kind === "eof" ? "end of file" : `'${this.current.text}'`}.`);
    return this.next();
  }
  private identifier(): Token {
    if (this.current.kind !== "identifier") this.fail("Expected an identifier.");
    return this.next();
  }
  private string(): Token {
    if (this.current.kind !== "string") this.fail("Expected a quoted string.");
    return this.next();
  }
  private enter(): void { if (++this.depth > 128) this.fail("Maximum syntax nesting depth (128) exceeded."); }
  private leave(): void { this.depth--; }
  private section(start: Token, name: string, label?: string): SpecSection {
    this.expect("{");
    let nesting = 1;
    while (nesting && !this.atEnd()) {
      const token = this.next();
      if (token.text === "{" && token.kind === "symbol") nesting++;
      if (token.text === "}" && token.kind === "symbol") nesting--;
    }
    if (nesting) this.fail(`Unterminated '${name}' section.`);
    this.consume(";");
    return { name, label, source: this.source.slice(start.span.start.offset, this.previous.span.end.offset), span: joinSpans(start.span, this.previous.span) };
  }

  parseSpec(): SpecProgram {
    const start = this.current;
    if (!(this.consume("module") || this.consume("system"))) this.fail("Expected 'module' or 'system'.");
    const module = this.identifier().text;
    // Retain inheritance as a section until a domain adapter can validate refinement.
    let inheritance: SpecSection | undefined;
    if (this.consume("extends")) {
      const base = this.identifier();
      inheritance = { name: "extends", label: base.text, source: `extends ${base.text}`, span: base.span };
    }
    this.expect("version");
    const version = String(this.string().value);
    this.expect("{");
    const spec: SpecProgram = {
      kind: "spec", module, version, evaluator: "", description: "", target: {}, artifacts: [], frozen: [], tests: [], gates: [],
      sections: inheritance ? [inheritance] : [], comments: this.scan.comments, span: start.span
    };
    let hasEvaluate = false;
    const topNames = new Set<string>();
    while (!this.at("}") && !this.atEnd()) {
      const head = this.identifier();
      const name = head.text;
      if (topNames.has(name)) this.diagnostic("SPEC_DUPLICATE_SECTION", `Duplicate '${name}' section.`, head.span);
      topNames.add(name);
      if (name === "description") {
        this.expect("="); spec.description = String(this.string().value); this.expect(";");
      } else if (name === "target") {
        this.expect("{");
        while (!this.at("}") && !this.atEnd()) {
          const key = this.identifier(); this.expect("="); const value = this.expression(); this.expect(";");
          if (Object.hasOwn(spec.target, key.text)) this.diagnostic("SPEC_DUPLICATE_TARGET", `Duplicate target field '${key.text}'.`, key.span);
          if (["__proto__", "constructor", "prototype"].includes(key.text)) this.diagnostic("SPEC_TARGET_FIELD", `Invalid target field '${key.text}'.`, key.span);
          else if (value.kind === "identifier") spec.target[key.text] = value.name;
          else if (value.kind === "literal" && value.value !== null && !value.unit) spec.target[key.text] = value.value;
          else this.diagnostic("SPEC_TARGET_VALUE", "Target properties must be identifiers or scalar literals.", value.span);
        }
        this.expect("}"); this.consume(";");
      } else if (name === "artifacts") {
        this.expect("{");
        while (!this.at("}") && !this.atEnd()) {
          // `frozen`: a file the engineer wrote (an interface); the model reads it but never writes it.
          if (this.consume("frozen")) spec.frozen.push(String(this.string().value));
          else { this.expect("file"); spec.artifacts.push(String(this.string().value)); }
          this.expect(";");
        }
        this.expect("}"); this.consume(";");
      } else if (name === "tests") {
        this.expect("{");
        while (!this.at("}") && !this.atEnd()) {
          this.expect("file"); spec.tests.push(String(this.string().value)); this.expect(";");
        }
        this.expect("}"); this.consume(";");
      } else if (name === "evaluate") {
        if (hasEvaluate) this.diagnostic("SPEC_EVALUATE_COUNT", "V1 supports one acceptance evaluator group.", head.span);
        hasEvaluate = true;
        spec.evaluator = String(this.string().value);
        this.expect("{");
        while (!this.at("}") && !this.atEnd()) {
          const gateStart = this.identifier();
          if (gateStart.text !== "hard" && gateStart.text !== "soft") {
            this.expect("="); this.expression(); this.expect(";");
            spec.sections.push({ name: `evaluate.${gateStart.text}`, source: this.source.slice(gateStart.span.start.offset, this.previous.span.end.offset), span: joinSpans(gateStart.span, this.previous.span) });
            continue;
          }
          if (gateStart.text === "soft" && this.consume("minimize")) {
            this.expression(); this.expect(";");
            spec.sections.push({ name: "soft.minimize", source: this.source.slice(gateStart.span.start.offset, this.previous.span.end.offset), span: joinSpans(gateStart.span, this.previous.span) });
            continue;
          }
          const id = this.identifier().text;
          this.expect("=");
          const result = this.expression();
          this.expect(";");
          const gate = result.kind === "call" ? gateCall(result) : `Gates use ${GATE_FORMS}.`;
          if (typeof gate === "string") this.diagnostic("SPEC_GATE_EXPRESSION", gate, result.span);
          else spec.gates.push({ id, severity: gateStart.text, ...gate, span: joinSpans(gateStart.span, this.previous.span) });
        }
        this.expect("}"); this.consume(";");
      } else {
        const label = this.current.kind === "string" ? String(this.next().value) : undefined;
        if (this.at("{")) spec.sections.push(this.section(head, name, label));
        else {
          while (!this.at(";") && !this.at("}") && !this.atEnd()) this.next();
          this.expect(";");
          spec.sections.push({ name, label, source: this.source.slice(head.span.start.offset, this.previous.span.end.offset), span: joinSpans(head.span, this.previous.span) });
        }
      }
    }
    this.expect("}"); this.consume(";");
    spec.span = joinSpans(start.span, this.previous.span);
    if (this.current.kind !== "eof") this.fail("Unexpected text after module declaration.");
    return spec;
  }

  parseFlow(): FlowProgram {
    const start = this.expect("implement");
    const module = this.identifier().text;
    this.expect("using");
    const evaluator = String(this.string().value);
    const body = this.block();
    // Left-associative expressions can have a deeper AST than parser recursion.
    // Walk iteratively before handing the tree to semantic analysis or runtime.
    const pending: Array<{ node: Statement | Expression; depth: number }> = body.map((node) => ({ node, depth: 1 }));
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      if (depth > 192) this.fail("Maximum expression tree depth (192) exceeded.");
      const push = (...nodes: Array<Statement | Expression | undefined>) => nodes.forEach((child) => { if (child) pending.push({ node: child, depth: depth + 1 }); });
      switch (node.kind) {
        case "assign": push(node.value); break;
        case "expression": case "await": push(node.expression); break;
        case "if": push(node.condition, ...node.then, ...node.else); break;
        case "while": push(node.condition, ...node.body); break;
        case "return": push(node.value); break;
        case "array": push(...node.items); break;
        case "member": push(node.object); break;
        case "call": push(node.callee, ...node.args.map((arg) => arg.value)); break;
        case "unary": push(node.operand); break;
        case "binary": push(node.left, node.right); break;
      }
    }
    this.consume(";");
    if (this.current.kind !== "eof") this.fail("Unexpected text after flow declaration.");
    const limits = body.filter((statement) => statement.kind === "limit").reduce<FlowLimits>(
      (result, statement) => ({ ...result, ...statement.values }), { iterations: 0, timeMs: 0 }
    );
    return { kind: "flow", module, evaluator, limits, body, comments: this.scan.comments, span: joinSpans(start.span, this.previous.span) };
  }

  private block(): Statement[] {
    this.enter();
    this.expect("{");
    const body: Statement[] = [];
    while (!this.at("}") && !this.atEnd()) body.push(this.statement());
    this.expect("}");
    this.leave();
    return body;
  }

  private statement(): Statement {
    this.enter();
    try { return this.parseStatement(); } finally { this.leave(); }
  }

  private parseStatement(): Statement {
    const start = this.current;
    if (this.consume("if")) {
      this.expect("("); const condition = this.expression(); this.expect(")");
      const then = this.block();
      let otherwise: Statement[] = [];
      if (this.consume("else")) otherwise = this.at("if") ? [this.statement()] : this.block();
      return { kind: "if", condition, then, else: otherwise, span: joinSpans(start.span, this.previous.span) };
    }
    if (this.consume("while")) {
      this.expect("("); const condition = this.expression(); this.expect(")");
      const body = this.block();
      return { kind: "while", condition, body, span: joinSpans(start.span, this.previous.span) };
    }
    if (this.consume("continue")) {
      this.expect(";"); return { kind: "continue", span: joinSpans(start.span, this.previous.span) };
    }
    if (this.consume("return")) {
      const value = this.at(";") ? undefined : this.expression();
      this.expect(";"); return { kind: "return", value, span: joinSpans(start.span, this.previous.span) };
    }
    if (this.consume("limit")) {
      const values: Partial<FlowLimits> = {};
      const seen = new Set<string>();
      do {
        const name = this.identifier();
        if (seen.has(name.text)) this.diagnostic("FLOW_DUPLICATE_LIMIT", `Duplicate '${name.text}' limit.`, name.span);
        seen.add(name.text);
        const quantity = this.current;
        if (quantity.kind !== "number") this.fail("A limit must be a positive finite numeric literal.");
        this.next();
        if (name.text === "iterations") {
          if (quantity.unit) this.diagnostic("FLOW_LIMIT_UNIT", "Iterations must be a dimensionless integer.", quantity.span);
          values.iterations = Number(quantity.value);
        } else if (name.text === "time") {
          if (!["ms", "s", "m", "h"].includes(quantity.unit ?? "")) this.diagnostic("FLOW_LIMIT_UNIT", "Time requires ms, s, m, or h units.", quantity.span);
          values.timeMs = Number(quantity.value);
        } else if (name.text === "cost") {
          if (quantity.unit !== "usd") this.diagnostic("FLOW_LIMIT_UNIT", "Cost requires usd units.", quantity.span);
          values.costUsd = Number(quantity.value);
        } else this.diagnostic("FLOW_LIMIT_NAME", `Unknown budget '${name.text}'.`, name.span);
      } while (this.consume(","));
      this.expect(";");
      return { kind: "limit", values, span: joinSpans(start.span, this.previous.span) };
    }
    if (this.current.kind === "identifier" && this.scan.tokens[this.offset + 1]?.text === "=") {
      const name = this.next().text; this.next(); const value = this.expression(); this.expect(";");
      return { kind: "assign", name, value, span: joinSpans(start.span, this.previous.span) };
    }
    const expression = this.expression(); this.expect(";");
    return { kind: "expression", expression, span: joinSpans(start.span, this.previous.span) };
  }

  private expression(minPrecedence = 0): Expression {
    this.enter();
    let left = this.prefix();
    let operations = 0;
    while (true) {
      const precedence = PRECEDENCE[this.current.text];
      if (precedence === undefined || precedence < minPrecedence) break;
      if (++operations > 128) this.fail("An expression may contain at most 128 consecutive binary operations.");
      const operator = this.next().text;
      const right = this.expression(precedence + 1);
      left = { kind: "binary", operator, left, right, span: joinSpans(left.span, right.span) };
    }
    this.leave();
    return left;
  }

  private prefix(): Expression {
    const start = this.current;
    if (this.consume("await")) {
      // The right operand includes member access and calls, not binary operators.
      const expression = this.expression(7);
      return { kind: "await", expression, span: joinSpans(start.span, expression.span) };
    }
    if (this.consume("!") || this.consume("-") || this.consume("+")) {
      const operand = this.expression(7);
      return { kind: "unary", operator: start.text as "!" | "-" | "+", operand, span: joinSpans(start.span, operand.span) };
    }
    let result: Expression;
    if (start.kind === "string" || start.kind === "number") {
      this.next(); result = { kind: "literal", value: start.value!, unit: start.unit, span: start.span };
    } else if (["true", "false", "none", "null"].includes(start.text)) {
      this.next(); result = { kind: "literal", value: start.text === "true" ? true : start.text === "false" ? false : null, span: start.span };
    } else if (this.consume("(")) {
      result = this.expression(); this.expect(")");
    } else if (this.consume("[")) {
      const items: Expression[] = [];
      if (!this.at("]")) do { items.push(this.expression()); } while (this.consume(",") && !this.at("]"));
      this.expect("]"); result = { kind: "array", items, span: joinSpans(start.span, this.previous.span) };
    } else if (start.kind === "identifier") {
      this.next(); result = { kind: "identifier", name: start.text, span: start.span };
    } else this.fail("Expected an expression.");
    let postfixCount = 0;
    while (true) {
      if (++postfixCount > 128) this.fail("An expression may contain at most 128 consecutive member accesses or calls.");
      if (this.consume(".")) {
        const property = this.identifier();
        result = { kind: "member", object: result, property: property.text, span: joinSpans(result.span, property.span) };
      } else if (this.consume("(")) {
        const args: CallArgument[] = [];
        if (!this.at(")")) do {
          let name: string | undefined;
          if (this.current.kind === "identifier" && this.scan.tokens[this.offset + 1]?.text === "=") {
            name = this.next().text; this.next();
          }
          args.push({ name, value: this.expression() });
        } while (this.consume(",") && !this.at(")"));
        this.expect(")"); result = { kind: "call", callee: result, args, span: joinSpans(result.span, this.previous.span) };
      } else break;
    }
    return result;
  }
}

function parse<T>(source: string, path: string | undefined, run: (parser: Parser) => T): ParseResult<T> {
  if (source.length > 256 * 1024) {
    const position = { offset: 0, line: 1, column: 1 };
    return { diagnostics: [{ severity: "error", code: "SOURCE_TOO_LARGE", message: "DSL files must be at most 256 KiB.", span: { start: position, end: position }, path }] };
  }
  const parser = new Parser(source, path);
  if (parser.diagnostics.some((diagnostic) => diagnostic.code === "LEX_TOKEN_LIMIT")) return { diagnostics: parser.diagnostics };
  try { return { ast: run(parser), diagnostics: parser.diagnostics }; }
  catch (error) { if (!(error instanceof ParseFailure)) throw error; return { diagnostics: parser.diagnostics }; }
}

export function parseSpec(source: string, path?: string): ParseResult<SpecProgram> {
  return parse(source, path, (parser) => parser.parseSpec());
}
export function parseFlow(source: string, path?: string): ParseResult<FlowProgram> {
  return parse(source, path, (parser) => parser.parseFlow());
}
