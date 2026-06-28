import { execFileSync } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { NextFunction, Request, Response } from "express";
import {
  AppSettingsPatch,
  ChatMessage,
  GenerationMetrics,
  LanguagePreference,
  OutputStyle,
  SessionMode,
  SessionSettingsPatch,
  SubagentRunSummary,
  SystemMetrics,
  ToolExecutionResult
} from "../types";
import { RuntimeManager } from "../app/RuntimeManager";
import { SessionIndexStore } from "../session/SessionIndexStore";
import { processRuntimeInput } from "../transports/shared/runtimeActions";
import { extractNotionId } from "../utils/notion";
import { readAttachments } from "../utils/attachments";

export const createProcessController =
  (runtimeManager: RuntimeManager, sessionIndexStore: SessionIndexStore) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const {
        input,
        sessionId,
        sessionTitle,
        userId,
        providerId,
        model,
        channel,
        metadata
      } = req.body as {
        input?: unknown;
        sessionId?: unknown;
        sessionTitle?: unknown;
        userId?: unknown;
        providerId?: unknown;
        model?: unknown;
        channel?: unknown;
        metadata?: Record<string, unknown>;
      };

      if (typeof input !== "string" || input.trim().length === 0) {
        res.status(400).json({
          error: "Field 'input' must be a non-empty string."
        });
        return;
      }

      const result = await processRuntimeInput(
        runtimeManager,
        sessionIndexStore,
        {
          input,
          sessionId: typeof sessionId === "string" ? sessionId : undefined,
          sessionTitle: typeof sessionTitle === "string" ? sessionTitle : undefined,
          userId: typeof userId === "string" ? userId : undefined,
          providerId: typeof providerId === "string" ? providerId : undefined,
          model: typeof model === "string" ? model : undefined,
          metadata
        },
        channel === "telegram" || channel === "mcp" ? channel : "http"
      );

      res.status(200).json({
        ...result
      });
    } catch (error) {
      next(error);
    }
  };

export const createMetadataController =
  (runtimeManager: RuntimeManager) =>
  async (_req: Request, res: Response): Promise<void> => {
    const runtime = runtimeManager.getRuntime();
    res.status(200).json({
      providers: runtime.providerDescriptors,
      tools: runtime.tools,
      plugins: runtime.plugins
    });
  };

export const createDashboardBootstrapController =
  (runtimeManager: RuntimeManager, sessionIndexStore: SessionIndexStore) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const [
        appSettings,
        sessions,
        availableModels,
        loadedModels,
        allManagedModels,
        tasks,
        workflows,
        workflowRuns
      ] = await Promise.all([
        runtimeManager.getSettings(),
        sessionIndexStore.list(),
        runtime.modelCatalog.listAll(),
        runtime.localModelManager.listLoadedModels(),
        runtime.localModelManager.listAllModels(),
        runtime.taskService.list(),
        runtime.workflowStore.list(),
        runtime.workflowRunStore.listRuns()
      ]);

      const loadedNames = new Set(runtime.plugins.map((plugin) => plugin.manifest.name));

      res.status(200).json({
        providers: runtime.providerDescriptors,
        tools: runtime.tools,
        plugins: runtime.plugins,
        pluginStatuses: [...new Set([...Object.keys(appSettings.plugins), ...runtime.plugins.map((plugin) => plugin.manifest.name)])]
          .sort()
          .map((name) => buildPluginStatus(name, appSettings, loadedNames)),
        appSettings,
        sessions,
        tasks,
        workflows,
        workflowRuns,
        availableModels,
        loadedModels,
        allManagedModels,
        systemMetrics: getSystemMetricsSnapshot()
      });
    } catch (error) {
      next(error);
    }
  };

export const createSystemMetricsController =
  () =>
  async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json(getSystemMetricsSnapshot());
  };

export const createModelsController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const providerId = typeof req.query.providerId === "string" ? req.query.providerId : undefined;
      const models = await runtime.modelCatalog.listAll(providerId);
      res.status(200).json(models);
    } catch (error) {
      next(error);
    }
  };

export const createGetLoadedModelsController =
  (runtimeManager: RuntimeManager) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      res.status(200).json(await runtime.lmStudioManager.listLoadedModels());
    } catch (error) {
      next(error);
    }
  };

export const createGetAllManagedModelsController =
  (runtimeManager: RuntimeManager) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      res.status(200).json(await runtime.lmStudioManager.listAllModels());
    } catch (error) {
      next(error);
    }
  };

export const createGetLoadedLocalModelsController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const providerId = typeof req.query.providerId === "string" ? req.query.providerId : undefined;
      res.status(200).json(await runtime.localModelManager.listLoadedModels(providerId));
    } catch (error) {
      next(error);
    }
  };

export const createGetAllLocalModelsController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const providerId = typeof req.query.providerId === "string" ? req.query.providerId : undefined;
      res.status(200).json(await runtime.localModelManager.listAllModels(providerId));
    } catch (error) {
      next(error);
    }
  };

export const createLoadLocalModelController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const providerId = typeof req.body?.providerId === "string" ? req.body.providerId : undefined;
      const modelId = typeof req.body?.modelId === "string" ? req.body.modelId : undefined;

      if (!providerId || !modelId) {
        res.status(400).json({
          error: "Fields 'providerId' and 'modelId' must be non-empty strings."
        });
        return;
      }

      const runtime = runtimeManager.getRuntime();
      await runtime.localModelManager.loadModel(providerId, modelId);
      res.status(200).json({ ok: true, providerId, modelId });
    } catch (error) {
      next(error);
    }
  };

export const createUnloadLocalModelController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const providerId = typeof req.body?.providerId === "string" ? req.body.providerId : undefined;
      const modelIdOrInstanceId =
        typeof req.body?.modelIdOrInstanceId === "string"
          ? req.body.modelIdOrInstanceId
          : undefined;

      if (!providerId || !modelIdOrInstanceId) {
        res.status(400).json({
          error: "Fields 'providerId' and 'modelIdOrInstanceId' must be non-empty strings."
        });
        return;
      }

      const runtime = runtimeManager.getRuntime();
      await runtime.localModelManager.unloadModel(providerId, modelIdOrInstanceId);
      res.status(200).json({ ok: true, providerId, modelIdOrInstanceId });
    } catch (error) {
      next(error);
    }
  };

export const createLoadModelController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const modelId = typeof req.body?.modelId === "string" ? req.body.modelId : undefined;

      if (!modelId) {
        res.status(400).json({ error: "Field 'modelId' must be a string." });
        return;
      }

      const runtime = runtimeManager.getRuntime();
      await runtime.lmStudioManager.loadModel(modelId);
      res.status(200).json({ ok: true, modelId });
    } catch (error) {
      next(error);
    }
  };

export const createUnloadModelController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const modelIdOrInstanceId =
        typeof req.body?.modelIdOrInstanceId === "string"
          ? req.body.modelIdOrInstanceId
          : undefined;

      if (!modelIdOrInstanceId) {
        res.status(400).json({ error: "Field 'modelIdOrInstanceId' must be a string." });
        return;
      }

      const runtime = runtimeManager.getRuntime();
      await runtime.lmStudioManager.unloadModel(modelIdOrInstanceId);
      res.status(200).json({ ok: true, modelIdOrInstanceId });
    } catch (error) {
      next(error);
    }
  };

export const createGetSessionSettingsController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const settings = await runtime.sessionSettingsStore.get(String(req.params.sessionId));
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  };

export const createUpdateSessionSettingsController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const body = req.body as Record<string, unknown>;
      const patch: SessionSettingsPatch = {
        mode: isSessionMode(body.mode) ? body.mode : undefined,
        language: isLanguagePreference(body.language) ? body.language : undefined,
        outputStyle: isOutputStyle(body.outputStyle) ? body.outputStyle : undefined,
	        defaultTarget: isObject(body.defaultTarget)
	          ? {
              providerId:
                typeof body.defaultTarget.providerId === "string"
                  ? body.defaultTarget.providerId
                  : undefined,
              model:
                typeof body.defaultTarget.model === "string" ? body.defaultTarget.model : undefined
	            }
	          : undefined,
	        defaultAccessMode: body.defaultAccessMode === "full" ? "full" : body.defaultAccessMode === "default" ? "default" : undefined,
	        codeAgents: Array.isArray(body.codeAgents)
          ? body.codeAgents
              .filter(isObject)
              .map((agent, index) => ({
                id: typeof agent.id === "string" ? agent.id : `agent-${index + 1}`,
                name: typeof agent.name === "string" ? agent.name : `Agent${index + 1}`,
                providerId:
                  typeof agent.providerId === "string" ? agent.providerId : "lmstudio",
                model: typeof agent.model === "string" ? agent.model : undefined,
                accessMode: agent.accessMode === "full" ? "full" : "default"
              }))
          : undefined,
        subagents: Array.isArray(body.subagents)
          ? body.subagents
              .filter(isObject)
              .map((agent, index) => ({
                id: typeof agent.id === "string" ? agent.id : `agent-${index + 1}`,
                name: typeof agent.name === "string" ? agent.name : `Agent${index + 1}`,
                providerId:
                  typeof agent.providerId === "string" ? agent.providerId : "lmstudio",
                model: typeof agent.model === "string" ? agent.model : undefined,
                accessMode: agent.accessMode === "full" ? "full" : "default"
              }))
          : undefined,
        hypothesisAgents: Array.isArray(body.hypothesisAgents)
          ? body.hypothesisAgents
              .filter(isObject)
              .map((agent, index) => ({
                id: typeof agent.id === "string" ? agent.id : `hypothesis-${index + 1}`,
                name: typeof agent.name === "string" ? agent.name : `Hypothesis${index + 1}`,
                role:
                  agent.role === "support" ||
                  agent.role === "attack" ||
                  agent.role === "judge" ||
                  agent.role === "advisor"
                    ? agent.role
                    : "advisor",
                providerId:
                  typeof agent.providerId === "string" ? agent.providerId : "lmstudio",
                model: typeof agent.model === "string" ? agent.model : undefined
              }))
          : undefined,
        debate: isObject(body.debate)
          ? {
              enabled:
                typeof body.debate.enabled === "boolean" ? body.debate.enabled : undefined,
              profile:
                isDebateProfile(body.debate.profile) ? body.debate.profile : undefined,
              support: readTarget(body.debate.support),
              attack: readTarget(body.debate.attack),
              judge: readTarget(body.debate.judge)
            }
          : undefined
      };

      const settings = await runtime.sessionSettingsStore.update(String(req.params.sessionId), patch);
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  };

export const createListSessionsController =
  (sessionIndexStore: SessionIndexStore) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await sessionIndexStore.list());
    } catch (error) {
      next(error);
    }
  };

export const createCreateSessionController =
  (sessionIndexStore: SessionIndexStore) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const title = typeof req.body?.title === "string" ? req.body.title : undefined;
      const session = await sessionIndexStore.create(title);
      res.status(201).json(session);
    } catch (error) {
      next(error);
    }
  };

export const createRenameSessionController =
  (sessionIndexStore: SessionIndexStore) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const title = typeof req.body?.title === "string" ? req.body.title : undefined;

      if (!title?.trim()) {
        res.status(400).json({ error: "Field 'title' must be a non-empty string." });
        return;
      }

      const session = await sessionIndexStore.rename(String(req.params.sessionId), title);

      if (!session) {
        res.status(404).json({ error: "Session not found." });
        return;
      }

      res.status(200).json(session);
    } catch (error) {
      next(error);
    }
  };

export const createDeleteSessionController =
  (runtimeManager: RuntimeManager, sessionIndexStore: SessionIndexStore) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const sessionId = String(req.params.sessionId);
      const runtime = runtimeManager.getRuntime();
      const deleted = await sessionIndexStore.delete(sessionId);

      if (!deleted) {
        res.status(404).json({ error: "Session not found." });
        return;
      }

      await runtime.sessionSettingsStore.delete(sessionId);
      await deleteSessionMemory(runtime.config.memory.baseDir, sessionId);

      res.status(200).json({ ok: true, sessionId });
    } catch (error) {
      next(error);
    }
  };

export const createGetSessionMessagesController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const entries = await runtime.memoryService.recent({
        actor: {
          sessionId: String(req.params.sessionId)
        },
        limit: 60
      });

      const messages = entries
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .flatMap((entry): ChatMessage[] => {
          const formatted = buildStoredMessageContent(runtime.formatter, entry);

          return [
            {
              id: `${entry.id}:user`,
              role: "user",
              content: entry.input,
              createdAt: entry.createdAt,
              attachments: readAttachments(
                (entry.metadata?.requestMetadata as Record<string, unknown> | undefined) ?? undefined
              )
            },
            {
              id: `${entry.id}:assistant`,
              role: "assistant",
              content: formatted,
              createdAt: entry.createdAt,
              metrics: readStoredMetrics(entry.output, entry.metadata),
              tools: readStoredTools(entry.metadata),
              subagents: readStoredSubagents(entry.output)
            }
          ];
        });

      res.status(200).json(messages);
    } catch (error) {
      next(error);
    }
  };

export const createGetAppSettingsController =
  (runtimeManager: RuntimeManager) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await runtimeManager.getSettings());
    } catch (error) {
      next(error);
    }
  };

export const createUpdateAppSettingsController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patch = req.body as AppSettingsPatch;
      const { settings, runtime } = await runtimeManager.updateSettings(patch);
      res.status(200).json({
        settings,
        providers: runtime.providerDescriptors,
        tools: runtime.tools,
        plugins: runtime.plugins
      });
    } catch (error) {
      next(error);
    }
  };

export const createRuntimeReloadController =
  (runtimeManager: RuntimeManager) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = await runtimeManager.reload();
      res.status(200).json({
        ok: true,
        providers: runtime.providerDescriptors,
        plugins: runtime.plugins
      });
    } catch (error) {
      next(error);
    }
  };

export const createProviderTestController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const providerId = String(req.params.providerId);
      const runtime = runtimeManager.getRuntime();
      const settings = await runtimeManager.getSettings();
      const providerSettings = settings.providers[providerId];

      if (!providerSettings?.enabled) {
        res.status(400).json({
          ok: false,
          providerId,
          message: "Provider is disabled."
        });
        return;
      }

      const response = await runtime.llmService.generateText(
        {
          model: providerSettings.model,
          prompt: "Reply exactly with: ok"
        },
        providerId
      );

      const isMockFallback =
        !response.raw &&
        typeof response.text === "string" &&
        response.text.startsWith(`Mock response from ${providerId}`);

      if (isMockFallback) {
        res.status(200).json({
          ok: false,
          providerId,
          model: response.model,
          message: "Provider request failed, timed out, or returned a fallback response."
        });
        return;
      }

      res.status(200).json({
        ok: true,
        providerId,
        model: response.model,
        message: `Provider responded successfully with model ${response.model}.`,
        usage: response.usage,
        rateLimit: response.rateLimit
      });
    } catch (error) {
      next(error);
    }
  };

export const createPluginStatusController =
  (runtimeManager: RuntimeManager) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const settings = await runtimeManager.getSettings();
      const loadedNames = new Set(runtime.plugins.map((plugin) => plugin.manifest.name));
      const pluginNames = new Set([
        ...Object.keys(settings.plugins),
        ...runtime.plugins.map((plugin) => plugin.manifest.name)
      ]);

      res.status(200).json(
        [...pluginNames].sort().map((name) => buildPluginStatus(name, settings, loadedNames))
      );
    } catch (error) {
      next(error);
    }
  };

export const createPluginTestController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const pluginName = String(req.params.pluginName);
      const runtime = runtimeManager.getRuntime();
      const settings = await runtimeManager.getSettings();

      switch (pluginName) {
        case "file": {
          const outputDir =
            readPluginValue(settings, "file", "outputDir") ?? runtime.config.outputDir;
          const accessMode = readPluginValue(settings, "file", "accessMode") ?? "restricted";
          const allowedDirectories = readPluginValue(settings, "file", "allowedDirectories") ?? "";
          await fs.mkdir(outputDir, { recursive: true });
          const filePath = path.join(outputDir, `plugin-check-${Date.now()}.md`);
          await fs.writeFile(filePath, "# File plugin check\n\nThe file plugin is configured.\n", "utf8");

          res.status(200).json({
            ok: true,
            plugin: pluginName,
            status: "configured",
            message: `Test file written to ${filePath}`,
            metadata: {
              filePath,
              accessMode,
              allowedDirectories
            }
          });
          return;
        }
        case "notion": {
          const apiKey = readPluginValue(settings, "notion", "apiKey");
          const parentPageId =
            extractNotionId(readPluginValue(settings, "notion", "parentPageUrl")) ??
            readPluginValue(settings, "notion", "parentPageId");
          const dataSourceId =
            extractNotionId(readPluginValue(settings, "notion", "dataSourceUrl")) ??
            readPluginValue(settings, "notion", "dataSourceId");
          const version = readPluginValue(settings, "notion", "version") ?? runtime.config.notion.version;

          if (!apiKey || (!parentPageId && !dataSourceId)) {
            res.status(200).json({
              ok: false,
              plugin: pluginName,
              status: "incomplete",
              message: "Notion plugin requires API key and parent page or data source id."
            });
            return;
          }

          const response = await fetch("https://api.notion.com/v1/users/me", {
            method: "GET",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Notion-Version": version
            }
          });

          if (!response.ok) {
            const text = await response.text();
            res.status(200).json({
              ok: false,
              plugin: pluginName,
              status: "error",
              message: `Notion auth failed: ${response.status}`,
              metadata: {
                details: text
              }
            });
            return;
          }

          const payload = (await response.json()) as { name?: string; object?: string };
          res.status(200).json({
            ok: true,
            plugin: pluginName,
            status: "configured",
            message: "Notion API credentials are valid.",
            metadata: payload
          });
          return;
        }
        case "vscode": {
          const accessMode = readPluginValue(settings, "vscode", "accessMode") ?? "restricted";
          const allowedDirectories = readPluginValue(settings, "vscode", "allowedDirectories") ?? "";
          res.status(200).json({
            ok: false,
            plugin: pluginName,
            status: "not_implemented",
            message: "VS Code bridge is not implemented yet. This panel stores future config and access boundaries only.",
            metadata: {
              accessMode,
              allowedDirectories
            }
          });
          return;
        }
        default:
          res.status(404).json({
            error: "Plugin not found."
          });
      }
    } catch (error) {
      next(error);
    }
  };

const isObject = (
  value: unknown
): value is Record<string, Record<string, unknown> | string | boolean | undefined> =>
  typeof value === "object" && value !== null;

const readTarget = (
  value: unknown
): Partial<{
  providerId: string;
  model: string;
}> | undefined => {
  if (!isObject(value)) {
    return undefined;
  }

  return {
    providerId: typeof value.providerId === "string" ? value.providerId : undefined,
    model: typeof value.model === "string" ? value.model : undefined
  };
};

const isSessionMode = (value: unknown): value is SessionMode =>
  value === "auto" || value === "general" || value === "code" || value === "hypothesis";

const isLanguagePreference = (value: unknown): value is LanguagePreference =>
  value === "auto" || value === "ru" || value === "en";

const isOutputStyle = (value: unknown): value is OutputStyle =>
  value === "compact" ||
  value === "balanced" ||
  value === "detailed" ||
  value === "exhaustive";

const isDebateProfile = (
  value: unknown
): value is NonNullable<SessionSettingsPatch["debate"]>["profile"] =>
  value === "general" ||
  value === "technical" ||
  value === "product" ||
  value === "research" ||
  value === "security";

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

const deleteSessionMemory = async (memoryBaseDir: string, sessionId: string): Promise<void> => {
  try {
    const scopes = await fs.readdir(memoryBaseDir, { withFileTypes: true });

    for (const scope of scopes) {
      if (!scope.isDirectory()) {
        continue;
      }

      const scopeDir = path.join(memoryBaseDir, scope.name);
      const files = await fs.readdir(scopeDir, { withFileTypes: true });

      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".json")) {
          continue;
        }

        const filePath = path.join(scopeDir, file.name);
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as { actor?: { sessionId?: string } };

        if (parsed.actor?.sessionId === sessionId) {
          await fs.unlink(filePath);
        }
      }
    }
  } catch {
    return;
  }
};

const getSystemMetricsSnapshot = (): SystemMetrics => {
  const cpuCores = Math.max(1, os.cpus().length);
  const loadAverage1m = os.loadavg()[0] ?? 0;
  const cpuPercent = Math.max(0, Math.min(100, (loadAverage1m / cpuCores) * 100));
  const macMetrics = readMacMemoryMetrics();
  const memoryTotalBytes = macMetrics?.memoryTotalBytes ?? os.totalmem();
  const memoryUsedBytes = macMetrics?.memoryUsedBytes ?? memoryTotalBytes - os.freemem();
  const memoryCachedBytes = macMetrics?.memoryCachedBytes;
  const ramPercent =
    memoryTotalBytes > 0 ? Math.max(0, Math.min(100, (memoryUsedBytes / memoryTotalBytes) * 100)) : 0;

  return {
    cpuPercent,
    ramPercent,
    memoryUsedBytes,
    memoryTotalBytes,
    memoryCachedBytes,
    cpuCores,
    loadAverage1m
  };
};

const readMacMemoryMetrics = ():
  | {
      memoryTotalBytes: number;
      memoryUsedBytes: number;
      memoryCachedBytes: number;
    }
  | null => {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const vmStatOutput = execFileSync("/usr/bin/vm_stat", { encoding: "utf8" });
    const totalMemOutput = execFileSync("/usr/sbin/sysctl", ["-n", "hw.memsize"], { encoding: "utf8" });
    const pageSizeMatch = vmStatOutput.match(/page size of (\d+) bytes/);
    const pageSize = Number(pageSizeMatch?.[1] || 4096);
    const totalBytes = Number(String(totalMemOutput).trim());

    const getPages = (label: string): number => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = vmStatOutput.match(new RegExp(`${escaped}:\\s+(\\d+)\\.`));
      return Number(match?.[1] || 0);
    };

    const free = getPages("Pages free");
    const fileBacked = getPages("File-backed pages");

    const memoryCachedBytes = Math.max(0, fileBacked) * pageSize;
    const memoryUsedBytes = Math.max(0, totalBytes - free * pageSize - memoryCachedBytes);

    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      return null;
    }

    return {
      memoryTotalBytes: totalBytes,
      memoryUsedBytes,
      memoryCachedBytes
    };
  } catch {
    return null;
  }
};

const buildPluginStatus = (
  name: string,
  settings: Awaited<ReturnType<RuntimeManager["getSettings"]>>,
  loadedNames: Set<string>
) => {
  const plugin = settings.plugins[name];
  const enabled = plugin?.enabled ?? false;
  const loaded = loadedNames.has(name);
  let configured = false;
  let summary = "No plugin metadata found.";

  if (name === "file") {
    configured = Boolean(readPluginValue(settings, "file", "outputDir"));
    const accessMode = readPluginValue(settings, "file", "accessMode") ?? "restricted";
    summary = configured
      ? `Output dir: ${readPluginValue(settings, "file", "outputDir")} · access: ${accessMode}`
      : "Output directory is missing.";
  } else if (name === "notion") {
    const hasKey = Boolean(readPluginValue(settings, "notion", "apiKey"));
    const hasParent = Boolean(
      extractNotionId(readPluginValue(settings, "notion", "parentPageUrl")) ??
        readPluginValue(settings, "notion", "parentPageId")
    );
    const hasSource = Boolean(
      extractNotionId(readPluginValue(settings, "notion", "dataSourceUrl")) ??
        readPluginValue(settings, "notion", "dataSourceId")
    );
    configured = hasKey && (hasParent || hasSource);
    summary = configured
      ? "API key and Notion target are configured."
      : "Need API key and parent page URL or data source URL.";
  } else if (name === "vscode") {
    configured = Boolean(readPluginValue(settings, "vscode", "workspaceRoot"));
    const accessMode = readPluginValue(settings, "vscode", "accessMode") ?? "restricted";
    summary = `Placeholder bridge config. Workspace root stored · access: ${accessMode}.`;
  }

  return {
    name,
    enabled,
    loaded,
    configured,
    summary
  };
};

const readPluginValue = (
  settings: Awaited<ReturnType<RuntimeManager["getSettings"]>>,
  pluginName: string,
  key: string
): string | undefined => {
  const value = settings.plugins[pluginName]?.values?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};
