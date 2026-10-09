import fs from "node:fs/promises";
import path from "node:path";
import { containedPath, relativePath } from "./paths";
import { SynthesisError } from "./types";

export const MODULE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ignoredFolders = new Set(["node_modules", "dist", "build", "release", "coverage", "vendor", "target", "Binaries", "Intermediate", "DerivedDataCache"]);
export function moduleName(name: string): string {
  if (typeof name !== "string" || !MODULE_NAME.test(name)) throw new SynthesisError("Module names must start with a letter and contain only letters, numbers or underscores (up to 64 characters).");
  return name;
}
export function moduleDirectory(value: unknown = "Synthesis"): string {
  if (value === "" || value === ".") return "";
  const directory = relativePath(value);
  if (directory.split("/").some(part => ignoredFolders.has(part))) throw new SynthesisError("Choose a source folder, not an excluded dependency or build directory.");
  if (directory.split("/").length > 11) throw new SynthesisError("Choose a folder at most 11 levels below the project root so Refresh can discover the module.");
  return directory;
}
export function moduleSources(id: string): {name: string; specPath: string; flowPath: string} {
  if (id.startsWith("file:")) {
    const base = relativePath(id.slice(5));
    const name = moduleName(path.posix.basename(base));
    relativePath(`${base}.lcspec`); relativePath(`${base}.lcflow`);
    return {name, specPath: `${base}.lcspec`, flowPath: `${base}.lcflow`};
  }
  const name = moduleName(id);
  return {name, specPath: `Synthesis/${name}/${name}.lcspec`, flowPath: `Synthesis/${name}/${name}.lcflow`};
}
export function sourceId(base: string): string {
  const name = path.posix.basename(base);
  return base === `Synthesis/${name}/${name}` ? name : `file:${base}`;
}
function visibleDirectory(name: string): boolean {
  return !ignoredFolders.has(name) && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name);
}

/** Read-only, bounded discovery. Pair files by basename, never by a mutable registry. */
export async function discoverModules(root: string): Promise<string[]> {
  const found = new Set<string>();
  const pending = [{directory: "", depth: 0}];
  let entries = 0;
  while (pending.length) {
    const {directory, depth} = pending.shift()!;
    const folder = directory ? await containedPath(root, directory) : root;
    for (const item of await fs.readdir(folder, {withFileTypes: true})) {
      if (++entries > 20000) throw new SynthesisError("Module discovery reached 20,000 entries. Select a project folder closer to your DSL files.");
      const relative = directory ? `${directory}/${item.name}` : item.name;
      if (item.isDirectory() && visibleDirectory(item.name)) {
        if (depth >= 12) continue;
        if (relative.length < 240) pending.push({directory: relative, depth: depth + 1});
      } else if (item.isFile() && /\.(lcspec|lcflow)$/.test(item.name)) {
        const name = item.name.replace(/\.(lcspec|lcflow)$/, "");
        if (!MODULE_NAME.test(name)) continue;
        // A path outside the naming rules (too long, say) is skipped, not fatal to the whole list.
        try { relativePath(relative); } catch { continue; }
        found.add(sourceId(relative.replace(/\.(lcspec|lcflow)$/, "")));
        if (found.size > 100) throw new SynthesisError("A project can expose at most 100 Synthesis modules. Select a more specific project folder.");
      }
    }
  }
  return [...found].sort();
}

export async function moduleFolders(root: string, directory: string): Promise<string[]> {
  const folder = directory ? await containedPath(root, directory) : root;
  return (await fs.readdir(folder, {withFileTypes: true}))
    .filter(item => item.isDirectory() && visibleDirectory(item.name))
    .map(item => item.name).sort();
}
