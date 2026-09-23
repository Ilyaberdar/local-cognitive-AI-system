export interface WorkspaceSnapshot {
  version: 1;
  kind: "project" | "task" | "legacy-chat";
  rootPath: string;
  outputDir: string;
  allowedDirectories: string[];
  memoryScope: string;
  projectId?: string;
  projectName?: string;
  taskId?: string;
}
