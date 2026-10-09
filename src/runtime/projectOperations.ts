import { z } from "zod";
import type { RuntimeManager } from "../app/RuntimeManager";
import { ProjectError, PROJECT_COLORS, type Project } from "../projects/types";
import { RemoteOperationError, type OperationContext, type RemoteOperation } from "../remote/host/RemoteHost";
import type { CommandLedger } from "./CommandLedger";
import { FolderError, type HostFolders } from "./hostFolders";

export const PROJECT_ON_HOST = "This project's folder was chosen on the server, so its chats can only be used there.";
const ARCHIVED = "The project is archived. Restore it to use its chats.";

/** A project as a device sees it: its folder as a place in a shared folder, or none (set up on the
 * server, `hostOnly`); never the folder's path on the host. */
export const safeProject = (project: Project, folders: HostFolders) => {
  const folder = folders.locate(project.rootPath);
  return { id: project.id, name: project.name, ...(project.color ? { color: project.color } : {}), archived: Boolean(project.archivedAt),
    createdAt: project.createdAt, updatedAt: project.updatedAt,
    ...(folder ? { folder: { rootId: folder.rootId, rootLabel: folder.label, path: folder.path } } : { hostOnly: true as const }) };
};

export interface ProjectAccess {
  /** Whether a device may see the project's chats at all: its folder is inside a shared folder (an
   * archived project's chats stay readable). A project set up on the server keeps its chats there:
   * they hold what its folder on the host contains. */
  visible(projectId: string): Promise<boolean>;
  /** Whether a device may use the project's chats now: it exists, is not archived and its folder is
   * still inside a shared folder (checked at every use, so an unshared folder ends it at once). */
  usable(projectId: string): Promise<{ project: Project; reason?: string }>;
}

export const createProjectAccess = (deps: { runtimeManager: RuntimeManager; folders: HostFolders }): ProjectAccess => ({
  async visible(projectId) {
    const project = await deps.runtimeManager.getRuntime().projectStore.get(projectId);
    return Boolean(project && deps.folders.locate(project.rootPath));
  },
  async usable(projectId) {
    const project = await deps.runtimeManager.getRuntime().projectStore.get(projectId);
    if (!project) throw new RemoteOperationError("The project does not exist on the server.", "project_unknown");
    if (!deps.folders.locate(project.rootPath)) return { project, reason: PROJECT_ON_HOST };
    if (project.archivedAt) return { project, reason: ARCHIVED };
    return { project };
  }
});

const commandId = z.string().min(8).max(100);
const name = z.string().trim().min(1).max(120);
const color = z.enum(PROJECT_COLORS).nullable().optional();
const place = z.object({ rootId: z.string().min(1).max(100), path: z.array(z.string().min(1).max(255)).max(32) }).strict();
const schemas = {
  create: z.object({ commandId, name, folder: place, color }).strict(),
  update: z.object({ projectId: z.string().min(1).max(200), name: name.optional(), color, archived: z.boolean().optional() }).strict()
};
const parse = <T>(schema: z.ZodType<T>, payload: unknown): T => {
  const result = schema.safeParse(payload);
  if (!result.success) throw new RemoteOperationError("The request is not valid.", "invalid_request");
  return result.data;
};
const known = async <T>(task: () => Promise<T>): Promise<T> => {
  try { return await task(); }
  catch (error) {
    if (error instanceof FolderError) throw new RemoteOperationError(error.message, error.code);
    if (error instanceof ProjectError) throw new RemoteOperationError(error.statusCode === 409 ? error.message : "The project could not be saved.", error.statusCode === 409 ? "conflict" : "invalid_request");
    throw error;
  }
};

export interface ProjectOperationDependencies {
  runtimeManager: RuntimeManager;
  folders: HostFolders;
  ledger: CommandLedger;
  scopeOf(context: OperationContext): string;
  isDraining(): boolean;
}

/** Projects of the server for a paired device (R5-4g): created in a shared folder (a command, so a
 * resend makes one project), renamed, recoloured, archived and restored. A project whose folder was
 * chosen on the server is listed by name and may only be archived from a device. */
export const createProjectOperations = (deps: ProjectOperationDependencies): Record<string, RemoteOperation> => {
  const store = () => deps.runtimeManager.getRuntime().projectStore;
  return {
    "projects.list": async () => (await store().list()).map(project => safeProject(project, deps.folders)),

    "projects.create": (payload, context) => known(async () => {
      const { commandId: key, ...input } = parse(schemas.create, payload);
      return deps.ledger.run({ scope: deps.scopeOf(context), key, operation: "projects.create", payload: input, accepting: () => !deps.isDraining() }, async () => {
        const { real } = await deps.folders.resolve(input.folder.rootId, input.folder.path);
        return safeProject(await store().create({ name: input.name, rootPath: real, ...(input.color !== undefined ? { color: input.color } : {}) }), deps.folders);
      });
    }),

    "projects.update": payload => known(async () => {
      const { projectId, ...patch } = parse(schemas.update, payload);
      const project = await store().get(projectId);
      if (!project) throw new RemoteOperationError("The project does not exist on the server.", "project_unknown");
      // A project set up on the server may be archived from a device, nothing more.
      if (!deps.folders.locate(project.rootPath) && (patch.name !== undefined || patch.color !== undefined || patch.archived !== true)) {
        throw new RemoteOperationError(PROJECT_ON_HOST.replace("its chats can only be used there", "it can only be changed there"), "unsupported");
      }
      const saved = await store().update(projectId, patch);
      if (!saved) throw new RemoteOperationError("The project does not exist on the server.", "project_unknown");
      return safeProject(saved, deps.folders);
    })
  };
};
