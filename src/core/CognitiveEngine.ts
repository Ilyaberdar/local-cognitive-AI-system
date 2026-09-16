import { authorizeOperation } from "../tools/AccessPolicy";
import { MemoryService } from "../memory/MemoryService";
import { SessionSettingsStore } from "../session/SessionSettingsStore";
import { ToolRegistry } from "../tools/ToolRegistry";
import { Logger } from "../utils/Logger";
import { ProcessInput, ProcessResult, SessionSettings, ToolExecutionResult } from "../types";
import { ModeDetector } from "./ModeDetector";
import { Router } from "./Router";
import { ToolRequestBuilder } from "./ToolRequestBuilder";
import { resolveProviderTarget } from "../llm/ProviderTargetResolver";

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
    const activeTarget = resolveProviderTarget(request, sessionSettings.defaultTarget ?? { providerId: this.defaultProviderId });
    const providerId = activeTarget.providerId;
    const memory = await this.memoryService.retrieve(normalizedInput, { actor });
    const conversation = await this.memoryService.recent({ actor, limit: 12 });
    const startedAt = new Date();
    const metadataMode = this.readMetadataMode(request.metadata);
    const requestedMode =
      metadataMode ??
      (sessionSettings.mode === "auto"
        ? sessionSettings.debate.enabled
          ? "hypothesis"
          : this.modeDetector.detect(normalizedInput)
        : sessionSettings.mode);
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
      requestMetadata: request.metadata,
      signal: request.signal,
      onProgress: request.onProgress
    });
    request.signal?.throwIfAborted();
    request.onProgress?.({
      phase: "tools",
      label: "Applying tools",
      detail: "Executing requested file and plugin actions",
      at: new Date().toISOString()
    });
    const tools = result.error ? [] : await this.executeTools(normalizedInput, mode, result, {
      actor,
      memory,
      conversation,
      providerId,
      activeTarget,
      sessionSettings,
      signal: request.signal,
      requestMetadata: request.metadata,
      requestApproval: request.requestApproval
    });
    if ("response" in result && result.toolPayload && !tools.some((tool) => tool.tool === "file")) {
      result.response = result.toolPayload;
    }
    const fileOperation = tools.find((tool) => tool.tool === "file");
    if ("response" in result && (fileOperation?.metadata?.cancelled || fileOperation?.metadata?.permissionRequired)) {
      const russian = sessionSettings.language === "ru" || (sessionSettings.language === "auto" && /[А-Яа-яЁё]/.test(normalizedInput));
      // The model only proposed these contents. A declined write must never leave
      // its unexecuted payload or a model's success claim in the final response.
      result.response = fileOperation.metadata.cancelled
        ? russian ? "Файловая операция отменена. Изменения не применены." : "File operation cancelled. No changes were applied."
        : fileOperation.output;
      delete result.toolPayload;
    }
    const selectedFileEdit = request.metadata?.reviewSelection ? fileOperation : undefined;
    if ("response" in result && selectedFileEdit) {
      const russian = sessionSettings.language === "ru" || (sessionSettings.language === "auto" && /[А-Яа-яЁё]/.test(normalizedInput));
      result.response = selectedFileEdit.metadata?.cancelled
        ? russian ? "Правка отменена. Файл не изменён." : "Edit cancelled. The file was not changed."
        : selectedFileEdit.ok && selectedFileEdit.metadata?.operation === "write"
          ? russian ? "Выделенный фрагмент обновлён. Остальной файл сохранён без изменений." : "Updated the selected text. The rest of the file is unchanged."
          : selectedFileEdit.output;
      delete result.toolPayload;
    }
    const command = tools.find((tool) => tool.tool === "command");
    if ("response" in result && command) {
      const russian = sessionSettings.language === "ru" || (sessionSettings.language === "auto" && /[А-Яа-яЁё]/.test(normalizedInput));
      result.response = command.metadata?.cancelled
        ? russian ? "Команда отменена." : "Command cancelled."
        : command.ok ? russian ? "Команда выполнена." : "Command completed."
        : command.output;
      delete result.toolPayload;
    }
    request.signal?.throwIfAborted();
    request.onProgress?.({
      phase: result.error ? "failed" : "complete",
      label: result.error ? "Failed" : "Complete",
      detail: result.error || "Final response is ready",
      at: new Date().toISOString()
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

  private readMetadataMode(metadata: Record<string, unknown> | undefined): "general" | "code" | "hypothesis" | undefined {
    const mode = metadata?.mode;

    return mode === "general" || mode === "code" || mode === "hypothesis" ? mode : undefined;
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
    const resolved = this.toolRegistry.resolveFromInput(input);
    const tools = resolved.some((tool) => tool.name === "command") ? resolved.filter((tool) => tool.name !== "file") : resolved;

    if (tools.length === 0) {
      return [];
    }

    const executionRequest = this.toolRequestBuilder.build({
      rawInput: input,
      mode,
      result,
      context
    });

    const results: ToolExecutionResult[] = [];
    for (const tool of tools) {
      context.signal?.throwIfAborted();
      if (!["file", "command"].includes(tool.name)) {
        const permission = await authorizeOperation(context, {
          tool: tool.name, operation: "plugin", summary: `Run ${tool.name}`,
          details: `${tool.description}\n\n${executionRequest.content}`
        }, false);
        if (permission) { results.push(permission); continue; }
      }
      results.push(await tool.execute(executionRequest));
    }
    return results;
  }
}
