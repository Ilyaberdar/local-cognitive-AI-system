import { NodeResult } from "../types";
import { readConfigString, readDotPath, readRecord } from "../template";
import { NodeExecutionContext, NodeExecutor } from "./NodeExecutor";

export class DecisionNodeExecutor implements NodeExecutor {
  readonly type = "decision" as const;

  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    const config = context.node.config;
    const path = readConfigString(config, "path", "");
    const operator = readConfigString(config, "operator", "exists");
    const expected = config.value;
    const source = {
      task: context.task,
      workflow: context.workflow,
      run: context.run,
      nodes: readRecord(context.run.state.nodeResults)
    };
    const actual = readDotPath(source, path);
    const matched = evaluate(operator, actual, expected);

    return {
      status: "ok",
      event: matched ? "decision.true" : "decision.false",
      summary: `Decision ${path || "value"} ${operator} returned ${matched}.`,
      data: { path, operator, expected, actual, matched }
    };
  }
}

const evaluate = (operator: string, actual: unknown, expected: unknown): boolean => {
  switch (operator) {
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    case "contains":
      return Array.isArray(actual)
        ? actual.includes(expected)
        : typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    case "gt": return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte": return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "lt": return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte": return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "truthy": return Boolean(actual);
    case "exists": return actual !== undefined;
    default: throw new Error(`Unsupported decision operator: ${operator}`);
  }
};
