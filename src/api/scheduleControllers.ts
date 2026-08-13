import { NextFunction, Request, Response } from "express";
import { RuntimeManager } from "../app/RuntimeManager";
import { DEFAULT_TASK_WORKFLOW_ID } from "../workflows/defaultWorkflows";
import { ScheduleService, ScheduleValidationError } from "../schedules/ScheduleService";
import { TaskPriority } from "../tasks/types";
import { ScheduleFrequency, ScheduleWeekday } from "../schedules/types";

const taskPriorities = new Set<TaskPriority>(["low", "normal", "high"]);

export const createListSchedulesController =
  (runtimeManager: RuntimeManager) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await runtimeManager.getRuntime().scheduleService.list());
    } catch (error) {
      next(error);
    }
  };

export const createCreateScheduleController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const title = readString(req.body?.title);
    const description = readString(req.body?.description) ?? "";
    const time = readString(req.body?.time);
    const timezone = readString(req.body?.timezone);

    if (
      !title ||
      !time ||
      !timezone ||
      (req.body?.frequency !== undefined && typeof req.body.frequency !== "string") ||
      (req.body?.weekday !== undefined && typeof req.body.weekday !== "number")
    ) {
      res.status(400).json({ error: "Fields 'title', 'time', and 'timezone' must be non-empty strings." });
      return;
    }

    try {
      const workflowId = readString(req.body?.workflowId) || DEFAULT_TASK_WORKFLOW_ID;
      const schedule = await runtimeManager.getRuntime().scheduleService.create({
        title,
        description,
        workflowId,
        priority: normalizePriority(req.body?.priority),
        frequency: typeof req.body?.frequency === "string"
          ? req.body.frequency as ScheduleFrequency
          : undefined,
        weekday: typeof req.body?.weekday === "number"
          ? req.body.weekday as ScheduleWeekday
          : undefined,
        time,
        timezone,
        enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined,
        sessionId: readString(req.body?.sessionId),
        metadata: isRecord(req.body?.metadata) ? req.body.metadata : undefined
      });
      res.status(201).json(schedule);
    } catch (error) {
      handleScheduleError(error, next, res);
    }
  };

export const createUpdateScheduleController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = isRecord(req.body) ? req.body : {};

    if (
      (body.title !== undefined && typeof body.title !== "string") ||
      (body.description !== undefined && typeof body.description !== "string") ||
      (body.workflowId !== undefined && typeof body.workflowId !== "string") ||
      (body.frequency !== undefined && typeof body.frequency !== "string") ||
      (body.weekday !== undefined && typeof body.weekday !== "number") ||
      (body.time !== undefined && typeof body.time !== "string") ||
      (body.timezone !== undefined && typeof body.timezone !== "string") ||
      (body.sessionId !== undefined && typeof body.sessionId !== "string") ||
      (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
      (body.metadata !== undefined && !isRecord(body.metadata))
    ) {
      res.status(400).json({ error: "Schedule fields have invalid types." });
      return;
    }

    try {
      const schedule = await runtimeManager.getRuntime().scheduleService.update(
        readParam(req.params.scheduleId),
        {
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.workflowId === "string" ? { workflowId: body.workflowId } : {}),
          ...(body.priority !== undefined ? { priority: normalizePriority(body.priority) } : {}),
          ...(typeof body.frequency === "string" ? { frequency: body.frequency as ScheduleFrequency } : {}),
          ...(typeof body.weekday === "number" ? { weekday: body.weekday as ScheduleWeekday } : {}),
          ...(typeof body.time === "string" ? { time: body.time } : {}),
          ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
          ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(isRecord(body.metadata) ? { metadata: body.metadata } : {})
        }
      );

      if (!schedule) {
        res.status(404).json({ error: "Schedule was not found." });
        return;
      }

      res.status(200).json(schedule);
    } catch (error) {
      handleScheduleError(error, next, res);
    }
  };

export const createDeleteScheduleController =
  (runtimeManager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const deleted = await runtimeManager.getRuntime().scheduleService.delete(readParam(req.params.scheduleId));

      if (!deleted) {
        res.status(404).json({ error: "Schedule was not found." });
        return;
      }

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  };

const normalizePriority = (value: unknown): TaskPriority =>
  typeof value === "string" && taskPriorities.has(value as TaskPriority)
    ? value as TaskPriority
    : "normal";

const readString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] ?? "" : value ?? "";

const handleScheduleError = (error: unknown, next: NextFunction, res: Response): void => {
  if (error instanceof ScheduleValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }

  next(error);
};
