import { AppConfig } from "../config/config";
import { ToolRegistry } from "../tools/ToolRegistry";
import { Logger } from "../utils/Logger";

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  entry: string;
  capabilities: string[];
  enabled?: boolean;
}

export interface PluginContext {
  config: AppConfig;
  logger: Logger;
  toolRegistry: ToolRegistry;
}

export interface SystemPlugin {
  register(context: PluginContext): Promise<void> | void;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  sourcePath: string;
}
