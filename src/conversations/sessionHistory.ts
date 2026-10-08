import type { RuntimeManager } from "../app/RuntimeManager";
import type { ChatMessage, GenerationMetrics, SubagentRunSummary, ToolExecutionResult } from "../types";
import { readAttachments } from "../utils/attachments";

/** A session's completed turns from memory, as the chat screen shows them. Memory is keyed by
 * channel "http" and the local profile, so every caller on this machine shares one history.
 * `runIds` lists durable chat runs (RunService) already present as completed turns. */
export const loadSessionMessages = async (runtimeManager: RuntimeManager, sessionId: string, limit = 60): Promise<{ messages: ChatMessage[]; runIds: Set<string> }> => {
  const runtime = runtimeManager.getRuntime();
  const settings = await runtimeManager.getSettings();
  const session = await runtime.sessionIndexStore?.get(sessionId);
  const entries = await runtime.memoryService.recent({
    actor: {
      sessionId,
      userId: settings.memory.localProfileId,
      channel: "http",
      ...(session?.projectId ? { projectId: session.projectId, memoryScope: `project:${session.projectId}` } : {})
    },
    limit
  });
  const runIds = new Set<string>();
  const messages = entries
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .flatMap((entry): ChatMessage[] => {
      const requestMetadata = entry.metadata?.requestMetadata as Record<string, unknown> | undefined;
      const runId = typeof requestMetadata?.chatRunId === "string" ? requestMetadata.chatRunId : undefined;
      if (runId) runIds.add(runId);
      return [
        {
          id: `${entry.id}:user`,
          role: "user",
          content: entry.input,
          createdAt: entry.createdAt,
          includePreviousAttachments: requestMetadata?.includePreviousAttachments === false ? false : undefined,
          attachments: readAttachments(requestMetadata ?? undefined),
          ...(runId ? { runId } : {})
        },
        {
          id: `${entry.id}:assistant`,
          role: "assistant",
          content: buildStoredMessageContent(runtime.formatter, entry),
          createdAt: entry.createdAt,
          metrics: readStoredMetrics(entry.output, entry.metadata),
          activity: Array.isArray(entry.metadata?.activity) ? entry.metadata.activity as ChatMessage["activity"] : undefined,
          tools: readStoredTools(entry.metadata),
          subagents: readStoredSubagents(entry.output),
          ...(runId ? { runId } : {})
        }
      ];
    });
  return { messages, runIds };
};

const buildStoredMessageContent = (
  formatter: ReturnType<RuntimeManager["getRuntime"]>["formatter"],
  entry: {
    input: string;
    mode: "hypothesis" | "code" | "general";
    output: unknown;
    metadata?: Record<string, unknown>;
  }
): string => {
  if (!entry.output || typeof entry.output !== "object") {
    return JSON.stringify(entry.output, null, 2);
  }

  return formatter.formatForChat(
    {
      input: entry.input,
      mode: entry.mode,
      providerId: String(entry.metadata?.providerId ?? "unknown"),
      result: entry.output as never,
      tools: readStoredTools(entry.metadata),
      memory: [],
      conversationSize: 0,
      sessionSettings: {
        mode: "auto",
        language: "auto",
        outputStyle: "balanced",
	      reasoningEffort: "medium",
	        defaultTarget: {
	          providerId: "unknown"
	        },
	        defaultAccessMode: "default",
	        codeAgents: [],
        hypothesisAgents: [],
        debate: {
          enabled: false,
          profile: "general",
          support: { providerId: "unknown" },
          attack: { providerId: "unknown" },
          judge: { providerId: "local" }
        }
      }
    }
  );
};

const readStoredMetrics = (
  output: unknown,
  metadata?: Record<string, unknown>
) : GenerationMetrics | undefined => {
  if (output && typeof output === "object" && "metrics" in output) {
    const metrics = (output as { metrics?: unknown }).metrics;
    if (isGenerationMetrics(metrics)) {
      return metrics;
    }
  }

  const candidate = metadata?.metrics;
  return isGenerationMetrics(candidate) ? candidate : undefined;
};

const readStoredTools = (metadata?: Record<string, unknown>): ToolExecutionResult[] => {
  const candidate = metadata?.tools;

  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter(isToolExecutionResult);
};

const readStoredSubagents = (output: unknown): SubagentRunSummary[] => {
  if (!output || typeof output !== "object" || !("subagents" in output)) {
    return [];
  }

  const candidate = (output as { subagents?: unknown }).subagents;

  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter(isSubagentRunSummary);
};

const isGenerationMetrics = (value: unknown): value is GenerationMetrics => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.startedAt === "string" &&
    typeof record.completedAt === "string" &&
    typeof record.durationMs === "number"
  );
};

const isToolExecutionResult = (value: unknown): value is ToolExecutionResult => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.tool === "string" &&
    typeof record.ok === "boolean" &&
    typeof record.output === "string"
  );
};

const isSubagentRunSummary = (value: unknown): value is SubagentRunSummary => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    (record.role === "writer" || record.role === "advisor") &&
    typeof record.provider === "string" &&
    (record.status === "ok" || record.status === "degraded")
  );
};
