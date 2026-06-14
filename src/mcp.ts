import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AppSettingsStore } from "./app/AppSettingsStore";
import { RuntimeManager } from "./app/RuntimeManager";
import { config } from "./config/config";
import { SessionIndexStore } from "./session/SessionIndexStore";
import { registerLocalCognitiveMcpTools } from "./transports/mcp/tools";
import { Logger } from "./utils/Logger";

class StderrLogger extends Logger {
  override log(level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const payload = meta ? ` ${JSON.stringify(meta)}` : "";
    process.stderr.write(`[${timestamp}] [${level.toUpperCase()}] ${message}${payload}\n`);
  }
}

const bootstrapMcp = async (): Promise<void> => {
  if (!config.mcp.server.enabled) {
    throw new Error("MCP server is disabled. Set MCP_ENABLED=true or enable mcp.server in local-cognitive.config.json.");
  }

  const logger = new StderrLogger();
  const appSettingsStore = new AppSettingsStore(config.appDataDir, config);
  const runtimeManager = new RuntimeManager(config, appSettingsStore, logger);
  await runtimeManager.init();

  const settings = await appSettingsStore.get();
  const sessionIndexStore = new SessionIndexStore(config.appDataDir);
  const defaultSessionId =
    settings.mcp.server.defaultSessionId || config.mcp.server.defaultSessionId;
  const server = new McpServer({
    name: "local-cognitive-ai-system",
    version: "0.1.0"
  });

  registerLocalCognitiveMcpTools(server, {
    runtimeManager,
    sessionIndexStore,
    defaultSessionId
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP stdio transport started", {
    defaultSessionId
  });
};

void bootstrapMcp().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown_error";
  process.stderr.write(`[MCP] Bootstrap failed: ${message}\n`);
  process.exit(1);
});
