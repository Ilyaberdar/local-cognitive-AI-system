export const PROJECT_COLORS = ["red", "yellow", "green", "blue", "purple"] as const;
export type ProjectColor = typeof PROJECT_COLORS[number];

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  color?: ProjectColor;
}

export interface CreateProjectInput { name: string; rootPath: string; color?: ProjectColor | null; }
export interface UpdateProjectInput { name?: string; rootPath?: string; archived?: boolean; color?: ProjectColor | null; }

export class ProjectError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}
