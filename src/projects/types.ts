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
  /** Made from a paired device in a shared folder (R5-4g). Any other project was set up on the host. */
  origin?: "device";
  /** Synthesis may send this project's contract and files to cloud models. Only the host sets it. */
  cloudModels?: boolean;
  /** Web origins this project's agents may reach (http(...)), for authorized testing of these services.
   * Only the host sets it; an agent's allowlist must be within it. */
  webTargets?: string[];
}

export interface CreateProjectInput { name: string; rootPath: string; color?: ProjectColor | null; origin?: "device";
  /** The folder as checked by the caller: refused if the path now resolves elsewhere. */
  expectedRoot?: string; }
export interface UpdateProjectInput { name?: string; rootPath?: string; archived?: boolean; color?: ProjectColor | null; cloudModels?: boolean; webTargets?: string[] | null; }

export class ProjectError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}
