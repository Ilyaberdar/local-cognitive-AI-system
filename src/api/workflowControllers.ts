import { NextFunction, Request, Response } from "express";
import { RuntimeManager } from "../app/RuntimeManager";
import { WorkflowDefinition } from "../workflows/types";

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
  async (req: Request, res: Response): Promise<void> => {
    const runtime = runtimeManager.getRuntime();
    res.status(200).json(runtime.workflowStore.validate(req.body as WorkflowDefinition));
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

const readParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] ?? "" : value ?? "";
