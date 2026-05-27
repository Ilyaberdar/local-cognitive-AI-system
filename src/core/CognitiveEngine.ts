import { MemoryService } from "../memory/MemoryService";
import { SessionSettingsStore } from "../session/SessionSettingsStore";
import { ToolRegistry } from "../tools/ToolRegistry";
import { Logger } from "../utils/Logger";
import { ProcessInput, ProcessResult, SessionSettings, ToolExecutionResult } from "../types";
import { ModeDetector } from "./ModeDetector";
import { Router } from "./Router";
import { ToolRequestBuilder } from "./ToolRequestBuilder";

export class CognitiveEngine {
  constructor(
    private readonly modeDetector: ModeDetector,
    private readonly router: Router,
    private readonly memoryService: MemoryService,
    private readonly sessionSettingsStore: SessionSettingsStore,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolRequestBuilder: ToolRequestBuilder,
    private readonly logger: Logger,
    private readonly defaultProviderId: string
  ) {}

  async process(request: ProcessInput): Promise<ProcessResult> {
    const normalizedInput = request.input.trim();

    if (!normalizedInput) {
      throw new Error("Input cannot be empty");
    }

    const actor = {
      sessionId: request.actor?.sessionId ?? "default-session",
      userId: request.actor?.userId,
      channel: request.actor?.channel ?? "http"
    } as const;
    const sessionSettings = await this.sessionSettingsStore.get(actor.sessionId);
    const activeTarget = {
      providerId: request.providerId ?? sessionSettings.defaultTarget.providerId ?? this.defaultProviderId,
      model: request.model ?? sessionSettings.defaultTarget.model
    };
    const providerId = activeTarget.providerId;
    const memory = await this.memoryService.retrieve(normalizedInput, { actor });
    const conversation = await this.memoryService.recent({ actor, limit: 12 });
    const startedAt = new Date();
    const requestedMode =
      sessionSettings.mode === "auto"
        ? sessionSettings.debate.enabled
          ? "hypothesis"
          : this.modeDetector.detect(normalizedInput)
        : sessionSettings.mode;
    const mode =
      requestedMode !== "hypothesis" && this.shouldRunCodeAgents(normalizedInput, sessionSettings)
        ? "code"
        : requestedMode;
    const handler = this.router.route(mode);
    const result = await handler(normalizedInput, {
      actor,
      memory,
      conversation,
      providerId,
      activeTarget,
      sessionSettings,
      requestMetadata: request.metadata
    });
    const tools = await this.executeTools(normalizedInput, mode, result, {
      actor,
      memory,
      conversation,
      providerId,
      activeTarget,
      sessionSettings
    });
    const completedAt = new Date();
    const finalizedResult = this.attachMetrics(result, startedAt, completedAt);

    await this.memoryService.save({
      input: normalizedInput,
      mode,
      output: finalizedResult,
      actor,
      scope: `agent_${mode}`,
      tags: [mode, "processed"],
      metadata: {
        toolCount: tools.length,
        tools,
        providerId,
        model: activeTarget.model,
        metrics: "metrics" in finalizedResult ? finalizedResult.metrics : undefined,
        sessionSettings,
        requestMetadata: request.metadata
      }
    });

    this.logger.info("Input processed", {
      mode,
      toolCount: tools.length,
      providerId,
      sessionId: actor.sessionId
    });

    return {
      input: normalizedInput,
      mode,
      providerId,
      result: finalizedResult,
      tools,
      memory,
      conversationSize: conversation.length,
      sessionSettings
    };
  }

  private attachMetrics(
    result: ProcessResult["result"],
    startedAt: Date,
    completedAt: Date
  ): ProcessResult["result"] {
    const usage = "metrics" in result ? result.metrics?.usage : undefined;

    return {
      ...result,
      metrics: {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        usage
      }
    };
  }

  private shouldRunCodeAgents(input: string, settings: SessionSettings): boolean {
    if (/spawn\s+sub-?agent|sub-?agent|заспавн.*с[ау]б.?агент|с[ау]б.?агент/i.test(input)) {
      return true;
    }

    const mentions = Array.from(input.matchAll(/@([\p{L}\p{N}_-]+)/gu)).map((match) =>
      match[1].toLowerCase()
    );

    if (mentions.length === 0) {
      return false;
    }

    return settings.codeAgents.some((agent) => mentions.includes(agent.name.toLowerCase()));
  }

  private async executeTools(
    input: string,
    mode: ProcessResult["mode"],
    result: ProcessResult["result"],
    context: Parameters<ToolRequestBuilder["build"]>[0]["context"]
  ): Promise<ToolExecutionResult[]> {
    const tools = this.toolRegistry.resolveFromInput(input);

    if (tools.length === 0) {
      return [];
    }

    const executionRequest = this.toolRequestBuilder.build({
      rawInput: input,
      mode,
      result,
      context
    });

    return Promise.all(tools.map((tool) => tool.execute(executionRequest)));
  }
}
