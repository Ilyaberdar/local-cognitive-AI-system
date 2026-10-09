import { z } from "zod";
import { RemoteOperationError, type RemoteOperation } from "../remote/host/RemoteHost";
import { FolderError, type HostFolders } from "./hostFolders";

const segments = z.array(z.string().min(1).max(255)).max(32);
const schemas = {
  browse: z.object({ rootId: z.string().min(1).max(100), path: segments.optional(), hidden: z.boolean().optional() }).strict(),
  mkdir: z.object({ rootId: z.string().min(1).max(100), path: segments, name: z.string().min(1).max(255) }).strict()
};
const parse = <T>(schema: z.ZodType<T>, payload: unknown): T => {
  const result = schema.safeParse(payload);
  if (!result.success) throw new RemoteOperationError("The request is not valid.", "invalid_request");
  return result.data;
};
/** Folder refusals keep their reason; nothing else about the host's files is told. */
const known = async <T>(task: () => Promise<T>): Promise<T> => {
  try { return await task(); }
  catch (error) {
    if (error instanceof FolderError) throw new RemoteOperationError(error.message, error.code);
    throw new RemoteOperationError("The folder could not be read on the server.", "folder_unavailable");
  }
};

/** The server's shared folders for a paired device (R5-4f): its "Projects" folder and the folders
 * its admin shared (`local-cognitive-server folders`). A place is a root and a list of names. */
export const createFolderOperations = (deps: { folders: HostFolders }): Record<string, RemoteOperation> => ({
  "fs.roots": async () => deps.folders.roots().map(({ path: _path, ...root }) => root),

  "fs.browse": payload => known(async () => {
    const { rootId, path = [], hidden } = parse(schemas.browse, payload);
    return { rootId, path, ...await deps.folders.browse(rootId, path, { hidden }) };
  }),

  "fs.mkdir": payload => known(async () => {
    const { rootId, path, name } = parse(schemas.mkdir, payload);
    return { rootId, path: await deps.folders.mkdir(rootId, path, name) };
  })
});
