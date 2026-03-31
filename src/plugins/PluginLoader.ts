import fs from "fs/promises";
import path from "path";
import { Logger } from "../utils/Logger";
import { LoadedPlugin, PluginContext, PluginManifest, SystemPlugin } from "./types";

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
        const imported = (await import(modulePath)) as {
          default?: SystemPlugin;
          plugin?: SystemPlugin;
        };
        const plugin = imported.default ?? imported.plugin;

        if (!plugin) {
          throw new Error(`Plugin module ${modulePath} does not export a plugin`);
        }

        await plugin.register(this.context);
        this.loadedPlugins.push({
          manifest,
          sourcePath: pluginDir
        });
        this.logger.info("Plugin loaded", { name: manifest.name, version: manifest.version });
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
}
