import { NodeExecutionContext } from "./nodes/NodeExecutor";

export const renderWorkflowTemplate = (
  template: string,
  context: NodeExecutionContext
): string => {
  const source = {
    task: context.task,
    workflow: context.workflow,
    node: context.node,
    run: context.run,
    nodes: readRecord(context.run.state.nodeResults)
  };
  const exact = template.match(/^\s*{{\s*([^{}]+?)\s*}}\s*$/);

  if (exact) {
    return stringifyTemplateValue(readDotPath(source, exact[1]));
  }

  return template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, path: string) =>
    stringifyTemplateValue(readDotPath(source, path))
  );
};

export const readDotPath = (source: unknown, dotPath: string): unknown =>
  dotPath.split(".").reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, source);

export const readConfigString = (
  config: Record<string, unknown>,
  key: string,
  fallback = ""
): string => {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
};

export const readConfigNumber = (
  config: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const value = Number(config[key]);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
};

export const readConfigStringArray = (
  config: Record<string, unknown>,
  key: string,
  fallback: string[] = []
): string[] => {
  const value = config[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : fallback;
};

export const readRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const stringifyTemplateValue = (value: unknown): string => {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value, null, 2);
};
