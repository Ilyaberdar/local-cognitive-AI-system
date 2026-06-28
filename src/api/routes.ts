import { Router } from "express";
import { RuntimeManager } from "../app/RuntimeManager";
import { SessionIndexStore } from "../session/SessionIndexStore";
import {
  createCreateSessionController,
  createDeleteSessionController,
  createDashboardBootstrapController,
  createGetAllManagedModelsController,
  createGetAllLocalModelsController,
  createGetAppSettingsController,
  createGetLoadedLocalModelsController,
  createGetLoadedModelsController,
  createGetSessionMessagesController,
  createGetSessionSettingsController,
  createListSessionsController,
  createLoadLocalModelController,
  createLoadModelController,
  createMetadataController,
  createModelsController,
  createPluginStatusController,
  createPluginTestController,
  createProcessController,
  createProviderTestController,
  createRenameSessionController,
  createRuntimeReloadController,
  createSystemMetricsController,
  createUnloadLocalModelController,
  createUnloadModelController,
  createUpdateAppSettingsController,
  createUpdateSessionSettingsController
} from "./controller";
import {
  createCreateTaskController,
  createDeleteTaskController,
  createGetTaskController,
  createListTasksController,
  createQueueTaskController,
  createRunNextTaskController,
  createRunTaskController,
  createUpdateTaskController
} from "./taskControllers";
import {
  createCancelWorkflowRunController,
  createCreateWorkflowController,
  createGetWorkflowController,
  createGetWorkflowRunController,
  createListWorkflowRunsController,
  createListWorkflowsController,
  createStepWorkflowRunController,
  createUpdateWorkflowController,
  createValidateWorkflowController
} from "./workflowControllers";

export const createApiRouter = (
  runtimeManager: RuntimeManager,
  sessionIndexStore: SessionIndexStore
): Router => {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  router.get("/meta", createMetadataController(runtimeManager));
  router.get("/dashboard/bootstrap", createDashboardBootstrapController(runtimeManager, sessionIndexStore));
  router.get("/system/metrics", createSystemMetricsController());
  router.get("/models", createModelsController(runtimeManager));
  router.get("/lmstudio/models/loaded", createGetLoadedModelsController(runtimeManager));
  router.get("/lmstudio/models/all", createGetAllManagedModelsController(runtimeManager));
  router.post("/lmstudio/models/load", createLoadModelController(runtimeManager));
  router.post("/lmstudio/models/unload", createUnloadModelController(runtimeManager));
  router.get("/local/models/loaded", createGetLoadedLocalModelsController(runtimeManager));
  router.get("/local/models/all", createGetAllLocalModelsController(runtimeManager));
  router.post("/local/models/load", createLoadLocalModelController(runtimeManager));
  router.post("/local/models/unload", createUnloadLocalModelController(runtimeManager));

  router.get("/sessions", createListSessionsController(sessionIndexStore));
  router.post("/sessions", createCreateSessionController(sessionIndexStore));
  router.patch("/sessions/:sessionId", createRenameSessionController(sessionIndexStore));
  router.delete("/sessions/:sessionId", createDeleteSessionController(runtimeManager, sessionIndexStore));
  router.get("/sessions/:sessionId/messages", createGetSessionMessagesController(runtimeManager));
  router.get("/sessions/:sessionId/settings", createGetSessionSettingsController(runtimeManager));
  router.put("/sessions/:sessionId/settings", createUpdateSessionSettingsController(runtimeManager));

  router.get("/app/settings", createGetAppSettingsController(runtimeManager));
  router.put("/app/settings", createUpdateAppSettingsController(runtimeManager));
  router.post("/providers/:providerId/test", createProviderTestController(runtimeManager));
  router.get("/plugins/status", createPluginStatusController(runtimeManager));
  router.post("/plugins/:pluginName/test", createPluginTestController(runtimeManager));
  router.post("/runtime/reload", createRuntimeReloadController(runtimeManager));

  router.get("/tasks", createListTasksController(runtimeManager));
  router.post("/tasks", createCreateTaskController(runtimeManager));
  router.post("/tasks/run-next", createRunNextTaskController(runtimeManager));
  router.get("/tasks/:taskId", createGetTaskController(runtimeManager));
  router.patch("/tasks/:taskId", createUpdateTaskController(runtimeManager));
  router.delete("/tasks/:taskId", createDeleteTaskController(runtimeManager));
  router.post("/tasks/:taskId/queue", createQueueTaskController(runtimeManager));
  router.post("/tasks/:taskId/run", createRunTaskController(runtimeManager));

  router.get("/workflows", createListWorkflowsController(runtimeManager));
  router.post("/workflows", createCreateWorkflowController(runtimeManager));
  router.get("/workflows/:workflowId", createGetWorkflowController(runtimeManager));
  router.put("/workflows/:workflowId", createUpdateWorkflowController(runtimeManager));
  router.post("/workflows/:workflowId/validate", createValidateWorkflowController(runtimeManager));
  router.get("/workflow-runs", createListWorkflowRunsController(runtimeManager));
  router.get("/workflow-runs/:runId", createGetWorkflowRunController(runtimeManager));
  router.post("/workflow-runs/:runId/step", createStepWorkflowRunController(runtimeManager));
  router.post("/workflow-runs/:runId/cancel", createCancelWorkflowRunController(runtimeManager));

  router.post("/chat", createProcessController(runtimeManager, sessionIndexStore));
  router.post("/process", createProcessController(runtimeManager, sessionIndexStore));

  return router;
};
