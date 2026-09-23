import { CognitiveEngine } from "../../core/CognitiveEngine";
import { ProcessResult, ProviderTarget, SessionSettings } from "../../types";
import { NodeResult, WorkflowNode } from "../types";
import { renderWorkflowTemplate } from "../template";
import { NodeExecutor, NodeExecutionContext } from "./NodeExecutor";

export class AgentNodeExecutor implements NodeExecutor {
  readonly type = "agent" as const;

  constructor(
    private readonly engine: CognitiveEngine,
    private readonly providerDefaults: Record<string, string | undefined> = {}
  ) {}

  snapshotTarget(node: WorkflowNode, settings?: SessionSettings): ProviderTarget | undefined {
    const providerId = readOptionalString(node.config.providerId) ?? settings?.defaultTarget.providerId;
    if (!providerId) return undefined;
    return {
      providerId,
      model: readOptionalString(node.config.model) ??
        (settings?.defaultTarget.providerId === providerId ? settings.defaultTarget.model : undefined) ??
        this.providerDefaults[providerId]
    };
  }

  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    const prompt = context.agentInput ?? renderWorkflowTemplate(
      String(context.node.config.promptTemplate ?? "{{task.title}}\n\n{{task.description}}"),
      context
    );
    const mode = readMode(context.node.config.mode);
    const frozenTarget = context.run.executionSnapshot?.nodeTargets?.[context.node.id];
    const providerId = frozenTarget ? frozenTarget.providerId : readOptionalString(context.node.config.providerId);
    const model = frozenTarget ? frozenTarget.model :
      readOptionalString(context.node.config.model) ??
      (providerId ? this.providerDefaults[providerId] : undefined);
    const agentRunId = context.agentRunId ?? `workflow-${context.run.id}:${context.node.id}`;
    const workspace = context.workspace ?? context.run.workspace;
    const approvalId = typeof context.approval?.approvalId === "string" ? context.approval.approvalId : undefined;
    const result = await this.engine.process({
      input: prompt,
      providerId,
      model,
      signal: context.signal,
      onProgress: context.onProgress,
      ...(workspace ? { execution: {
        workspace,
        accessMode: context.accessMode ?? context.run.executionSnapshot?.accessMode ?? context.task.accessMode ?? "default",
        agentRunId,
        pauseForApproval: true,
        requireApproval: context.node.config.approval === "always",
        settings: context.settings ?? context.run.executionSnapshot?.settings,
        approval: approvalId ? { id: approvalId, approved: context.approval?.approved === true } : undefined
      } } : {}),
      actor: {
        sessionId: context.run.executionSessionId ?? `workflow-${context.run.id}`,
        channel: "system"
      },
      metadata: {
        attachments: context.task.attachments,
        mode,
        taskId: context.task.id,
        workflowId: context.workflow.id,
        workflowVersion: context.workflow.version,
        runId: context.run.id,
        nodeId: context.node.id
      }
    });

    const unknownOperation = result.tools.find(tool => tool.metadata?.unknown === true);
    if (unknownOperation) return {
      status: "blocked", event: "agent.operation_unknown", summary: unknownOperation.output, error: unknownOperation.output,
      data: { unknown: true, agentRunId, tools: result.tools, response: extractResponse(result) }
    };

    if (result.pendingApproval) return {
      status: "needs_input", event: "agent.approval_required", summary: result.pendingApproval.summary,
      data: { ...result.pendingApproval, permissionRequired: true, agentRunId, approvalId: result.pendingApproval.id, tools: result.tools }
    };

    // A failed tool may have been handled by a later agent turn; only the final outcome fails the node.
    const error = result.result.error;
    return {
      status: error ? "failed" : "ok",
      event: error ? "agent.failed" : "agent.completed",
      error,
      summary: extractSummary(result),
      data: {
        agentRunId,
        target: {
          providerId: result.providerId,
          model: extractModel(result)
        },
        response: extractResponse(result),
        tools: result.tools
      }
    };
  }
}

const readMode = (value: unknown): "general" | "code" | "hypothesis" => {
  return value === "general" || value === "hypothesis" || value === "code" ? value : "code";
};

const readOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const extractSummary = (result: ProcessResult): string => {
  if ("response" in result.result) {
    return result.result.response.slice(0, 1000);
  }

  return result.result.conclusion || result.result.verdict || "Agent node completed.";
};

const extractResponse = (result: ProcessResult): string =>
  "response" in result.result
    ? result.result.response
    : result.result.conclusion || result.result.verdict || "";

const extractModel = (result: ProcessResult): string | undefined =>
  "model" in result.result ? result.result.model : result.sessionSettings.defaultTarget.model;
