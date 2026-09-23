import { NextFunction, Request, Response } from "express";
import { RuntimeManager } from "../app/RuntimeManager";
import { ProjectError } from "../projects/types";
import { projectDirectory } from "../projects/ProjectStore";
import { revealWorkspacePath } from "./workspaceReview";

export const createListProjectsController = (manager: RuntimeManager) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try { res.json(await manager.getRuntime().projectStore.list()); }
    catch (error) { next(error); }
  };

export const createCreateProjectController = (manager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { name, rootPath, color } = req.body ?? {};
      if (typeof name !== "string" || typeof rootPath !== "string") throw new ProjectError(400, "Project name and rootPath are required.");
      res.status(201).json(await manager.getRuntime().projectStore.create({ name, rootPath, color }));
    } catch (error) { next(error); }
  };

export const createUpdateProjectController = (manager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { name, rootPath, archived, color } = req.body ?? {};
      if ((name !== undefined && typeof name !== "string") || (rootPath !== undefined && typeof rootPath !== "string") ||
        (archived !== undefined && typeof archived !== "boolean")) throw new ProjectError(400, "Invalid project update.");
      const project = await manager.getRuntime().projectStore.update(String(req.params.projectId), { name, rootPath, archived, color });
      if (!project) throw new ProjectError(404, "Project was not found.");
      res.json(project);
    } catch (error) { next(error); }
  };

export const createRevealProjectController = (manager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const project = await manager.getRuntime().projectStore.get(String(req.params.projectId));
      if (!project) throw new ProjectError(404, "Project was not found.");
      if (await projectDirectory(project.rootPath) !== project.rootPath) throw new ProjectError(409, "Project folder has moved.");
      res.json(await revealWorkspacePath(project.rootPath));
    } catch (error) { next(error); }
  };
