import { AppRuntime } from "../app/buildRuntime";
import { AppConfig } from "../config/config";
import { AppSettings } from "../types";

interface StartupSummaryOptions {
  config: AppConfig;
  settings: AppSettings;
  runtime: AppRuntime;
  telegram: {
    enabled: boolean;
    configured: boolean;
    pollTimeoutSec: number;
  };
}

const label = (value: string, width = 14): string => value.padEnd(width, " ");

const state = (enabled: boolean, configured = true): string => {
  if (!enabled) {
    return "off";
  }

  return configured ? "on" : "needs config";
};

const line = (name: string, value: string): string => `  ${label(name)} ${value}`;

export const formatStartupSummary = ({
  config,
  settings,
  runtime,
  telegram
}: StartupSummaryOptions): string => {
  const baseUrl = `http://${config.server.host}:${config.server.port}`;
  const providers = runtime.providerDescriptors.map((provider) =>
    line(
      `${provider.configured ? "[ok]" : "[--]"} ${provider.id}`,
      `${provider.name} -> ${provider.defaultModel}`
    )
  );
  const plugins = runtime.plugins.length
    ? runtime.plugins.map((plugin) =>
        line("[ok] " + plugin.manifest.name, `${plugin.manifest.version} (${plugin.manifest.capabilities.join(", ") || "no capabilities"})`)
      )
    : [line("[--] plugins", "none loaded")];

  return [
    "",
    "Local Cognitive AI System",
    "=========================",
    line("HTTP API", config.server.enabled ? baseUrl : "off"),
    line("Web UI", config.server.enabled ? baseUrl : "off"),
    line("Health", config.server.enabled ? `${baseUrl}/health` : "off"),
    line("Default LLM", settings.llm.defaultProvider),
    line("Memory", `${config.memory.adapter} @ ${config.memory.baseDir}`),
    line("Sessions", config.sessions.baseDir),
    line("App data", config.appDataDir),
    line(
      "MCP stdio",
      `${state(settings.mcp.server.enabled)}; command: npm run --silent mcp:stdio; session: ${settings.mcp.server.defaultSessionId}`
    ),
    line(
      "Telegram",
      `${state(telegram.enabled, telegram.configured)}; poll timeout: ${telegram.pollTimeoutSec}s`
    ),
    "",
    "Providers",
    "---------",
    ...providers,
    "",
    "Plugins",
    "-------",
    ...plugins,
    "",
    "Ready",
    ""
  ].join("\n");
};
