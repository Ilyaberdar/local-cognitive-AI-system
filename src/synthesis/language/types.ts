/** Offsets are UTF-16 offsets; line and column are one-based. */
export interface SourcePosition { offset: number; line: number; column: number }
export interface SourceSpan { start: SourcePosition; end: SourcePosition }
export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  span: SourceSpan;
  path?: string;
}
export interface Token {
  kind: "identifier" | "number" | "string" | "symbol" | "eof";
  text: string;
  value?: string | number;
  unit?: string;
  span: SourceSpan;
}
export interface Comment { text: string; span: SourceSpan }
export interface LiteralExpression {
  kind: "literal";
  /** Quantities are normalized to milliseconds, bytes, or USD. */
  value: string | number | boolean | null;
  unit?: string;
  span: SourceSpan;
}
export interface IdentifierExpression { kind: "identifier"; name: string; span: SourceSpan }
export interface ArrayExpression { kind: "array"; items: Expression[]; span: SourceSpan }
export interface MemberExpression { kind: "member"; object: Expression; property: string; span: SourceSpan }
export interface CallArgument { name?: string; value: Expression }
export interface CallExpression { kind: "call"; callee: Expression; args: CallArgument[]; span: SourceSpan }
export interface UnaryExpression { kind: "unary"; operator: "!" | "-" | "+"; operand: Expression; span: SourceSpan }
export interface BinaryExpression { kind: "binary"; operator: string; left: Expression; right: Expression; span: SourceSpan }
export interface AwaitExpression { kind: "await"; expression: Expression; span: SourceSpan }
export type Expression = LiteralExpression | IdentifierExpression | ArrayExpression | MemberExpression |
  CallExpression | UnaryExpression | BinaryExpression | AwaitExpression;
export interface AssignStatement { kind: "assign"; name: string; value: Expression; span: SourceSpan }
export interface ExpressionStatement { kind: "expression"; expression: Expression; span: SourceSpan }
export interface IfStatement { kind: "if"; condition: Expression; then: Statement[]; else: Statement[]; span: SourceSpan }
export interface WhileStatement { kind: "while"; condition: Expression; body: Statement[]; span: SourceSpan }
export interface ContinueStatement { kind: "continue"; span: SourceSpan }
export interface ReturnStatement { kind: "return"; value?: Expression; span: SourceSpan }
export interface FlowLimits { iterations: number; timeMs: number; costUsd?: number }
export interface LimitStatement { kind: "limit"; values: Partial<FlowLimits>; span: SourceSpan }
export type Statement = AssignStatement | ExpressionStatement | IfStatement | WhileStatement |
  ContinueStatement | ReturnStatement | LimitStatement;
/** A built-in check a contract names directly instead of a registered adapter's Pass("id"). */
export type ContractCheck =
  | { kind: "tests"; files: string[]; timeoutMs?: number; hidden?: boolean }
  | { kind: "exports"; file: string; symbols: string[] }
  | { kind: "imports"; pattern: string; allow: string[]; deny: string[] }
  | { kind: "forbid"; pattern: string; regex: string; message?: string };
export interface SpecGate {
  id: string;
  severity: "hard" | "soft";
  /** The adapter of Pass("id"), or contract-tests-v1 and its siblings for a built-in check. */
  evaluatorId: string;
  check?: ContractCheck;
  span: SourceSpan;
}
/** Opaque domain sections are preserved for adapters, never silently verified. */
export interface SpecSection { name: string; label?: string; source: string; span: SourceSpan }
export interface SpecProgram {
  kind: "spec";
  module: string;
  version: string;
  evaluator: string;
  description: string;
  target: Record<string, string | number | boolean>;
  /** Files the model writes, relative to the checkout folder. */
  artifacts: string[];
  /** Files the engineer wrote in the checkout folder (interfaces): the model reads them, never changes them. */
  frozen: string[];
  /** Support files of the contract's tests, relative to the .lcspec folder (Tests() names the ones to run). */
  tests: string[];
  gates: SpecGate[];
  sections: SpecSection[];
  comments: Comment[];
  span: SourceSpan;
}
export interface FlowProgram {
  kind: "flow";
  module: string;
  evaluator: string;
  /** The top-level policy literal: what the run may use (local models, cloud models, agents). */
  policy?: string;
  limits: FlowLimits;
  body: Statement[];
  comments: Comment[];
  span: SourceSpan;
}
export interface ParseResult<T> { ast?: T; diagnostics: Diagnostic[] }
export interface CompileOptions {
  specPath?: string;
  flowPath?: string;
  /** Only a trusted target adapter may declare support for domain sections. */
  supportedSpecSections?: string[];
}
export interface CompiledProgram { spec?: SpecProgram; flow?: FlowProgram; diagnostics: Diagnostic[] }
