import fs from "fs/promises";
import { createRequire } from "module";
import path from "path";
import { pathToFileURL } from "url";
import { Logger } from "../utils/Logger";
import { LoadedPlugin, PluginContext, PluginManifest, SystemPlugin } from "./types";

const requireModule = createRequire(__filename);
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<{
  default?: SystemPlugin;
  plugin?: SystemPlugin;
  __esModule?: boolean;
}>;

type PluginModule = {
  default?: SystemPlugin | PluginModule;
  plugin?: SystemPlugin;
  __esModule?: boolean;
};

const isSystemPlugin = (candidate: unknown): candidate is SystemPlugin =>
  typeof candidate === "object" &&
  candidate !== null &&
  "register" in candidate &&
  typeof (candidate as { register?: unknown }).register === "function";

const resolvePluginExport = (moduleExport: PluginModule): SystemPlugin | undefined => {
  const nestedDefault =
    typeof moduleExport.default === "object" && moduleExport.default !== null
      ? (moduleExport.default as PluginModule)
      : undefined;
  const candidates = [
    moduleExport.plugin,
    moduleExport.default,
    nestedDefault?.plugin,
    nestedDefault?.default
  ];

  return candidates.find(isSystemPlugin);
};

export class PluginLoader {
  private loadedPlugins: LoadedPlugin[] = [];

  constructor(
    private readonly pluginsDir: string,
    private readonly context: PluginContext,
    private readonly logger: Logger
  ) {}

  async loadAll(): Promise<LoadedPlugin[]> {
    await fs.mkdir(this.pluginsDir, { recursive: true });
    const directories = await fs.readdir(this.pluginsDir, { withFileTypes: true });

    for (const entry of directories) {
      if (!entry.isDirectory()) {
        continue;
      }

      const pluginDir = path.join(this.pluginsDir, entry.name);
      const manifestPath = path.join(pluginDir, "plugin.json");

      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const manifest = JSON.parse(raw) as PluginManifest;
        const override = this.context.config.plugins.overrides[manifest.name];

        if (manifest.enabled === false || override?.enabled === false) {
          continue;
        }

        const modulePath = await this.resolveEntryPath(pluginDir, manifest.entry);
        const imported = await this.loadPluginModule(modulePath);
        const plugin = resolvePluginExport(imported);

        if (!plugin) {
          throw new Error(`Plugin module ${modulePath} does not export a plugin`);
        }

        await plugin.register(this.context);
        this.loadedPlugins.push({
          manifest,
          sourcePath: pluginDir
        });
      } catch (error) {
        this.logger.warn("Failed to load plugin", {
          pluginDir,
          error: error instanceof Error ? error.message : "unknown_error"
        });
      }
    }

    return this.loadedPlugins;
  }

  list(): LoadedPlugin[] {
    return this.loadedPlugins;
  }

  private async resolveEntryPath(pluginDir: string, entry: string): Promise<string> {
    const sourceEntry = path.resolve(pluginDir, entry);
    const isDistRuntime = __filename.includes(`${path.sep}dist${path.sep}`);
    const runtimePaths: string[] = [];

    if (sourceEntry.endsWith(".ts")) {
      const relative = path.relative(process.cwd(), sourceEntry).replace(/\.ts$/, ".js");
      const distPath = path.join(process.cwd(), "dist", relative);
      runtimePaths.push(isDistRuntime ? distPath : sourceEntry);
      runtimePaths.push(isDistRuntime ? sourceEntry : distPath);
    }

    if (sourceEntry.endsWith(".js")) {
      const relative = path.relative(process.cwd(), sourceEntry);
      const distPath = path.join(process.cwd(), "dist", relative);
      runtimePaths.push(isDistRuntime ? distPath : sourceEntry);
      runtimePaths.push(isDistRuntime ? sourceEntry : distPath);
    }

    if (!sourceEntry.endsWith(".ts") && !sourceEntry.endsWith(".js")) {
      runtimePaths.push(sourceEntry);
    }

    for (const runtimePath of runtimePaths) {
      try {
        await fs.access(runtimePath);
        return runtimePath;
      } catch {
        continue;
      }
    }

    throw new Error(`Plugin entry not found for ${entry}`);
  }

  private async loadPluginModule(modulePath: string): Promise<PluginModule> {
    if (modulePath.endsWith(".ts")) {
      return dynamicImport(pathToFileURL(modulePath).href);
    }

    return requireModule(modulePath) as PluginModule;
  }
}
