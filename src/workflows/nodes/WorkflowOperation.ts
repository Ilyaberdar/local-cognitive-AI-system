import { OperationExecutor } from "../../tools/OperationExecutor";
import { NodeResult } from "../types";
import { NodeExecutionContext } from "./NodeExecutor";

/** All workspace nodes use the same durable executor as conversational agents. */
export async function executeWorkflowOperation(
  context: NodeExecutionContext,
  executor: OperationExecutor,
  tool: string,
  args: Record<string, unknown>
): Promise<NodeResult> {
  const workspace = context.workspace ?? context.run.workspace;
  if (!workspace) throw new Error("The workflow run has no workspace snapshot.");
  const agentRunId = context.agentRunId ?? `workflow-${context.run.id}:${context.node.id}`;
  const id = context.operationId ?? `${agentRunId}:operation`;
  const approvalId = typeof context.approval?.approvalId === "string" ? context.approval.approvalId : undefined;
  const config = context.node.config;
  const requireApproval = config.approval === "always" || (
    context.node.type !== "file_search" && config.approval !== "inherit" && config.access !== "full"
  );
  const outcome = await executor.execute({
    id, agentRunId, workspace,
    accessMode: context.accessMode ?? context.run.executionSnapshot?.accessMode ?? context.task.accessMode ?? "default",
    tool, arguments: args, signal: context.signal, pauseForApproval: true, requireApproval,
    captureVersion: tool === "file.write" || tool === "file.append",
    // This identity belongs to one frozen node invocation. Reuse its proposal after both approval and a crash.
    resumePrepared: true,
    approval: approvalId ? { id: approvalId, approved: context.approval?.approved === true } : undefined
  });
  if (outcome.pendingApproval) return {
    status: "needs_input", event: `${context.node.type}.approval_required`, summary: outcome.pendingApproval.summary,
    data: { ...outcome.pendingApproval, permissionRequired: true, approvalId: outcome.pendingApproval.id, operationId: id }
  };
  if (!outcome.result) throw new Error("Operation executor returned no result.");
  const result = outcome.result;
  const data: Record<string, unknown> = { ...result.metadata, operationId: id, output: result.output };
  const unknown = data.unknown === true;
  return {
    status: unknown ? "blocked" : result.ok ? "ok" : "failed", event: `${context.node.type}.${unknown ? "unknown" : result.ok ? "completed" : "failed"}`,
    summary: result.output.slice(0, 1000), data,
    error: result.ok ? undefined : result.output,
    artifacts: result.ok && (tool === "file.write" || tool === "file.append") && typeof data.path === "string"
      ? [{ name: data.path.split(/[\\/]/).pop() ?? "File", path: data.path, contentType: "text/plain" }] : undefined
  };
}
