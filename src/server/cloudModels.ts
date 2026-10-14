import fs from "fs";
import path from "path";
import { ControlError } from "./ControlServer";
import { printable } from "./terminalText";
import type { Project } from "../projects/types";
import type { Logger } from "../utils/Logger";

// Only types are imported from the runtime: cli.ts loads this module before the configuration is set.

/** A project as `cloud-models` shows it: whether its Synthesis flows may use cloud models. */
export interface CloudModelsProject { id: string; name: string; rootPath: string; origin: "device" | "host"; archived: boolean; allowed: boolean }
export interface CloudModelsRequest { project?: string; allowed?: boolean }
export interface CloudModelsResult { projects: CloudModelsProject[]; changed?: CloudModelsProject }

const view = (project: Project): CloudModelsProject => ({ id: project.id, name: project.name, rootPath: project.rootPath,
  origin: project.origin === "device" ? "device" : "host", archived: Boolean(project.archivedAt), allowed: project.cloudModels === true });

const realpath = (file: string) => { try { return fs.realpathSync(file); } catch { return undefined; } };

/** The project an admin named: its id, its name (exactly, then ignoring case, when only one has
 * it) or its folder as an absolute path. Never a guess: a name two projects share is refused. */
export function findProject(projects: Project[], query: string): Project {
  const byId = projects.find(project => project.id === query);
  if (byId) return byId;
  const named = (match: (name: string) => boolean) => projects.filter(project => match(project.name));
  let found = named(name => name === query);
  if (!found.length) found = named(name => name.toLowerCase() === query.toLowerCase());
  // A relative path would be read from / (the command runs there): only an absolute one is a folder.
  if (!found.length && path.isAbsolute(query)) {
    const target = path.resolve(query), real = realpath(target);
    found = projects.filter(project => project.rootPath === target || (real !== undefined && project.rootPath === real));
  }
  if (found.length === 1) return found[0]!;
  if (found.length > 1) throw new ControlError(`${found.length} projects are called that. Name one by its id:\n${found.map(project => `  ${project.id}  ${printable(project.rootPath)}`).join("\n")}`, "ambiguous");
  throw new ControlError("No project on this server has that id, name or folder. See: sudo local-cognitive-server cloud-models", "project_unknown");
}

/** The control socket's `cloud-models`: the server's owner allows or forbids a project's Synthesis
 * flows to send its contract and files to cloud models. Paired computers can only see the choice. */
export function createCloudModelsControl(deps: {
  projects: () => { list(): Promise<Project[]>; get(id: string): Promise<Project | null> };
  synthesis: () => { setCloudModels(projectId: string, allowed: unknown): Promise<{ allowed: boolean }> };
  logger: Pick<Logger, "info">;
}) {
  return async (request: CloudModelsRequest): Promise<CloudModelsResult> => {
    const list = async () => (await deps.projects().list()).map(view);
    if (request.project === undefined) return { projects: await list() };
    const project = findProject(await deps.projects().list(), request.project);
    if (request.allowed === true && project.archivedAt) throw new ControlError("The project is archived: restore it on a computer first.", "unsupported");
    try { await deps.synthesis().setCloudModels(project.id, request.allowed === true); }
    catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ControlError("The project's folder no longer exists.", "unsupported");
      throw new ControlError(error instanceof Error ? error.message : String(error), status === 404 ? "project_unknown" : "unsupported");
    }
    deps.logger.info("Cloud models for a Synthesis project changed", { projectId: project.id, allowed: request.allowed === true });
    const saved = await deps.projects().get(project.id);
    return { projects: await list(), ...(saved ? { changed: view(saved) } : {}) };
  };
}
