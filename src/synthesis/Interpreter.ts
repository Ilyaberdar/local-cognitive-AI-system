import { Expression, FlowProgram, SourceSpan, Statement } from "./language";
import { SynthesisError } from "./types";

export interface InterpreterHost {
  signal: AbortSignal;
  globals: Record<string, unknown>;
  call(name: string, args: unknown[], named: Record<string, unknown>, span: SourceSpan, receiver?: unknown): Promise<unknown>;
  iteration(value: number, span: SourceSpan): Promise<void>;
}
class FlowReturn { constructor(readonly value: unknown) {} }
class FlowContinue {}
export class BudgetExhausted extends Error {}

/** An AST interpreter, deliberately not JS evaluation. Calls are capabilities supplied by the host. */
export class Interpreter {
  private readonly variables = new Map<string, unknown>();
  private iterations = 0;
  private steps = 0;
  constructor(private readonly host: InterpreterHost, private readonly flow: FlowProgram) {}
  async run(): Promise<unknown> {
    try { await this.block(this.flow.body); return undefined; }
    catch (value) { if (value instanceof FlowReturn) return value.value; throw value; }
  }
  private check(): void {
    this.host.signal.throwIfAborted();
    if (++this.steps > 10000) throw new BudgetExhausted("Interpreter step budget exhausted.");
  }
  private async block(body: Statement[]): Promise<void> {
    for (const statement of body) {
      this.check();
      switch (statement.kind) {
        case "limit": break;
        case "assign": this.variables.set(statement.name, await this.expression(statement.value)); break;
        case "expression": await this.expression(statement.expression); break;
        case "return": throw new FlowReturn(statement.value ? await this.expression(statement.value) : undefined);
        case "continue": throw new FlowContinue();
        case "if": await this.block(await this.expression(statement.condition) ? statement.then : statement.else); break;
        case "while":
          while (await this.expression(statement.condition)) {
            this.check();
            if (++this.iterations > this.flow.limits.iterations) throw new BudgetExhausted("Iteration budget exhausted.");
            await this.host.iteration(this.iterations, statement.span);
            try { await this.block(statement.body); } catch (error) { if (!(error instanceof FlowContinue)) throw error; }
          }
      }
    }
  }
  private async expression(expression: Expression): Promise<any> {
    this.check();
    switch (expression.kind) {
      case "literal": return expression.value;
      case "identifier": {
        if (this.variables.has(expression.name)) return this.variables.get(expression.name);
        if (Object.hasOwn(this.host.globals, expression.name)) return this.host.globals[expression.name];
        throw new SynthesisError(`Unknown variable '${expression.name}'.`);
      }
      case "array": {
        // Statements and their parts run in order: no authored parallelism (lc-language).
        const values: unknown[] = [];
        for (const item of expression.items) values.push(await this.expression(item));
        return values;
      }
      case "await": return this.expression(expression.expression);
      case "member": {
        const object = await this.expression(expression.object);
        if (!object || typeof object !== "object" || !Object.hasOwn(object, expression.property)) throw new SynthesisError(`Unknown field '${expression.property}'.`);
        return object[expression.property];
      }
      case "unary": {
        const value = await this.expression(expression.operand);
        return expression.operator === "!" ? !value : expression.operator === "-" ? -Number(value) : Number(value);
      }
      case "binary": {
        const left = await this.expression(expression.left);
        if (expression.operator === "&&") return left && await this.expression(expression.right);
        if (expression.operator === "||") return left || await this.expression(expression.right);
        const right = await this.expression(expression.right);
        switch (expression.operator) {
          case "==": return left === right;
          case "!=": return left !== right;
          case "<": return left < right;
          case "<=": return left <= right;
          case ">": return left > right;
          case ">=": return left >= right;
          case "+": return typeof left === "string" && typeof right === "string" ? left + right : Number(left) + Number(right);
          case "-": return Number(left) - Number(right);
          case "*": return Number(left) * Number(right);
          case "/": return Number(left) / Number(right);
          case "%": return Number(left) % Number(right);
          default: throw new SynthesisError(`Unsupported operator '${expression.operator}'.`);
        }
      }
      case "call": {
        let name: string; let receiver: unknown;
        if (expression.callee.kind === "identifier") name = expression.callee.name;
        else if (expression.callee.kind === "member" && expression.callee.object.kind === "identifier") {
          const owner = expression.callee.object.name;
          name = owner === "models" ? `models.${expression.callee.property}` : `role.${expression.callee.property}`;
          if (owner !== "models") receiver = await this.expression(expression.callee.object);
        } else throw new SynthesisError("Only registered functions and role methods may be called.");
        const args: unknown[] = []; const named: Record<string, unknown> = Object.create(null);
        for (const arg of expression.args) {
          const value = await this.expression(arg.value);
          if (arg.name) named[arg.name] = value; else args.push(value);
        }
        return this.host.call(name, args, named, expression.span, receiver);
      }
    }
  }
}
