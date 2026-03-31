import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { NextFunction, Request, Response } from "express";
import {
  AppSettingsPatch,
  ChatMessage,
  GenerationMetrics,
  LanguagePreference,
  SessionMode,
  SessionSettingsPatch
} from "../types";
import { RuntimeManager } from "../app/RuntimeManager";
import { SessionIndexStore } from "../session/SessionIndexStore";

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

      const runtime = runtimeManager.getRuntime();
      const resolvedSessionId =
        typeof sessionId === "string" && sessionId.trim() ? sessionId : randomUUID();

      await sessionIndexStore.touch(resolvedSessionId, {
        title: typeof sessionTitle === "string" ? sessionTitle : input.slice(0, 60),
        channel: channel === "telegram" ? "telegram" : "http"
      });

      const result = await runtime.engine.process({
        input,
        providerId: typeof providerId === "string" ? providerId : undefined,
        model: typeof model === "string" ? model : undefined,
        actor: {
          sessionId: resolvedSessionId,
          userId: typeof userId === "string" ? userId : undefined,
          channel: channel === "telegram" ? "telegram" : "http"
        },
        metadata
      });

      res.status(200).json({
        ...result,
        sessionId: resolvedSessionId
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
      const [appSettings, sessions, availableModels, loadedModels, allManagedModels] = await Promise.all([
        runtimeManager.getSettings(),
        sessionIndexStore.list(),
        runtime.modelCatalog.listAll(),
        runtime.lmStudioManager.listLoadedModels(),
        runtime.lmStudioManager.listAllModels()
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
        availableModels,
        loadedModels,
        allManagedModels
      });
    } catch (error) {
      next(error);
    }
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
              createdAt: entry.createdAt
            },
            {
              id: `${entry.id}:assistant`,
              role: "assistant",
              content: formatted,
              createdAt: entry.createdAt,
              metrics: readStoredMetrics(entry.output, entry.metadata)
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
        usage: response.usage
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
          await fs.mkdir(outputDir, { recursive: true });
          const filePath = path.join(outputDir, `plugin-check-${Date.now()}.md`);
          await fs.writeFile(filePath, "# File plugin check\n\nThe file plugin is configured.\n", "utf8");

          res.status(200).json({
            ok: true,
            plugin: pluginName,
            status: "configured",
            message: `Test file written to ${filePath}`,
            metadata: {
              filePath
            }
          });
          return;
        }
        case "notion": {
          const apiKey = readPluginValue(settings, "notion", "apiKey");
          const parentPageId = readPluginValue(settings, "notion", "parentPageId");
          const dataSourceId = readPluginValue(settings, "notion", "dataSourceId");
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
          res.status(200).json({
            ok: false,
            plugin: pluginName,
            status: "not_implemented",
            message: "VS Code bridge is not implemented yet. This panel stores future config only."
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

  return formatter.formatForChat({
    input: entry.input,
    mode: entry.mode,
    providerId: String(entry.metadata?.providerId ?? "unknown"),
    result: entry.output as never,
    tools: [],
    memory: [],
    conversationSize: 0,
    sessionSettings: {
      mode: "auto",
      language: "auto",
      defaultTarget: {
        providerId: "unknown"
      },
      debate: {
        enabled: false,
        profile: "general",
        support: { providerId: "unknown" },
        attack: { providerId: "unknown" },
        judge: { providerId: "local" }
      }
    }
  });
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
    summary = configured
      ? `Output dir: ${readPluginValue(settings, "file", "outputDir")}`
      : "Output directory is missing.";
  } else if (name === "notion") {
    const hasKey = Boolean(readPluginValue(settings, "notion", "apiKey"));
    const hasParent = Boolean(readPluginValue(settings, "notion", "parentPageId"));
    const hasSource = Boolean(readPluginValue(settings, "notion", "dataSourceId"));
    configured = hasKey && (hasParent || hasSource);
    summary = configured
      ? "API key and target container are configured."
      : "Need API key and parent page or data source id.";
  } else if (name === "vscode") {
    configured = false;
    summary = "Placeholder config only. Bridge is not implemented yet.";
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
