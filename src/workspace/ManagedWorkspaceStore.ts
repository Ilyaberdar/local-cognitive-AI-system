import fs from "fs/promises";
import path from "path";
import { isMissingFile, withFileLock, writeJsonAtomically } from "../utils/fileStore";
import { ProjectError } from "../projects/types";
import { canonicalPath } from "../tools/AccessPolicy";

export interface ManagedWorkspace { taskId: string; rootPath: string; createdAt: string; }

// Kept independently from task cards: deleting a task never deletes its output.
export class ManagedWorkspaceStore {
  private readonly filePath: string;
  constructor(private readonly appDataDir: string) { this.filePath = path.join(appDataDir, "workspaces", "managed.json"); }

  plannedPath(taskId: string): string {
    if (!/^[a-z0-9_-]{1,160}$/i.test(taskId)) throw new ProjectError(400, "Invalid task workspace identifier.");
    return path.resolve(this.appDataDir, "workspaces", "tasks", taskId, "workspace");
  }

  ensure(taskId: string): Promise<ManagedWorkspace> {
    return withFileLock(this.filePath, async () => {
      const planned = this.plannedPath(taskId);
      const workspaces = await this.read();
      const existing = workspaces.find(item => item.taskId === taskId);
      if (existing) {
        const actual = await fs.realpath(existing.rootPath).catch(() => undefined);
        if (actual !== existing.rootPath || !(await fs.stat(actual)).isDirectory()) {
          throw new ProjectError(409, "The task's saved workspace is missing or has moved. Restore it before resuming.");
        }
        return existing;
      }
      await fs.mkdir(path.join(this.appDataDir, "workspaces", "tasks"), { recursive: true });
      const root = await fs.realpath(path.join(this.appDataDir, "workspaces", "tasks"));
      const canonicalPlanned = await canonicalPath(planned);
      if (!canonicalPlanned.startsWith(`${root}${path.sep}`)) throw new ProjectError(409, "Managed workspace points outside the task workspace folder.");
      await fs.mkdir(canonicalPlanned, { recursive: true });
      const rootPath = await fs.realpath(planned);
      if (rootPath !== canonicalPlanned) throw new ProjectError(409, "Managed workspace changed while it was being created.");
      const workspace = { taskId, rootPath, createdAt: new Date().toISOString() };
      workspaces.push(workspace);
      await writeJsonAtomically(this.filePath, { version: 1, workspaces });
      return workspace;
    });
  }

  list(): Promise<ManagedWorkspace[]> { return withFileLock(this.filePath, () => this.read()); }

  private async read(): Promise<ManagedWorkspace[]> {
    try {
      const record = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (!Array.isArray(record?.workspaces) || record.workspaces.some((item: ManagedWorkspace) =>
        !item || typeof item.taskId !== "string" || typeof item.rootPath !== "string" || !path.isAbsolute(item.rootPath))) {
        throw new Error("Invalid managed workspace registry.");
      }
      return record.workspaces;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return [];
    }
  }
}
