import fs from "fs/promises";
import path from "path";
import os from "os";
import { allModelArtifacts } from "./ModelArtifacts";
import { LibraryModel, LocalModelStorageSnapshot } from "./types";

type ExternalLibraryRoot = { providerId: string; name: string; path: string; groupDepth?: number };

/** Read metadata only. Never follow links, open weights, import, or delete another provider's files. */
export const inspectModelStorage = async (
  modelsDir: string,
  models: LibraryModel[],
  externalRoots: ExternalLibraryRoot[] = [{ providerId: "lmstudio", name: "LM Studio", path: path.join(os.homedir(), ".lmstudio", "models") }],
  temporaryRoots: string[] = [os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])]
): Promise<LocalModelStorageSnapshot> => {
  const result: LocalModelStorageSnapshot = { managedBytes: 0, partialBytes: 0, untrackedBytes: 0, externalLibraries: [], warnings: [] };
  const registered = new Set(models.flatMap(model => allModelArtifacts(model).map(file => path.resolve(modelsDir, model.id, file.path))));
  type Entry = { path: string; size: number };
  const scan = async (root: string): Promise<Entry[]> => {
    const entries: Entry[] = [];
    let visited = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (visited > 20000) return;
      if (depth > 8) { result.warnings.push(`Storage scan skipped deeply nested files in ${directory}.`); return; }
      let children;
      try {
        const stat = await fs.lstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return;
        children = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push(`Could not inspect ${directory}.`);
        return;
      }
      for (const child of children) {
        if (++visited > 20000) { result.warnings.push(`Storage scan reached its file limit in ${root}.`); return; }
        const file = path.join(directory, child.name);
        if (child.isDirectory()) await walk(file, depth + 1);
        else if (child.isFile() && child.name !== ".owner.json") {
          try { const stat = await fs.lstat(file); if (stat.isFile()) entries.push({ path: file, size: stat.size }); }
          catch { result.warnings.push(`Could not inspect ${file}.`); }
        }
      }
    };
    await walk(root, 0);
    return entries;
  };
  for (const file of await scan(path.resolve(modelsDir))) {
    if (registered.has(file.path)) result.managedBytes += file.size;
    else if (file.path.startsWith(path.join(path.resolve(modelsDir), ".downloads") + path.sep)) result.partialBytes += file.size;
    else result.untrackedBytes += file.size;
  }
  if (result.untrackedBytes) result.warnings.push("The model folder contains files outside the installed library. They are preserved; import their GGUF files to make them available.");
  const managedRoot = await fs.realpath(modelsDir).catch(() => path.resolve(modelsDir));
  const discovered: ExternalLibraryRoot[] = [];
  const temporarySeen = new Set<string>();
  for (const temporaryRoot of temporaryRoots) {
    const resolvedRoot = await fs.realpath(temporaryRoot).catch(() => undefined);
    if (!resolvedRoot || temporarySeen.has(resolvedRoot)) continue;
    temporarySeen.add(resolvedRoot);
    try {
      const directory = await fs.opendir(resolvedRoot);
      let visited = 0;
      // Inspect only immediate test-profile names and their explicit models/ child.
      // Electron caches, logs, unrelated temp directories and links are never traversed.
      for await (const entry of directory) {
        if (++visited > 10000 || discovered.length >= 64) {
          result.warnings.push(`Temporary model discovery reached its directory limit in ${resolvedRoot}.`);
          break;
        }
        if (!entry.isDirectory() || !/^lcai-[a-z0-9][a-z0-9._-]*$/i.test(entry.name)) continue;
        const candidate = path.join(resolvedRoot, entry.name, "models");
        const stat = await fs.lstat(candidate).catch(() => undefined);
        if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
        if (await fs.realpath(candidate).catch(() => undefined) !== candidate) continue;
        discovered.push({ providerId: "temporary", name: `Temporary test models — ${entry.name}`, path: candidate, groupDepth: 1 });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push(`Could not inspect temporary model profiles in ${resolvedRoot}.`);
    }
  }
  const inspectedRoots = new Set<string>();
  for (const root of [...externalRoots, ...discovered]) {
    const externalPath = path.resolve(root.path);
    const resolved = await fs.realpath(externalPath).catch(() => externalPath);
    if (resolved === managedRoot || resolved.startsWith(managedRoot + path.sep) || managedRoot.startsWith(resolved + path.sep)) continue;
    if (inspectedRoots.has(resolved)) continue;
    inspectedRoots.add(resolved);
    const files = await scan(externalPath);
    if (!files.length) continue;
    const groups = new Map<string, { name: string; path: string; sizeBytes: number; gguf: boolean; mlx: boolean }>();
    for (const file of files) {
      const relative = path.relative(externalPath, file.path).split(path.sep);
      // LM Studio stores weights under <author>/<repository>/, sometimes with nested quantizations.
      const parts = relative.slice(0, Math.min(root.groupDepth ?? 2, relative.length - 1));
      const key = parts.join("/") || path.basename(externalPath);
      const group = groups.get(key) ?? { name: key, path: path.join(externalPath, ...parts), sizeBytes: 0, gguf: false, mlx: false };
      group.sizeBytes += file.size;
      group.gguf ||= /\.gguf$/i.test(file.path);
      group.mlx ||= /\.safetensors$/i.test(file.path);
      groups.set(key, group);
    }
    result.externalLibraries.push({ providerId: root.providerId, name: root.name, path: externalPath, sizeBytes: files.reduce((sum, file) => sum + file.size, 0), models: [...groups.values()]
      .filter(group => group.gguf || group.mlx)
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .map(({ gguf, mlx, ...group }) => ({ ...group, format: gguf && mlx ? "Mixed" : gguf ? "GGUF" : "MLX" })) });
  }
  return result;
};
