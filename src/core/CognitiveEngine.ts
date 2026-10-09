import { MemoryService } from "../memory/MemoryService";
import { SessionSettingsStore } from "../session/SessionSettingsStore";
import { ToolRegistry } from "../tools/ToolRegistry";
import { Logger } from "../utils/Logger";
import { Mode, ProcessInput, ProcessResult, ProviderTarget, SessionSettings, ToolExecutionResult } from "../types";
import { ModeDetector } from "./ModeDetector";
import { Router } from "./Router";
import { ToolRequestBuilder } from "./ToolRequestBuilder";
import { resolveProviderTarget } from "../llm/ProviderTargetResolver";
import { conversationAttachments, validateAttachments } from "../utils/attachments";
import { withInferenceImages } from "../llm/InferenceImages";
import { randomUUID } from "crypto";
import { WorkspaceResolver } from "../workspace/WorkspaceResolver";
import { CodeAgentCoordinator, WorkspaceOutcome } from "../agents/code/CodeAgentCoordinator";
import { ExecutionContext } from "../types";
import type { PluginManager } from "../plugins/PluginManager";
import { mentionedPluginIds, parsePluginSelection, withoutPluginMentions } from "../plugins/PluginSelection";
import { PluginError } from "../plugins/contracts";
import { parseMentionedSubagentNames } from "../agents/code/codeAgentRouting";
import { withoutHostMcp } from "../agents/runtime/AgentLoopRunner";
import { ActivityTrace } from "./ActivityTrace";

export class CognitiveEngine {
  constructor(
    private readonly modeDetector: ModeDetector,
    private readonly router: Router,
    private readonly memoryService: MemoryService,
    private readonly sessionSettingsStore: SessionSettingsStore,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolRequestBuilder: ToolRequestBuilder,
    private readonly logger: Logger,
    private readonly defaultProviderId: string,
    private readonly supportsImages: (target: ProviderTarget) => boolean | undefined = () => undefined,
    private readonly workspaceResolver?: WorkspaceResolver,
    private readonly workspaceAgents?: CodeAgentCoordinator,
    private readonly pluginManager?: PluginManager,
    private readonly externalMcpAvailable?: () => Promise<boolean>
  ) {}

  async process(request: ProcessInput): Promise<ProcessResult> {
    const trace = new ActivityTrace();
    const observer = request.onProgress;
    // Record even when there is no live observer so saved replies retain their activity.
    request = { ...request, onProgress: event => { const activity = trace.record(event); observer?.({ ...event, activity }); } };
    const approve = request.requestApproval;
    if (approve) request.requestApproval = async operation => {
      request.onProgress?.({ phase: "approval", label: "Waiting for approval", detail: operation.summary, at: new Date().toISOString() });
      const approved = await approve(operation);
      request.onProgress?.({ phase: "tools", label: approved ? "Action approved" : "Action declined", at: new Date().toISOString() });
      return approved;
    };
    const normalizedInput = request.input.trim();

    if (!normalizedInput) {
      throw new Error("Input cannot be empty");
    }

    // Workflow selection comes from its frozen node config, never interpolated tool output.
    const pluginIds = request.execution
      ? parsePluginSelection(request.execution.pluginIds)
      : parsePluginSelection(request.metadata?.pluginIds) ?? mentionedPluginIds(normalizedInput);
    if (pluginIds?.length && !this.pluginManager) throw new PluginError("Plugins are unavailable in this runtime.", 409);
    await this.pluginManager?.validateSelection(pluginIds);

    const sessionId=request.actor?.sessionId ?? "default-session";
    const needsToolWorkspace = Boolean(await this.pluginManager?.hasEnabled()) ||
      (!withoutHostMcp(request.metadata) && Boolean(await this.externalMcpAvailable?.()));
    const workspace=request.execution?.workspace??await this.workspaceResolver?.forSession(sessionId) ??
      (needsToolWorkspace ? await this.workspaceResolver?.forPluginChat(sessionId) : undefined);
    if(workspace)await this.workspaceResolver?.validate(workspace);
    const actor = {
      sessionId,
      userId: request.actor?.userId,
      channel: request.actor?.channel ?? "http",
      ...(workspace&&workspace.kind!=="legacy-chat"?{memoryScope:workspace.memoryScope,projectId:workspace.projectId}:{})
    } as const;
    const sessionSettings = structuredClone(request.execution?.settings??await this.sessionSettingsStore.get(actor.sessionId));
    if(request.execution)sessionSettings.defaultAccessMode=request.execution.accessMode;
    // A paired device's turn never runs with full access, even when the host gives it after the
    // turn was accepted: such a chat is used only on the host.
    if(request.metadata?.deviceRun===true&&sessionSettings.defaultAccessMode==="full")throw new Error("This chat has full access on the server, so it can only be used there.");
    const activeTarget = resolveProviderTarget(request, sessionSettings.defaultTarget ?? { providerId: this.defaultProviderId });
    const providerId = activeTarget.providerId;
    const explicitContext = request.execution?.contextMode === "explicit";
    const memory = explicitContext ? [] : await this.memoryService.retrieve(normalizedInput, { actor });
    const conversation = explicitContext ? [] : await this.memoryService.recent({ actor, limit: 12 });
    const currentAttachments = validateAttachments(request.metadata?.attachments);
    // A workflow uses its task's current attachment list; removing a task file
    // must also remove it from later runs. Chat follow-ups retain recent files.
    const attachments = request.metadata?.taskId || request.metadata?.includePreviousAttachments === false
      ? currentAttachments : conversationAttachments(currentAttachments, conversation, this.supportsImages(activeTarget) !== false);
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
    const context:ExecutionContext={
      pluginIds,
      actor,
      memory,
      conversation,
      providerId,
      activeTarget,
      sessionSettings,
      requestMetadata: { ...request.metadata, attachments },
      signal: request.signal,
      onProgress: request.onProgress,
      requestApproval:request.requestApproval,
      workspace,
      execution:request.execution??(workspace?{workspace,accessMode:sessionSettings.defaultAccessMode,agentRunId:randomUUID()}:undefined)
    };
    let workspaceOutcome:WorkspaceOutcome|undefined;
    // A turn stopped after its agents acted (a scene built in an editor, a file written) stays in the
    // chat with what was done; one stopped before any action leaves nothing.
    const stopped = async (error: unknown): Promise<never> => {
      const agentRunId = context.execution?.agentRunId;
      if (request.signal?.aborted && agentRunId && this.workspaceAgents) {
        await this.recordStopped(normalizedInput, mode, actor, providerId, activeTarget.model, sessionSettings, trace, request.metadata,
          await this.workspaceAgents.completedTools(agentRunId)).catch(() => undefined);
      }
      throw error;
    };
    const result = await withInferenceImages(attachments.filter(file => file.kind === "image" && file.dataUrl).map(file => ({ name: file.name, dataUrl: file.dataUrl! })), async () => {
      if(workspace&&this.workspaceAgents&&!request.metadata?.reviewSelection){workspaceOutcome=await this.workspaceAgents.run(normalizedInput,mode,context,handler);return workspaceOutcome.result;}
      return handler(normalizedInput,context);
    }).catch(stopped);
    if(workspaceOutcome?.pendingApproval)return {input:normalizedInput,mode,providerId,result,tools:workspaceOutcome.tools,memory,conversationSize:conversation.length,sessionSettings,
      pendingApproval:workspaceOutcome.pendingApproval,agentRunId:workspaceOutcome.agentRunId};
    if (request.signal?.aborted) await stopped(request.signal.reason);
    const tools = workspaceOutcome?.tools ?? (result.error ? [] : await this.executeTools(normalizedInput, mode, result, {
      actor,
      memory,
      conversation,
      providerId,
      activeTarget,
      sessionSettings,
      signal: request.signal,
      requestMetadata: request.metadata,
      onProgress: request.onProgress,
      requestApproval: request.requestApproval,
      workspace
    }));
    if ("response" in result && result.toolPayload && !tools.some((tool) => tool.tool === "file")) {
      result.response = result.toolPayload;
    }
    const fileOperation = workspaceOutcome?undefined:tools.find((tool) => tool.tool === "file");
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
    const command = workspaceOutcome?undefined:tools.find((tool) => tool.tool === "command");
    if ("response" in result && command) {
      const russian = sessionSettings.language === "ru" || (sessionSettings.language === "auto" && /[А-Яа-яЁё]/.test(normalizedInput));
      result.response = command.metadata?.cancelled
        ? russian ? "Команда отменена." : "Command cancelled."
        : command.ok ? russian ? "Команда выполнена." : "Command completed."
        : command.output;
      delete result.toolPayload;
    }
    if (request.signal?.aborted) await stopped(request.signal.reason);
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
        activity: trace.snapshot(),
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
      sessionSettings,
      agentRunId:workspaceOutcome?.agentRunId
    };
  }

  private readMetadataMode(metadata: Record<string, unknown> | undefined): "general" | "code" | "hypothesis" | undefined {
    const mode = metadata?.mode;

    return mode === "general" || mode === "code" || mode === "hypothesis" ? mode : undefined;
  }

  /** Records a stopped turn with the operations its agents completed, so the chat shows them. */
  private async recordStopped(input: string, mode: Mode, actor: Parameters<MemoryService["save"]>[0]["actor"], providerId: string, model: string | undefined,
    sessionSettings: SessionSettings, trace: ActivityTrace, requestMetadata: Record<string, unknown> | undefined, tools: ToolExecutionResult[]): Promise<void> {
    if (!tools.length) return;
    const russian = sessionSettings.language === "ru" || (sessionSettings.language === "auto" && /[А-Яа-яЁё]/.test(input));
    const done = tools.map(tool => tool.metadata?.operation ? `${tool.metadata.serverId ?? tool.tool} · ${tool.metadata.operation}` : tool.tool).join(", ");
    const text = russian ? `Остановлено до ответа. Выполненные действия: ${done}.` : `Stopped before the answer. Completed actions: ${done}.`;
    const at = new Date().toISOString();
    await this.memoryService.save({
      input, mode, actor, scope: `agent_${mode}`, tags: [mode, "stopped"],
      output: { response: text, error: text, provider: providerId, model: model ?? "default", metrics: { startedAt: at, completedAt: at, durationMs: 0 } },
      metadata: { toolCount: tools.length, tools, activity: trace.snapshot(), providerId, model, sessionSettings, requestMetadata, stopped: true }
    });
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

    const mentions = parseMentionedSubagentNames(withoutPluginMentions(input));

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
    const resolved = this.toolRegistry.resolveFromInput(input).filter(tool => ["file", "command"].includes(tool.name));
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
      const operationId = randomUUID();
      context.onProgress?.({ phase: "tools", label: tool.name === "command" ? "Running command" : "Applying file operation", operationId, at: new Date().toISOString() });
      const result = await tool.execute(executionRequest);
      results.push(result);
      context.onProgress?.({ phase: result.ok ? "tool_result" : "tool_error", label: result.ok ? "Action completed" : "Action failed", operationId, at: new Date().toISOString() });
    }
    return results;
  }
}
