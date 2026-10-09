import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { NextFunction, Request, Response } from "express";
import {
  AppSettingsPatch,
  LanguagePreference,
  OutputStyle,
  SessionMode,
  SessionSettingsPatch,
  SystemMetrics
} from "../types";
import { RuntimeManager } from "../app/RuntimeManager";
import { SessionIndexStore } from "../session/SessionIndexStore";
import { processRuntimeInput } from "../transports/shared/runtimeActions";
import { loadSessionMessages } from "../conversations/sessionHistory";
import { processRunRegistry } from "./ProcessRunRegistry";
import { systemMetricsSnapshot } from "../local/systemMetrics";
import { resolveReviewPath, revealWorkspacePath } from "./workspaceReview";
import { ProjectError } from "../projects/types";
import { isReasoningEffort } from "../llm/ReasoningEffort";

export const createProcessController =
  (runtimeManager: RuntimeManager, sessionIndexStore: SessionIndexStore) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId : randomUUID();
    if (processRunRegistry.get(requestId)) {
      res.status(409).json({ error: "Process request id already exists." });
      return;
    }
    const processSessionId = typeof req.body?.sessionId === "string" && req.body.sessionId.trim() ? req.body.sessionId.trim() : randomUUID();
    const processRun = processRunRegistry.start(requestId, processSessionId);
    req.once("aborted", () => processRunRegistry.cancel(requestId));
    res.once("close", () => {
      if (!res.writableEnded) processRunRegistry.cancel(requestId);
    });

    try {
      const {
        input,
        sessionId,
        sessionTitle,
        providerId,
        model,
        metadata
      } = req.body as {
        input?: unknown;
        sessionId?: unknown;
        sessionTitle?: unknown;
        providerId?: unknown;
        model?: unknown;
        metadata?: Record<string, unknown>;
      };

      if (typeof input !== "string" || input.trim().length === 0) {
        processRunRegistry.fail(requestId, "Input cannot be empty");
        res.status(400).json({
          error: "Field 'input' must be a non-empty string."
        });
        return;
      }

      const resolvedChannel = "http" as const;
      const configuredProfileId = (await runtimeManager.getSettings()).memory.localProfileId;
      const result = await processRuntimeInput(
        runtimeManager,
        sessionIndexStore,
        {
          input,
          sessionId: processSessionId,
          sessionTitle: typeof sessionTitle === "string" ? sessionTitle : undefined,
          userId: configuredProfileId,
          providerId: typeof providerId === "string" ? providerId : undefined,
          model: typeof model === "string" ? model : undefined,
          metadata,
          signal: processRun.controller.signal,
          onProgress: (event) => processRunRegistry.update(requestId, event),
          requestApproval: (operation) => processRunRegistry.requestApproval(requestId, operation)
        },
        resolvedChannel
      );

      res.status(200).json({
        ...result,
        requestId
      });
      if (result.result.error) processRunRegistry.fail(requestId, result.result.error);
      else processRunRegistry.complete(requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      processRunRegistry.fail(requestId, message);
      if (processRun.controller.signal.aborted && !res.headersSent) {
        res.status(499).json({ error: "Request cancelled", requestId });
        return;
      }
      next(error);
    }
  };

export const createProcessRunStatusController = () =>
  (req: Request, res: Response): void => {
    const run = processRunRegistry.get(String(req.params.requestId));
    if (!run) {
      res.status(404).json({ error: "Process run not found" });
      return;
    }
    res.status(200).json(run);
  };

export const createReviewProcessRunController = () =>
  (req: Request, res: Response): void => {
    const { sessionId, approvalId, approved } = req.body ?? {};
    if (typeof sessionId !== "string" || typeof approvalId !== "string" || typeof approved !== "boolean") {
      res.status(400).json({ error: "sessionId, approvalId and a boolean approved are required." });
      return;
    }
    const accepted = processRunRegistry.review(String(req.params.requestId), sessionId, approvalId, approved);
    res.status(accepted ? 200 : 409).json({ accepted });
  };

export const createCancelProcessRunController = () =>
  (req: Request, res: Response): void => {
    const requestId = String(req.params.requestId);
    const cancelled = processRunRegistry.cancel(requestId);
    res.status(cancelled ? 202 : 409).json({ requestId, cancelled });
  };

export { createReadWorkspaceFileController } from "./workspaceReview";

export const createRevealWorkspacePathController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const requestedPath = typeof req.body?.path === "string" ? req.body.path : "";
      if (!requestedPath) {
        res.status(400).json({ error: "Field 'path' is required." });
        return;
      }

      const targetPath = await resolveReviewPath(runtimeManager, requestedPath,
        typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined,
        typeof req.body?.runId === "string" ? req.body.runId : undefined);
      res.status(200).json(await revealWorkspacePath(targetPath));
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
        schedules,
        workflows,
        workflowRuns,
        projects
      ] = await Promise.all([
        runtimeManager.getSettings(),
        sessionIndexStore.list(),
        runtime.modelCatalog.listAll(),
        runtime.localModelManager.listLoadedModels(),
        runtime.localModelManager.listAllModels(),
        runtime.taskService.list(),
        runtime.scheduleService.list(),
        runtime.workflowStore.list(),
        runtime.workflowRunStore.listRuns(),
        runtime.projectStore?.list() ?? Promise.resolve([])
      ]);

      res.status(200).json({
        providers: runtime.providerDescriptors,
        tools: runtime.tools,
        plugins: runtime.plugins,
        pluginStatuses: [],
        appSettings,
        sessions,
        tasks,
        schedules,
        workflows,
        workflowRuns,
        projects,
        availableModels,
        loadedModels,
        allManagedModels,
        localModels: runtime.localModelService.snapshot(),
        systemMetrics: systemMetricsSnapshot(runtime.localModelService.gpuMetrics())
      });
    } catch (error) {
      next(error);
    }
  };

export const createSystemMetricsController =
  (runtimeManager?: RuntimeManager) =>
  async (_req: Request, res: Response): Promise<void> => {
    let gpus: SystemMetrics["gpus"];
    try { gpus = runtimeManager?.getRuntime().localModelService.gpuMetrics(); } catch { gpus = undefined; }
    res.status(200).json(systemMetricsSnapshot(gpus));
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
        reasoningEffort: isReasoningEffort(body.reasoningEffort) ? body.reasoningEffort : undefined,
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
	        defaultAccessMode: body.defaultAccessMode === "ask" ? "ask" : body.defaultAccessMode === "full" ? "full" : body.defaultAccessMode === "default" ? "default" : undefined,
	        codeAgents: Array.isArray(body.codeAgents)
          ? body.codeAgents
              .filter(isObject)
              .map((agent, index) => ({
                id: typeof agent.id === "string" ? agent.id : `agent-${index + 1}`,
                name: typeof agent.name === "string" ? agent.name : `Agent${index + 1}`,
                providerId:
                  typeof agent.providerId === "string" ? agent.providerId : runtime.config.llm.defaultProvider,
                model: typeof agent.model === "string" ? agent.model : undefined,
                accessMode: agent.accessMode === "ask" ? "ask" : agent.accessMode === "full" ? "full" : "default"
              }))
          : undefined,
        subagents: Array.isArray(body.subagents)
          ? body.subagents
              .filter(isObject)
              .map((agent, index) => ({
                id: typeof agent.id === "string" ? agent.id : `agent-${index + 1}`,
                name: typeof agent.name === "string" ? agent.name : `Agent${index + 1}`,
                providerId:
                  typeof agent.providerId === "string" ? agent.providerId : runtime.config.llm.defaultProvider,
                model: typeof agent.model === "string" ? agent.model : undefined,
                accessMode: agent.accessMode === "ask" ? "ask" : agent.accessMode === "full" ? "full" : "default"
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
                  typeof agent.providerId === "string" ? agent.providerId : runtime.config.llm.defaultProvider,
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
  (sessionIndexStore: SessionIndexStore, runtimeManager?: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const title = typeof req.body?.title === "string" ? req.body.title : undefined;
      if (req.body?.projectId !== undefined && req.body?.projectId !== null &&
        (typeof req.body.projectId !== "string" || !req.body.projectId.trim())) {
        throw new ProjectError(400, "Field 'projectId' must be a project identifier or null.");
      }
      const projectId = typeof req.body?.projectId === "string" ? req.body.projectId.trim() : undefined;
      if (projectId) {
        const project = await runtimeManager?.getRuntime().projectStore.get(projectId);
        if (!project) throw new ProjectError(404, "Project was not found.");
        if (project.archivedAt) throw new ProjectError(409, "Restore this project before creating a chat.");
      }
      const session = await sessionIndexStore.create(title, "http", projectId);
      const defaults = (await runtimeManager?.getSettings())?.ui;
      if (defaults && runtimeManager) await runtimeManager.getRuntime().sessionSettingsStore.update(session.id, {
        language: defaults.language, outputStyle: defaults.outputStyle, mode: defaults.mode
      });
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

/** On a server, a chat's device turns (RunService): refused while one runs, removed with the chat. */
export interface SessionDeletionHooks {
  forgetSession(sessionId: string): void;
  forgotSession(sessionId: string, deleted: boolean): void;
}

export const createDeleteSessionController =
  (runtimeManager: RuntimeManager, sessionIndexStore: SessionIndexStore, chatRuns?: SessionDeletionHooks) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const sessionId = String(req.params.sessionId);
    let forgetting = false, deleted = false;
    try {
      const runtime = runtimeManager.getRuntime();
      if (!await sessionIndexStore.get(sessionId)) {
        res.status(404).json({ error: "Session not found." });
        return;
      }
      if (chatRuns) {
        try { chatRuns.forgetSession(sessionId); forgetting = true; }
        catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "The chat is answering." }); return; }
      }

      await runtime.sessionSettingsStore.delete(sessionId);
      await runtime.memoryService.deleteSession(sessionId);
      // The index goes last: a failed step above can be retried.
      if (!await sessionIndexStore.delete(sessionId)) {
        res.status(404).json({ error: "Session not found." });
        return;
      }
      deleted = true;

      res.status(200).json({ ok: true, sessionId });
    } catch (error) {
      next(error);
    } finally {
      if (forgetting) chatRuns!.forgotSession(sessionId, deleted);
    }
  };

export const createGetSessionMessagesController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { messages } = await loadSessionMessages(runtimeManager, String(req.params.sessionId));
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
        plugins: runtime.plugins,
        // A provider can become configured as part of this save. Return its
        // current catalog immediately instead of making the UI wait for a
        // full dashboard reload before it can offer the provider's models.
        availableModels: Object.keys(patch).every(key => key === "ui") ? undefined : await runtime.modelCatalog.listAll()
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
          model: typeof req.body?.model === "string" ? req.body.model : providerSettings.model,
          prompt: "Reply exactly with: ok"
        },
        providerId
      );

      const failed = response.error || !response.text.trim() ||
        response.text.startsWith(`Mock response from ${providerId}`);

      if (failed) {
        res.status(200).json({
          ok: false,
          providerId,
          model: response.model,
          message: response.error || "Provider returned no usable final answer."
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

