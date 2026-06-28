import { NodeResult, TransitionGuard } from "./types";

export const evaluateGuard = (
  guard: TransitionGuard,
  result: NodeResult,
  runState: Record<string, unknown>
): boolean => {
  switch (guard.type) {
    case "always":
      return true;
    case "status":
      return result.status === guard.equals;
    case "event":
      return result.event === guard.equals;
    case "json_path":
      return evaluateJsonPathGuard(guard, result, runState);
  }
};

const evaluateJsonPathGuard = (
  guard: Extract<TransitionGuard, { type: "json_path" }>,
  result: NodeResult,
  runState: Record<string, unknown>
): boolean => {
  const source = {
    data: result.data,
    state: runState,
    result
  };
  const value = readDotPath(source, guard.path);

  switch (guard.op) {
    case "exists":
      return value !== undefined;
    case "eq":
      return value === guard.value;
    case "contains":
      return Array.isArray(value)
        ? value.includes(guard.value)
        : typeof value === "string" && typeof guard.value === "string"
          ? value.includes(guard.value)
          : false;
  }
};

const readDotPath = (source: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, source);
