import { z } from "zod";
import type { RuntimeManager } from "../app/RuntimeManager";
import { ProjectError, PROJECT_COLORS, type Project } from "../projects/types";
import { RemoteOperationError, type OperationContext, type RemoteOperation } from "../remote/host/RemoteHost";
import type { CommandLedger } from "./CommandLedger";
import { FolderError, type HostFolders } from "./hostFolders";
import { place as hostPlace } from "./hostPlace";

export const PROJECT_ON_HOST = (): string => `This project's folder was chosen on ${hostPlace()}, so its chats can only be used there.`;
const ARCHIVED = "The project is archived. Restore it to use its chats.";

/** A project made from a device whose folder is still shared: the only kind a device may use. One
 * the host set up is the host's even when its folder lies in a shared folder: the host chose it. */
const deviceFolder = (project: Project, folders: HostFolders) => project.origin === "device" ? folders.locate(project.rootPath) : undefined;
/** Set up on the host itself: a device the host trusts uses its chats. One made from a device whose
 * folder is no longer shared is no device's, trusted or not: unsharing ends it for every device. */
const hostMade = (project: Project) => project.origin !== "device";

/** A project as a device sees it: its folder as a place in a shared folder, or none (set up on the
 * server, `hostOnly`); never the folder's path on the host. A device trusted there is told it may use
 * the chats of a project set up on the host (`trustedChats`), still without the folder. */
export const safeProject = (project: Project, folders: HostFolders, trusted = false) => {
  const folder = deviceFolder(project, folders);
  return { id: project.id, name: project.name, ...(project.color ? { color: project.color } : {}), archived: Boolean(project.archivedAt),
    createdAt: project.createdAt, updatedAt: project.updatedAt, ...(project.cloudModels ? { cloudModels: true as const } : {}),
    ...(folder ? { folder: { rootId: folder.rootId, rootLabel: folder.label, path: folder.path } } : { hostOnly: true as const, ...(trusted && hostMade(project) ? { trustedChats: true as const } : {}) }) };
};

/** The device a request comes from, as the host knows it. */
export type ProjectCaller = Pick<OperationContext, "accountId" | "deviceId">;

export interface ProjectAccess {
  /** Whether a device may see the project's chats at all: its folder is inside a shared folder (an
   * archived project's chats stay readable). A project set up on the server keeps its chats there:
   * they hold what its folder on the host contains, unless the `caller` is a device the host trusts,
   * which sees them as the host does. Without a caller (Synthesis, tasks), only the first. */
  visible(projectId: string, caller?: ProjectCaller): Promise<boolean>;
  /** Whether a device may use the project's chats now: it exists, is not archived and its folder is
   * still inside a shared folder, or it was set up on the host and the `caller` is trusted there
   * (`hostProject`). Checked at every use, so an unshared folder or trust taken back ends it at once. */
  usable(projectId: string, caller?: ProjectCaller): Promise<{ project: Project; reason?: string; hostProject?: true }>;
}

export const createProjectAccess = (deps: { runtimeManager: RuntimeManager; folders: HostFolders;
  /** Whether the host trusts this device, read at every call; absent means none is. */
  deviceTrust?: (caller: ProjectCaller) => boolean }): ProjectAccess => {
  const trusted = (caller?: ProjectCaller) => Boolean(caller && deps.deviceTrust?.(caller));
  return {
    async visible(projectId, caller) {
      const project = await deps.runtimeManager.getRuntime().projectStore.get(projectId);
      return Boolean(project && (deviceFolder(project, deps.folders) || (hostMade(project) && trusted(caller))));
    },
    async usable(projectId, caller) {
      const project = await deps.runtimeManager.getRuntime().projectStore.get(projectId);
      if (!project) throw new RemoteOperationError(`The project does not exist on ${hostPlace()}.`, "project_unknown");
      const own = deviceFolder(project, deps.folders);
      if (!own && !(hostMade(project) && trusted(caller))) return { project, reason: PROJECT_ON_HOST() };
      if (project.archivedAt) return { project, reason: ARCHIVED };
      return own ? { project } : { project, hostProject: true };
    }
  };
};

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
  /** Whether the host trusts the calling device: it may then also rename, recolour and restore a
   * project set up on the host, whose chats it uses. */
  deviceTrust?: (caller: ProjectCaller) => boolean;
}

/** Projects of the server for a paired device (R5-4g): created in a shared folder (a command, so a
 * resend makes one project), renamed, recoloured, archived and restored. A project whose folder was
 * chosen on the server is listed by name and may only be archived from a device, unless the device is
 * one the host trusts: that one changes it as the host would. */
export const createProjectOperations = (deps: ProjectOperationDependencies): Record<string, RemoteOperation> => {
  const store = () => deps.runtimeManager.getRuntime().projectStore;
  const trusted = (context: OperationContext) => deps.deviceTrust?.(context) === true;
  return {
    "projects.list": async (_payload, context) => {
      const trust = trusted(context);
      return (await store().list()).map(project => safeProject(project, deps.folders, trust));
    },

    "projects.create": (payload, context) => known(async () => {
      const { commandId: key, ...input } = parse(schemas.create, payload);
      return deps.ledger.run({ scope: deps.scopeOf(context), key, operation: "projects.create", payload: input, accepting: () => !deps.isDraining(),
        // A restart after the project was made: that project is the answer.
        reconcile: async () => {
          const { real } = await deps.folders.resolve(input.folder.rootId, input.folder.path).catch(() => ({ real: "" }));
          const made = real ? (await store().list()).find(project => project.origin === "device" && project.rootPath === real) : undefined;
          return made ? safeProject(made, deps.folders) : undefined;
        } },
        // Refusals become codes here, so the ledger keeps them for a resend.
        () => known(async () => {
          const { real } = await deps.folders.resolve(input.folder.rootId, input.folder.path);
          return safeProject(await store().create({ name: input.name, rootPath: real, expectedRoot: real, origin: "device",
            ...(input.color !== undefined ? { color: input.color } : {}) }), deps.folders);
        }));
    }),

    "projects.update": (payload, context) => known(async () => {
      const { projectId, ...patch } = parse(schemas.update, payload);
      const project = await store().get(projectId);
      if (!project) throw new RemoteOperationError(`The project does not exist on ${hostPlace()}.`, "project_unknown");
      // A project set up on the server may be archived from a device, nothing more; a trusted one changes it all.
      const trust = trusted(context);
      if (!deviceFolder(project, deps.folders) && !trust && (patch.name !== undefined || patch.color !== undefined || patch.archived !== true)) {
        throw new RemoteOperationError(PROJECT_ON_HOST().replace("its chats can only be used there", "it can only be changed there"), "unsupported");
      }
      const saved = await store().update(projectId, patch);
      if (!saved) throw new RemoteOperationError(`The project does not exist on ${hostPlace()}.`, "project_unknown");
      return safeProject(saved, deps.folders, trust);
    })
  };
};
