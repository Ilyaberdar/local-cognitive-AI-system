import { ControlError } from "./ControlServer";
import { findProject } from "./cloudModels";
import type { Project } from "../projects/types";
import type { Logger } from "../utils/Logger";

// Only types are imported from the runtime: cli.ts loads this module before the configuration is set.

/** A project as `web-targets` shows it: the web origins its Synthesis agents may reach. */
export interface WebTargetsProject { id: string; name: string; rootPath: string; origin: "device" | "host"; archived: boolean; targets: string[] }
export interface WebTargetsRequest { project?: string; targets?: string[] }
export interface WebTargetsResult { projects: WebTargetsProject[]; changed?: WebTargetsProject }

const view = (project: Project): WebTargetsProject => ({ id: project.id, name: project.name, rootPath: project.rootPath,
  origin: project.origin === "device" ? "device" : "host", archived: Boolean(project.archivedAt), targets: project.webTargets ?? [] });

/** The control socket's `web-targets`: the server's owner lists, allows or clears the web origins a
 * project's Synthesis agents may reach, for authorized testing of the owner's own services. Paired
 * computers can only see the choice. */
export function createWebTargetsControl(deps: {
  projects: () => { list(): Promise<Project[]>; get(id: string): Promise<Project | null> };
  synthesis: () => { setWebTargets(projectId: string, targets: unknown): Promise<{ targets: string[] }> };
  logger: Pick<Logger, "info">;
}) {
  return async (request: WebTargetsRequest): Promise<WebTargetsResult> => {
    const list = async () => (await deps.projects().list()).map(view);
    if (request.project === undefined) return { projects: await list() };
    const project = findProject(await deps.projects().list(), request.project);
    const targets = request.targets ?? [];
    if (targets.length && project.archivedAt) throw new ControlError("The project is archived: restore it on a computer first.", "unsupported");
    try { await deps.synthesis().setWebTargets(project.id, targets); }
    catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ControlError("The project's folder no longer exists.", "unsupported");
      throw new ControlError(error instanceof Error ? error.message : String(error), status === 404 ? "project_unknown" : "unsupported");
    }
    deps.logger.info("Web targets for a Synthesis project changed", { projectId: project.id, count: targets.length });
    const saved = await deps.projects().get(project.id);
    return { projects: await list(), ...(saved ? { changed: view(saved) } : {}) };
  };
}
