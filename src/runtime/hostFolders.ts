import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** The folder every server offers its devices: created in the data directory, where folders may be made. */
export const MANAGED_ROOT_ID = "projects";
const MAX_ENTRIES = 500, MAX_DEPTH = 32, MAX_PATH = 4096;

export interface FolderRoot { rootId: string; label: string; kind: "managed" | "admin"; canCreate: boolean; path: string }
export interface FolderEntry { name: string; kind: "dir" | "file"; sizeBytes?: number; modifiedAt?: string }

const adminFolder = z.object({ id: z.uuid(), path: z.string().min(1), label: z.string().min(1).max(60).optional(), allowCreate: z.boolean().optional() }).strict();
const foldersFile = z.object({ folders: z.array(adminFolder).max(100) }).strict();
type AdminFolder = z.infer<typeof adminFolder>;

export class FolderError extends Error {
  constructor(message: string, readonly code: "invalid_path" | "not_found" | "forbidden" | "exists" | "invalid_folder") { super(message); }
}

export const foldersFilePath = (dataRoot: string) => path.join(dataRoot, "folders.json");
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

const readAdminFolders = (dataRoot: string): AdminFolder[] => {
  let raw: string;
  try { raw = fs.readFileSync(foldersFilePath(dataRoot), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const parsed = foldersFile.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new FolderError(`${foldersFilePath(dataRoot)} is invalid.`, "invalid_folder");
  return parsed.data.folders;
};

const writeAdminFolders = (dataRoot: string, folders: AdminFolder[]) => {
  const file = foldersFilePath(dataRoot), temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ folders }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
};

/** Admin side (`local-cognitive-server folders`): a folder devices may browse, and use for projects
 * and runs. Never the filesystem root, the data directory, a folder holding it, or one inside it. */
export const addAdminFolder = (dataRoot: string, folder: string, options: { label?: string; allowCreate?: boolean } = {}): AdminFolder => {
  let real: string;
  try { real = fs.realpathSync(path.resolve(folder)); } catch { throw new FolderError(`${folder} does not exist.`, "not_found"); }
  if (!fs.statSync(real).isDirectory()) throw new FolderError(`${folder} is not a folder.`, "invalid_folder");
  if (path.parse(real).root === real) throw new FolderError("The filesystem root cannot be shared.", "invalid_folder");
  const data = fs.realpathSync(dataRoot);
  if (inside(real, data) || inside(data, real)) throw new FolderError("The server's data directory, or a folder holding it, cannot be shared.", "invalid_folder");
  const folders = readAdminFolders(dataRoot);
  if (folders.some(item => item.path === real)) throw new FolderError(`${real} is already shared.`, "exists");
  const added: AdminFolder = { id: randomUUID(), path: real, ...(options.label ? { label: options.label.slice(0, 60) } : {}), ...(options.allowCreate ? { allowCreate: true } : {}) };
  writeAdminFolders(dataRoot, [...folders, added]);
  return added;
};

export const removeAdminFolder = (dataRoot: string, id: string): boolean => {
  const folders = readAdminFolders(dataRoot);
  const kept = folders.filter(folder => folder.id !== id);
  if (kept.length === folders.length) return false;
  writeAdminFolders(dataRoot, kept);
  return true;
};

export const listAdminFolders = readAdminFolders;

/** The folders a server offers its devices (R5-4f): its own "Projects" folder, plus folders the
 * admin shared. Read at every use, so a folder the admin removes is refused at once. A device names
 * a place by root and path segments; nothing it receives names a folder of the host. */
export class HostFolders {
  constructor(private readonly dataRoot: string) {}

  /** Creates the managed folder (private to the server's user). */
  ensureManaged(): void {
    fs.mkdirSync(path.join(this.dataRoot, MANAGED_ROOT_ID), { recursive: true, mode: 0o700 });
  }

  roots(): FolderRoot[] {
    const managed: FolderRoot = { rootId: MANAGED_ROOT_ID, label: "Projects", kind: "managed", canCreate: true, path: path.join(this.dataRoot, MANAGED_ROOT_ID) };
    let admin: AdminFolder[] = [];
    try { admin = readAdminFolders(this.dataRoot); } catch { /* An unreadable list shares nothing. */ }
    return [managed, ...admin.map(folder => ({ rootId: folder.id, label: folder.label ?? path.basename(folder.path), kind: "admin" as const,
      canCreate: Boolean(folder.allowCreate), path: folder.path }))];
  }

  /** A place inside a root: each segment one name (no separators, `.` or `..`), resolved through
   * symlinks, and still inside the root. */
  async resolve(rootId: string, segments: string[] = []): Promise<{ root: FolderRoot; real: string }> {
    const root = this.roots().find(item => item.rootId === rootId);
    if (!root) throw new FolderError("This folder is not shared by the server.", "not_found");
    if (segments.length > MAX_DEPTH || segments.join("/").length > MAX_PATH) throw new FolderError("The path is too long.", "invalid_path");
    for (const segment of segments) {
      if (!segment || segment === "." || segment === ".." || /[\\/\u0000]/.test(segment) || Buffer.byteLength(segment) > 255) {
        throw new FolderError("A path is a list of folder and file names.", "invalid_path");
      }
    }
    let realRoot: string, real: string;
    try { realRoot = await fsp.realpath(root.path); }
    catch { throw new FolderError("This folder is not available on the server.", "not_found"); }
    try { real = await fsp.realpath(path.join(realRoot, ...segments)); }
    catch { throw new FolderError("This path does not exist on the server.", "not_found"); }
    if (!inside(real, realRoot)) throw new FolderError("This path leaves the shared folder.", "forbidden");
    return { root, real };
  }

  /** Where an absolute folder of the host lies among the current roots (for what a device is shown). */
  locate(absolute: string): { rootId: string; label: string; path: string[] } | undefined {
    let real: string;
    try { real = fs.realpathSync(absolute); } catch { return undefined; }
    for (const root of this.roots()) {
      let realRoot: string;
      try { realRoot = fs.realpathSync(root.path); } catch { continue; }
      if (inside(real, realRoot)) return { rootId: root.rootId, label: root.label, path: path.relative(realRoot, real).split(path.sep).filter(Boolean) };
    }
    return undefined;
  }

  /** A folder's entries: folders first, at most 500, hidden ones only when asked; an entry whose
   * link leads out of the shared folder is left out. */
  async browse(rootId: string, segments: string[] = [], { hidden = false } = {}): Promise<{ entries: FolderEntry[]; truncated: boolean }> {
    const { real } = await this.resolve(rootId, segments);
    const realRoot = await fsp.realpath(this.roots().find(item => item.rootId === rootId)!.path);
    if (!(await fsp.stat(real)).isDirectory()) throw new FolderError("This is a file, not a folder.", "invalid_path");
    const names = (await fsp.readdir(real)).filter(name => hidden || !name.startsWith(".")).sort((a, b) => a.localeCompare(b));
    const entries: FolderEntry[] = [];
    for (const name of names) {
      try {
        const target = await fsp.realpath(path.join(real, name));
        if (!inside(target, realRoot)) continue;
        const stat = await fsp.stat(target);
        if (stat.isDirectory()) entries.push({ name, kind: "dir", modifiedAt: stat.mtime.toISOString() });
        else if (stat.isFile()) entries.push({ name, kind: "file", sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
      } catch { /* A dangling link or an entry that went away. */ }
    }
    entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1) || a.name.localeCompare(b.name));
    return { entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
  }

  /** Makes one folder, where the root allows it. */
  async mkdir(rootId: string, segments: string[], name: string): Promise<string[]> {
    const { root, real } = await this.resolve(rootId, segments);
    if (!root.canCreate) throw new FolderError("New folders cannot be made here.", "forbidden");
    await this.resolve(rootId, [...segments, name]).then(() => { throw new FolderError("A folder with this name exists.", "exists"); },
      error => { if (!(error instanceof FolderError) || error.code !== "not_found") throw error; });
    await fsp.mkdir(path.join(real, name), { mode: 0o755 });
    return [...segments, name];
  }
}
