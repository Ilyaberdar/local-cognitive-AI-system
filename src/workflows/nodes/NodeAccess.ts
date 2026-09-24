import { NodeExecutionContext } from "./NodeExecutor";

/** Explicit step choices override the run; old graphs retain their inherited policy. */
export function nodeAccess(context: NodeExecutionContext) {
  const config = context.node.config;
  const accessMode = config.approval === "never" ? "full" as const
    : context.accessMode ?? context.run.executionSnapshot?.accessMode ?? context.task?.accessMode ?? "default";
  const requireApproval = config.approval === "always";
  return { accessMode, requireApproval };
}
