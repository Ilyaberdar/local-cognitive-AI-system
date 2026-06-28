import { NextFunction, Request, Response } from "express";
import { RuntimeManager } from "../app/RuntimeManager";
import { DEFAULT_TASK_WORKFLOW_ID } from "../workflows/defaultWorkflows";
import { TaskPriority, TaskStatus } from "../tasks/types";

const taskPriorities = new Set<TaskPriority>(["low", "normal", "high"]);
const taskStatuses = new Set<TaskStatus>([
  "todo",
  "in_progress",
  "backlog",
  "queued",
  "running",
  "waiting",
  "blocked",
  "done",
  "failed",
  "cancelled"
]);

export const createListTasksController =
  (runtimeManager: RuntimeManager) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      res.status(200).json(await runtime.taskService.list());
    } catch (error) {
      next(error);
    }
  };

export const createCreateTaskController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
      const workflowId =
        typeof req.body?.workflowId === "string" && req.body.workflowId.trim()
          ? req.body.workflowId.trim()
          : DEFAULT_TASK_WORKFLOW_ID;
      const priority = normalizePriority(req.body?.priority);

      if (!title) {
        res.status(400).json({ error: "Field 'title' must be a non-empty string." });
        return;
      }

      const runtime = runtimeManager.getRuntime();
      const task = await runtime.taskService.create({
        title,
        description,
        workflowId,
        priority,
        sessionId: typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined,
        scheduledFor: typeof req.body?.scheduledFor === "string" ? req.body.scheduledFor : undefined,
        metadata: isRecord(req.body?.metadata) ? req.body.metadata : undefined
      });

      res.status(201).json(task);
    } catch (error) {
      next(error);
    }
  };

export const createGetTaskController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const task = await runtime.taskService.get(readParam(req.params.taskId));

      if (!task) {
        res.status(404).json({ error: "Task was not found." });
        return;
      }

      res.status(200).json(task);
    } catch (error) {
      next(error);
    }
  };

export const createUpdateTaskController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patch: Record<string, unknown> = {};

      if (typeof req.body?.title === "string") {
        patch.title = req.body.title.trim();
      }

      if (typeof req.body?.description === "string") {
        patch.description = req.body.description.trim();
      }

      if (typeof req.body?.workflowId === "string" && req.body.workflowId.trim()) {
        patch.workflowId = req.body.workflowId.trim();
      }

      if (req.body?.priority !== undefined) {
        patch.priority = normalizePriority(req.body.priority);
      }

      if (typeof req.body?.status === "string" && taskStatuses.has(req.body.status as TaskStatus)) {
        patch.status = req.body.status;
      }

      const runtime = runtimeManager.getRuntime();
      const task = await runtime.taskService.update(readParam(req.params.taskId), patch);

      if (!task) {
        res.status(404).json({ error: "Task was not found." });
        return;
      }

      res.status(200).json(task);
    } catch (error) {
      next(error);
    }
  };

export const createDeleteTaskController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const deleted = await runtime.taskService.delete(readParam(req.params.taskId));

      if (!deleted) {
        res.status(404).json({ error: "Task was not found." });
        return;
      }

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  };

export const createQueueTaskController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const task = await runtime.taskService.queue(readParam(req.params.taskId));

      if (!task) {
        res.status(404).json({ error: "Task was not found." });
        return;
      }

      res.status(200).json(task);
    } catch (error) {
      next(error);
    }
  };

export const createRunTaskController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const result = await runtime.taskService.runTask(readParam(req.params.taskId));
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };

export const createRunNextTaskController =
  (runtimeManager: RuntimeManager) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const runtime = runtimeManager.getRuntime();
      const result = await runtime.taskService.runNextQueued();

      if (!result) {
        res.status(200).json({ task: null, runId: null });
        return;
      }

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };

const normalizePriority = (value: unknown): TaskPriority =>
  typeof value === "string" && taskPriorities.has(value as TaskPriority)
    ? value as TaskPriority
    : "normal";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] ?? "" : value ?? "";
