import { NextFunction, Request, Response } from "express";
import { RuntimeManager } from "../app/RuntimeManager";
import { WorkflowDefinition } from "../workflows/types";
import { WorkflowEvent } from "../workflows/WorkflowEventStore";

export const createStartWorkflowRunController = (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const validation = runtime.workflowStore.validate(req.body?.workflow);
      if (!validation.ok) { res.status(400).json({ error: validation.errors.join("; ") }); return; }
      const run = await runtime.workflowRunner.startStandalone(req.body.workflow, req.body.options ?? req.body.workflow.runDefaults);
      runtime.workflowRunner.runInBackground(run.id);
      res.status(201).json(run);
    } catch (error) { next(error); }
  };

export const createWorkflowEventsController = (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let unsubscribe: (() => void) | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const cleanup = () => { unsubscribe?.(); if (heartbeat) clearInterval(heartbeat); };
    try {
      const rawCursor = req.get("Last-Event-ID") ?? req.query.after ?? "0";
      if (typeof rawCursor !== "string" || !/^\d+$/.test(rawCursor) || !Number.isSafeInteger(Number(rawCursor))) {
        res.status(400).json({ error: "Event cursor must be a non-negative integer." }); return;
      }
      let cursor = Number(rawCursor);
      const runId = readParam(req.params.runId);
      const runtime = runtimeManager.getRuntime();
      if (!await runtime.workflowRunStore.getRun(runId)) { res.status(404).json({ error: "Workflow run was not found." }); return; }
      const pending: WorkflowEvent[] = [];
      let ready = false;
      const write = (name: string, data: unknown, sequence?: number) => {
        if (res.destroyed || res.writableEnded) return;
        if (res.writableLength > 512 * 1024) { cleanup(); res.end(); return; }
        res.write(`${sequence === undefined ? "" : `id: ${sequence}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const live = (event: WorkflowEvent) => {
        if (!ready) { pending.push(event); return; }
        if (event.sequence <= cursor) return;
        write("update", event, event.sequence); cursor = event.sequence;
      };
      unsubscribe = runtime.workflowRunStore.events.subscribe(runId, live);
      res.on("close", cleanup);
      // Subscribe first, then replay under the journal lock; queued live events are deduplicated.
      let history = await runtime.workflowRunStore.events.list(runId, cursor);
      if (cursor > history.lastSequence) { cursor = 0; history = await runtime.workflowRunStore.events.list(runId); }
      const detail = await runtime.taskService.getRunDetail(runId);
      if (res.destroyed) { cleanup(); return; }
      res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      write("history", { ...history, detail }, history.lastSequence);
      cursor = history.lastSequence; ready = true;
      for (const event of pending) live(event);
      pending.length = 0;
      if (res.destroyed || res.writableEnded) { cleanup(); return; }
      heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(": keepalive\n\n"); }, 15000);
      heartbeat.unref();
    } catch (error) { cleanup(); if (res.headersSent) res.end(); else next(error); }
  };

export const createListWorkflowsController =
  (runtimeManager: RuntimeManager) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      res.status(200).json(await runtime.workflowStore.list());
    } catch (error) {
      next(error);
    }
  };

export const createGetWorkflowController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const version = req.query.version ? Number(req.query.version) : undefined;
      const runtime = runtimeManager.getRuntime();
      const workflow = await runtime.workflowStore.get(readParam(req.params.workflowId), version);

      if (!workflow) {
        res.status(404).json({ error: "Workflow was not found." });
        return;
      }

      res.status(200).json(workflow);
    } catch (error) {
      next(error);
    }
  };

export const createCreateWorkflowController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const validation = runtime.workflowStore.validate(req.body);
      if (!validation.ok) {
        res.status(400).json({ error: validation.errors.join("; "), errors: validation.errors });
        return;
      }
      const workflow = await runtime.workflowStore.create(req.body as WorkflowDefinition);
      res.status(201).json(workflow);
    } catch (error) {
      next(error);
    }
  };

export const createUpdateWorkflowController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const validation = runtime.workflowStore.validate(req.body);
      if (!validation.ok) {
        res.status(400).json({ error: validation.errors.join("; "), errors: validation.errors });
        return;
      }
      const workflow = await runtime.workflowStore.update(
        readParam(req.params.workflowId),
        req.body as WorkflowDefinition
      );
      res.status(200).json(workflow);
    } catch (error) {
      next(error);
    }
  };

export const createValidateWorkflowController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      res.status(200).json(runtime.workflowStore.validate(req.body));
    } catch (error) { next(error); }
  };

export const createListWorkflowRunsController =
  (runtimeManager: RuntimeManager) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      res.status(200).json(await runtime.workflowRunStore.listRuns());
    } catch (error) {
      next(error);
    }
  };

export const createGetWorkflowRunController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const detail = await runtime.taskService.getRunDetail(readParam(req.params.runId));

      if (!detail) {
        res.status(404).json({ error: "Workflow run was not found." });
        return;
      }

      res.status(200).json(detail);
    } catch (error) {
      next(error);
    }
  };

export const createStepWorkflowRunController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      res.status(200).json(await runtime.workflowRunner.runNextStep(readParam(req.params.runId)));
    } catch (error) {
      next(error);
    }
  };

export const createCancelWorkflowRunController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      res.status(200).json(await runtime.workflowRunner.cancel(readParam(req.params.runId)));
    } catch (error) {
      next(error);
    }
  };

export const createReviewWorkflowRunController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (typeof req.body?.approved !== "boolean") {
      res.status(400).json({ error: "Field approved must be a boolean." });
      return;
    }
    try {
      res.status(200).json(await runtimeManager.getRuntime().workflowRunner.review(
        readParam(req.params.runId), req.body.approved,
        typeof req.body.comment === "string" ? req.body.comment : "", req.body.background === true,
        {
          approvalId: typeof req.body.approvalId === "string" ? req.body.approvalId : undefined,
          waitingNodeRunId: typeof req.body.waitingNodeRunId === "string" ? req.body.waitingNodeRunId : undefined
        }
      ));
    } catch (error) { next(error); }
  };

export const createResumeWorkflowRunController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await runtimeManager.getRuntime().workflowRunner.resume(
        readParam(req.params.runId), req.body?.background === true
      ));
    } catch (error) { next(error); }
  };

const readParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] ?? "" : value ?? "";
