import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { isMissingFile, withFileLock, writeJsonAtomically } from "../utils/fileStore";
import { CreateProjectInput, Project, ProjectColor, PROJECT_COLORS, ProjectError, UpdateProjectInput } from "./types";

interface ProjectRecord { version: 1; projects: Project[]; }

export class ProjectStore {
  private readonly filePath: string;
  constructor(appDataDir: string) { this.filePath = path.join(appDataDir, "projects.json"); }

  list(): Promise<Project[]> {
    return withFileLock(this.filePath, async () => [...(await this.read()).projects]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  get(id: string): Promise<Project | null> {
    return withFileLock(this.filePath, async () => (await this.read()).projects.find(project => project.id === id) ?? null);
  }

  create(input: CreateProjectInput): Promise<Project> {
    return withFileLock(this.filePath, async () => {
      const name = projectName(input.name);
      const color = projectColor(input.color);
      const rootPath = await projectDirectory(input.rootPath);
      const record = await this.read();
      if (record.projects.some(project => project.rootPath === rootPath)) {
        throw new ProjectError(409, "This folder already belongs to a project. Restore the existing project if it is archived.");
      }
      const now = new Date().toISOString();
      const project: Project = { id: randomUUID(), name, rootPath, ...(color ? { color } : {}), createdAt: now, updatedAt: now };
      record.projects.push(project);
      await writeJsonAtomically(this.filePath, record);
      return project;
    });
  }

  update(id: string, patch: UpdateProjectInput): Promise<Project | null> {
    return withFileLock(this.filePath, async () => {
      const record = await this.read();
      const project = record.projects.find(item => item.id === id);
      if (!project) return null;
      const color = projectColor(patch.color);
      if (patch.rootPath !== undefined && await projectDirectory(patch.rootPath) !== project.rootPath) {
        throw new ProjectError(409, "A project's folder cannot be changed. Create a new project for the new folder.");
      }
      if (patch.name !== undefined) project.name = projectName(patch.name);
      if (patch.archived !== undefined && typeof patch.archived !== "boolean") {
        throw new ProjectError(400, "Field 'archived' must be a boolean.");
      }
      if (patch.archived === true) project.archivedAt ??= new Date().toISOString();
      if (patch.archived === false) delete project.archivedAt;
      if (patch.color !== undefined) {
        if (color) project.color = color;
        else delete project.color;
      }
      project.updatedAt = new Date().toISOString();
      await writeJsonAtomically(this.filePath, record);
      return project;
    });
  }

  private async read(): Promise<ProjectRecord> {
    try {
      const record: unknown = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (!record || typeof record !== "object" || !Array.isArray((record as ProjectRecord).projects)) {
        throw new Error("Invalid project store: expected a projects array.");
      }
      const projects = (record as ProjectRecord).projects;
      if (projects.some(item => !item || typeof item.id !== "string" || typeof item.name !== "string" ||
        typeof item.rootPath !== "string" || !path.isAbsolute(item.rootPath) || typeof item.createdAt !== "string" ||
        typeof item.updatedAt !== "string")) throw new Error("Invalid project store: project data is incomplete.");
      return { version: 1, projects };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return { version: 1, projects: [] };
    }
  }
}

function projectColor(value: unknown): ProjectColor | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !PROJECT_COLORS.includes(value as ProjectColor)) {
    throw new ProjectError(400, `Project color must be one of: ${PROJECT_COLORS.join(", ")}, or null for the default.`);
  }
  return value as ProjectColor;
}

function projectName(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
    throw new ProjectError(400, "Project name must contain 1 to 120 characters.");
  }
  return value.trim();
}

export async function projectDirectory(value: string): Promise<string> {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value.trim())) {
    throw new ProjectError(400, "Project folder must be an existing absolute directory path.");
  }
  try {
    const rootPath = await fs.realpath(value.trim());
    if (!(await fs.stat(rootPath)).isDirectory()) throw new ProjectError(400, "Project path must be a directory.");
    return rootPath;
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    if (isMissingFile(error)) throw new ProjectError(400, "Project folder does not exist.");
    if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new ProjectError(400, "Project folder is not accessible.");
    }
    throw error;
  }
}
