import fs from "fs/promises";
import path from "path";
import { AppConfig } from "../config/config";
import { ProjectStore } from "../projects/ProjectStore";
import { ProjectError } from "../projects/types";
import { SessionIndexStore } from "../session/SessionIndexStore";
import { ManagedWorkspaceStore } from "./ManagedWorkspaceStore";
import { WorkspaceSnapshot } from "./types";

export class WorkspaceResolver {
  readonly managedWorkspaces: ManagedWorkspaceStore;
  constructor(
    config: Pick<AppConfig, "appDataDir">,
    private readonly projectStore: ProjectStore,
    private readonly sessionIndexStore: SessionIndexStore
  ) { this.managedWorkspaces = new ManagedWorkspaceStore(config.appDataDir); }

  async forSession(sessionId: string, options: { allowArchived?: boolean } = {}): Promise<WorkspaceSnapshot | undefined> {
    const session = await this.sessionIndexStore.get(sessionId);
    return session?.projectId ? this.forProject(session.projectId, options.allowArchived) : undefined;
  }

  async forTask(task: { id: string; projectId?: string }): Promise<WorkspaceSnapshot> {
    if (task.projectId) return { ...await this.forProject(task.projectId), taskId: task.id };
    const { rootPath } = await this.managedWorkspaces.ensure(task.id);
    return { version: 1, kind: "task", rootPath, outputDir: rootPath, allowedDirectories: [rootPath],
      taskId: task.id, memoryScope: `task:${task.id}` };
  }

  async validate(snapshot: WorkspaceSnapshot): Promise<void> {
    if (snapshot.version !== 1 || !path.isAbsolute(snapshot.rootPath)) throw new ProjectError(409, "Invalid workspace snapshot.");
    const actual = await fs.realpath(snapshot.rootPath).catch(() => undefined);
    if (!actual || actual !== snapshot.rootPath || !(await fs.stat(actual)).isDirectory()) {
      throw new ProjectError(409, "The saved workspace is missing or has moved. Restore the original folder before continuing.");
    }
  }

  private async forProject(projectId: string, allowArchived = false): Promise<WorkspaceSnapshot> {
    const project = await this.projectStore.get(projectId);
    if (!project) throw new ProjectError(404, "Project was not found.");
    if (project.archivedAt && !allowArchived) throw new ProjectError(409, "Restore this project before starting new work.");
    const snapshot: WorkspaceSnapshot = { version: 1, kind: "project", projectId: project.id, projectName: project.name,
      rootPath: project.rootPath, outputDir: project.rootPath, allowedDirectories: [project.rootPath], memoryScope: `project:${project.id}` };
    await this.validate(snapshot);
    return snapshot;
  }
}
