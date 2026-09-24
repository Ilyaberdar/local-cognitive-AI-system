import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { createOpenWorkspaceEditorController } from "./workspaceReview";
import { revealWorkspacePath } from "./workspaceReview";
import { RuntimeManager } from "../app/RuntimeManager";
import { SessionIndexStore } from "../session/SessionIndexStore";
import { createLocalModelRouter } from "./localModelControllers";
import { createAttachmentRouter } from "./attachmentControllers";
import { createCreateProjectController, createListProjectsController, createRevealProjectController, createUpdateProjectController } from "./projectControllers";
import {
  createCreateSessionController,
  createCancelProcessRunController,
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
  createProcessRunStatusController,
  createReviewProcessRunController,
  createReadWorkspaceFileController,
  createRevealWorkspacePathController,
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
  createGetTaskWorkspaceController,
  createListTasksController,
  createQueueTaskController,
  createRunNextTaskController,
  createRunTaskController,
  createUpdateTaskController
} from "./taskControllers";
import {
  createCreateScheduleController,
  createDeleteScheduleController,
  createListSchedulesController,
  createUpdateScheduleController
} from "./scheduleControllers";
import {
  createCancelWorkflowRunController,
  createStartWorkflowRunController,
  createCreateWorkflowController,
  createGetWorkflowController,
  createGetWorkflowRunController,
  createWorkflowEventsController,
  createListWorkflowRunsController,
  createListWorkflowsController,
  createStepWorkflowRunController,
  createReviewWorkflowRunController,
  createResumeWorkflowRunController,
  createUpdateWorkflowController,
  createValidateWorkflowController
} from "./workflowControllers";

export const createApiRouter = (
  runtimeManager: RuntimeManager,
  sessionIndexStore: SessionIndexStore
): Router => {
  const router = Router();
  router.use(createAttachmentRouter());

  router.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  router.get("/app/info", async (_req, res, next) => {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8"));
      res.json({ name: metadata.build?.productName || metadata.name, version: metadata.version,
        platform: "Browser", license: metadata.license || "Not declared in application metadata" });
    } catch (error) { next(error); }
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
  router.use(createLocalModelRouter(() => runtimeManager.getRuntime().localModelService));

  router.get("/sessions", createListSessionsController(sessionIndexStore));
  router.get("/projects", createListProjectsController(runtimeManager));
  router.post("/projects", createCreateProjectController(runtimeManager));
  router.patch("/projects/:projectId", createUpdateProjectController(runtimeManager));
  router.post("/projects/:projectId/reveal", createRevealProjectController(runtimeManager));
  router.post("/sessions", createCreateSessionController(sessionIndexStore, runtimeManager));
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
  router.get("/tasks/:taskId/workspace", createGetTaskWorkspaceController(runtimeManager));
  router.post("/tasks/:taskId/workspace/reveal", async(req,res,next)=>{
    try { const workspace=await runtimeManager.getRuntime().taskService.getWorkspace(String(req.params.taskId));
      await runtimeManager.getRuntime().workspaceResolver.validate(workspace);res.json(await revealWorkspacePath(workspace.rootPath));
    }catch(error){next(error);}
  });
  router.patch("/tasks/:taskId", createUpdateTaskController(runtimeManager));
  router.delete("/tasks/:taskId", createDeleteTaskController(runtimeManager));
  router.post("/tasks/:taskId/queue", createQueueTaskController(runtimeManager));
  router.post("/tasks/:taskId/run", createRunTaskController(runtimeManager));

  router.get("/schedules", createListSchedulesController(runtimeManager));
  router.post("/schedules", createCreateScheduleController(runtimeManager));
  router.patch("/schedules/:scheduleId", createUpdateScheduleController(runtimeManager));
  router.delete("/schedules/:scheduleId", createDeleteScheduleController(runtimeManager));

  router.get("/workflows", createListWorkflowsController(runtimeManager));
  router.post("/workflows", createCreateWorkflowController(runtimeManager));
  router.get("/workflows/:workflowId", createGetWorkflowController(runtimeManager));
  router.put("/workflows/:workflowId", createUpdateWorkflowController(runtimeManager));
  router.post("/workflows/:workflowId/validate", createValidateWorkflowController(runtimeManager));
  router.get("/workflow-runs", createListWorkflowRunsController(runtimeManager));
  router.post("/workflow-runs", createStartWorkflowRunController(runtimeManager));
  router.get("/workflow-runs/:runId", createGetWorkflowRunController(runtimeManager));
  router.get("/workflow-runs/:runId/events", createWorkflowEventsController(runtimeManager));
  router.post("/workflow-runs/:runId/step", createStepWorkflowRunController(runtimeManager));
  router.post("/workflow-runs/:runId/review", createReviewWorkflowRunController(runtimeManager));
  router.post("/workflow-runs/:runId/cancel", createCancelWorkflowRunController(runtimeManager));
  router.post("/workflow-runs/:runId/resume", createResumeWorkflowRunController(runtimeManager));
  router.get("/workflow-runs/:runId/agent-runs/:agentRunId",async(req,res,next)=>{
    try{
      const runtime=runtimeManager.getRuntime();
      const detail=await runtime.taskService.getRunDetail(String(req.params.runId));
      const agentRunId=String(req.params.agentRunId);
      const ids=detail?.nodeRuns.map(node=>node.agentRunId).filter((id):id is string=>typeof id==="string")??[];
      if(!ids.some(id=>agentRunId===id||agentRunId.startsWith(`${id}:agent:`))){res.status(404).json({error:"Agent run was not found in this workflow."});return;}
      const exact=await runtime.agentLoopRunner.store.get(agentRunId);
      if(!exact && ids.includes(agentRunId)) {
        const budget=await runtime.agentLoopRunner.store.getBudget(agentRunId);
        const participants=await Promise.all((budget?.memberIds??[])
          .filter(id=>id.startsWith(`${agentRunId}:agent:`)).map(id=>runtime.agentLoopRunner.store.get(id)));
        const agents=participants.filter((agent):agent is NonNullable<typeof agent>=>Boolean(agent));
        if(agents.length){
          res.json({id:agentRunId,agents,turns:agents.flatMap(agent=>agent.turns.map(turn=>({
            ...turn,content:`[${agent.id.slice(agentRunId.length+7)}] ${turn.content}`
          })))});
          return;
        }
      }
      const run=exact??await runtime.agentLoopRunner.store.get(`${agentRunId}:agent:main`);
      if(!run){res.status(404).json({error:"No agent steps have been recorded yet."});return;}
      res.json(run);
    }catch(error){next(error);}
  });

  router.post("/chat", createProcessController(runtimeManager, sessionIndexStore));
  router.post("/process", createProcessController(runtimeManager, sessionIndexStore));
  router.post("/process-runs/:requestId/review", createReviewProcessRunController());
  router.get("/process-runs/:requestId", createProcessRunStatusController());
  router.post("/process-runs/:requestId/cancel", createCancelProcessRunController());
  router.post("/workspace/editor", createOpenWorkspaceEditorController(runtimeManager));
  router.get("/workspace/file", createReadWorkspaceFileController(runtimeManager));
  router.post("/workspace/reveal", createRevealWorkspacePathController(runtimeManager));

  return router;
};
