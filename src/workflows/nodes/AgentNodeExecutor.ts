import { CognitiveEngine } from "../../core/CognitiveEngine";
import { ProcessResult } from "../../types";
import { NodeResult } from "../types";
import { NodeExecutor, NodeExecutionContext } from "./NodeExecutor";

export class AgentNodeExecutor implements NodeExecutor {
  readonly type = "agent" as const;

  constructor(
    private readonly engine: CognitiveEngine,
    private readonly providerDefaults: Record<string, string | undefined> = {}
  ) {}

  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    const prompt = renderPromptTemplate(
      String(context.node.config.promptTemplate ?? "{{task.title}}\n\n{{task.description}}"),
      context
    );
    const mode = readMode(context.node.config.mode);
    const providerId = readOptionalString(context.node.config.providerId);
    const model =
      readOptionalString(context.node.config.model) ??
      (providerId ? this.providerDefaults[providerId] : undefined);
    const result = await this.engine.process({
      input: prompt,
      providerId,
      model,
      actor: {
        sessionId: context.task.sessionId ?? `task-${context.task.id}`,
        channel: "system"
      },
      metadata: {
        mode,
        taskId: context.task.id,
        workflowId: context.workflow.id,
        workflowVersion: context.workflow.version,
        runId: context.run.id,
        nodeId: context.node.id
      }
    });

    return {
      status: "ok",
      event: "agent.completed",
      summary: extractSummary(result),
      data: {
        target: {
          providerId: result.providerId,
          model: extractModel(result)
        },
        processResult: result
      }
    };
  }
}

const readMode = (value: unknown): "general" | "code" | "hypothesis" => {
  return value === "general" || value === "hypothesis" || value === "code" ? value : "code";
};

const readOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const renderPromptTemplate = (
  template: string,
  context: NodeExecutionContext
): string =>
  template
    .replaceAll("{{task.title}}", context.task.title)
    .replaceAll("{{task.description}}", context.task.description)
    .replaceAll("{{workflow.name}}", context.workflow.name)
    .replaceAll("{{node.label}}", context.node.label);

const extractSummary = (result: ProcessResult): string => {
  if ("response" in result.result) {
    return result.result.response.slice(0, 1000);
  }

  return result.result.conclusion || result.result.verdict || "Agent node completed.";
};

const extractModel = (result: ProcessResult): string | undefined =>
  "model" in result.result ? result.result.model : result.sessionSettings.defaultTarget.model;
