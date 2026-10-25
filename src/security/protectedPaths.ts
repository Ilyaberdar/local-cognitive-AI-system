import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config as defaultConfig, type AppConfig } from "../config/config";

/** The app's own files — settings, keys, chats, memory, the vault and its key, the server's
 * configuration — are never read or changed by its file tools, whatever the access mode and
 * whatever was approved: a model's request, a workflow step or a paired device cannot reach them
 * through a file tool. Within them, the folders where tools are meant to work stay open: the output
 * folder, the workspaces of tasks and workflow runs, and a server's Projects folder. Terminals and
 * commands are not covered (a command with full access runs as the user). */

export const PROTECTED_REASON = "This is the app's own data folder; the app's files are never read or changed by tools.";
const STREAM_REASON = "A path naming an alternate data stream is not read or changed by tools.";

/** A path refused for being one of the app's own files. `statusCode` for the API's error handler. */
export class ProtectedPathError extends Error {
  readonly statusCode = 403;
  readonly code = "protected_path";
  constructor(message = PROTECTED_REASON) { super(message); }
}

export interface ProtectedPaths {
  /** Folders and files never read or changed. */
  roots: string[];
  /** Folders inside them where tools work. */
  carveOuts: string[];
}

type PathConfig = Pick<AppConfig, "appDataDir" | "outputDir"> & { sessions?: { baseDir?: string }; memory?: { baseDir?: string; openMemory?: { dbPath?: string } } };

/** The app's own places for a configuration. `userDataDir`: the desktop app's data folder (Electron's
 * userData, which also holds the window's own storage). A data root (the folder holding app/ and
 * sessions/: the desktop's user data, a server's data directory, `./data` in a checkout) is protected
 * as a whole, with its output and projects folders open. */
export function protectedPathsFor(config: PathConfig, options: { userDataDir?: string; env?: NodeJS.ProcessEnv; cwd?: string; home?: string; platform?: NodeJS.Platform } = {}): ProtectedPaths {
  const env = options.env ?? process.env, cwd = options.cwd ?? process.cwd(), platform = options.platform ?? process.platform;
  let home: string | undefined;
  try { home = options.home ?? os.homedir(); } catch { /* No home. */ }
  const appData = path.resolve(config.appDataDir);
  const sessions = config.sessions?.baseDir ? path.resolve(config.sessions.baseDir) : undefined;
  // Only a folder that is the data root by its layout (app/ beside sessions/): never a folder an
  // APP_DATA_DIR of its own happens to sit in.
  const dataRoot = path.basename(appData) === "app" && sessions && path.dirname(sessions) === path.dirname(appData) ? path.dirname(appData) : undefined;
  const roots = [options.userDataDir, dataRoot, appData, sessions, config.memory?.baseDir];
  const openMemory = config.memory?.openMemory?.dbPath;
  if (openMemory) roots.push(...["", "-wal", "-shm", "-journal"].map(suffix => `${openMemory}${suffix}`));
  // The environment file (keys), the config file, the vault key and the app's other credential files.
  const envFile = env.LOCAL_COGNITIVE_ENV_FILE;
  if (envFile !== "none") roots.push(path.resolve(cwd, envFile || ".env"));
  roots.push(path.resolve(cwd, env.LOCAL_COGNITIVE_CONFIG ?? "local-cognitive.config.json"));
  for (const name of ["LOCAL_COGNITIVE_VAULT_KEY_FILE", "LOCAL_COGNITIVE_OAUTH_CLIENTS_FILE"]) if (env[name]?.trim()) roots.push(path.resolve(cwd, env[name]!.trim()));
  for (const file of (env.LOCAL_COGNITIVE_VAULT_PREVIOUS_KEY_FILES ?? "").split(path.delimiter).map(item => item.trim()).filter(Boolean)) roots.push(path.resolve(cwd, file));
  if (platform !== "win32") roots.push("/etc/local-cognitive");
  if (home) roots.push(path.join(home, ".config", "local-cognitive"));
  if (env.XDG_CONFIG_HOME?.trim()) roots.push(path.join(path.resolve(env.XDG_CONFIG_HOME.trim()), "local-cognitive"));
  const carveOuts = [config.outputDir, path.join(appData, "workspaces", "tasks"), path.join(appData, "workspaces", "workflow-runs"),
    ...(dataRoot ? [path.join(dataRoot, "projects")] : [])];
  return { roots: unique(roots), carveOuts: unique(carveOuts) };
}

const unique = (items: Array<string | undefined>): string[] => [...new Set(items.filter((item): item is string => Boolean(item?.trim())).map(item => path.resolve(item)))];

interface Entry { path: string; key: string; identity?: string }

/** The protected places, each by its spelling (NFC, case folded where the file system ignores case)
 * and by device and inode once it exists, so another spelling, a hard link to a folder or a bind
 * mount is still recognised. */
class Checker {
  private readonly roots: Entry[];
  private readonly carveOuts: Entry[];
  private refreshedAt = 0;
  constructor(paths: ProtectedPaths, private readonly platform: NodeJS.Platform) {
    const entry = (item: string): Entry => { const real = canonical(item); return { path: real, key: this.key(real) }; };
    this.roots = paths.roots.map(entry);
    this.carveOuts = paths.carveOuts.map(entry);
    this.refreshIdentities();
  }
  key(value: string): string {
    const normal = value.normalize("NFC");
    return this.platform === "darwin" || this.platform === "win32" ? normal.toLowerCase() : normal;
  }
  /** Places made since (a sessions folder created after start) are identified again, at most once a second. */
  private refreshIdentities(): void {
    if (Date.now() - this.refreshedAt < 1000) return;
    this.refreshedAt = Date.now();
    for (const entry of [...this.roots, ...this.carveOuts]) if (!entry.identity) entry.identity = identity(entry.path);
  }
  /** What one place is by itself: protected, a carve-out ("open"), or neither (its folder decides). A
   * place both is protected. */
  kindOf(place: string): "open" | "protected" | undefined {
    const key = this.key(place);
    if (this.roots.some(entry => entry.key === key)) return "protected";
    if (this.carveOuts.some(entry => entry.key === key)) return "open";
    const id = identity(place);
    if (!id) return undefined;
    this.refreshIdentities();
    if (this.roots.some(entry => entry.identity === id)) return "protected";
    if (this.carveOuts.some(entry => entry.identity === id)) return "open";
    return undefined;
  }
  /** The nearest of the place and its folders that is a carve-out or protected decides. */
  decide(real: string): boolean {
    for (let current = real; ; current = path.dirname(current)) {
      const kind = this.kindOf(current);
      if (kind) return kind === "protected";
      if (path.dirname(current) === current) return false;
    }
  }
}

const identity = (place: string): string | undefined => {
  try { const stat = fs.statSync(place, { bigint: true }); return `${stat.dev}:${stat.ino}`; }
  catch { return undefined; }
};

/** A path through its links: the real path of what exists, a missing tail as written, and a link
 * that points at nothing followed to where it points (a write through it would create that file). */
function canonical(target: string, depth = 0): string {
  const resolved = path.resolve(target);
  if (depth > 40) return resolved;
  try { return fs.realpathSync.native(resolved); } catch { /* Missing, or a link to nothing. */ }
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) return canonical(path.resolve(path.dirname(resolved), fs.readlinkSync(resolved)), depth + 1);
  } catch { /* Not there at all. */ }
  const parent = path.dirname(resolved);
  return parent === resolved ? resolved : path.join(canonical(parent, depth), path.basename(resolved));
}

const registered = new Map<string, ProtectedPaths>();
let checker: Checker | undefined;
let platformOverride: NodeJS.Platform | undefined;

/** Adds (or replaces, under the same key) a set of protected places; undefined removes it. The
 * configuration the process started with is always protected. */
export function setProtectedPaths(key: string, paths: ProtectedPaths | undefined): void {
  if (paths) registered.set(key, paths); else registered.delete(key);
  checker = undefined;
}
/** Tests: the platform whose case rules apply. */
export function setProtectedPathsPlatform(platform: NodeJS.Platform | undefined): void { platformOverride = platform; checker = undefined; }

const active = (): Checker => {
  if (checker) return checker;
  const sets = [protectedPathsFor(defaultConfig), ...registered.values()];
  return checker = new Checker({ roots: unique(sets.flatMap(set => set.roots)), carveOuts: unique(sets.flatMap(set => set.carveOuts)) }, platformOverride ?? process.platform);
};

/** Why a file tool may not use this path, or undefined when it may: one of the app's own files or
 * folders (and not in a carve-out), or, on Windows, a name with an alternate data stream. The path is
 * resolved through links first, the nearest existing folder's real path for one that does not exist. */
export function protectedPathReason(target: string): string | undefined {
  const platform = platformOverride ?? process.platform;
  if (platform === "win32" && /:/.test(path.resolve(target).replace(/^(?:\\\\[?.]\\)?[A-Za-z]:/, ""))) return STREAM_REASON;
  return active().decide(canonical(target)) ? PROTECTED_REASON : undefined;
}

/** Throws ProtectedPathError for a path protectedPathReason refuses. */
export function assertNotProtected(target: string): void {
  const reason = protectedPathReason(target);
  if (reason) throw new ProtectedPathError(reason);
}

/** For a walk that has already checked the folder it is in: whether this entry itself is one of the
 * app's own places (a carve-out inside a protected folder is never reached that way). */
export function isProtectedEntry(entry: string): boolean {
  return active().kindOf(path.resolve(entry)) === "protected";
}
