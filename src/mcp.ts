import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AppSettingsStore } from "./app/AppSettingsStore";
import { RuntimeManager } from "./app/RuntimeManager";
import { config } from "./config/config";
import { SessionIndexStore } from "./session/SessionIndexStore";
import { registerLocalCognitiveMcpTools } from "./transports/mcp/tools";
import { Logger } from "./utils/Logger";
import { DataRootLock, DataRootLockedError } from "./runtime/db/DataRootLock";
import { appVersion } from "./utils/appVersion";
import { bridgeStdio } from "./server/mcpBridge";
import { controlSocketPathFor } from "./server/dataRoot";
import path from "node:path";
import { HostDatabase } from "./runtime/db/HostDatabase";
import { hostMigrations } from "./runtime/db/hostSchema";
import { UsageLedger } from "./usage/UsageLedger";
import { DiagnosticLog, setDiagnosticSink } from "./diagnostics/DiagnosticLog";

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
  let lock: DataRootLock;
  try { lock = await DataRootLock.acquire(config.appDataDir, "mcp-stdio", appVersion()); }
  catch (error) {
    if (!(error instanceof DataRootLockedError)) throw error;
    // A running server exposes its runtime over the control socket: attach instead of
    // starting a second runtime (and second model processes) on the same data.
    try { await bridgeStdio(controlSocketPathFor(config.appDataDir)); process.exit(0); }
    catch (bridgeError) {
      if (!["ENOENT", "ECONNREFUSED"].includes((bridgeError as NodeJS.ErrnoException).code ?? "")) throw bridgeError;
    }
    throw new Error(`${error.message} Run the MCP server with its own APP_DATA_DIR, SESSION_DIR, MEMORY_DIR and LOCAL_MODELS_DIR.`);
  }
  const appSettingsStore = new AppSettingsStore(config.appDataDir, config);
  const diagnosticLog = new DiagnosticLog(path.join(config.appDataDir, "diagnostics"));
  setDiagnosticSink(diagnosticLog);
  diagnosticLog.record("app.started", { runtimeKind: "mcp-stdio", previousShutdown: lock.previousShutdown });
  // Its model calls are recorded too, on this computer only: it knows no signed-in account.
  let database: HostDatabase | undefined;
  try { database = HostDatabase.open(path.join(config.appDataDir, "runtime", "host.db"), hostMigrations); }
  catch (error) { logger.warn("Usage is not recorded: host.db could not be opened", { message: error instanceof Error ? error.message : String(error) }); }
  const runtimeManager = new RuntimeManager(config, appSettingsStore, logger, {}, database ? { usage: new UsageLedger(database, () => ({}), logger) } : {});
  try { await runtimeManager.init(); }
  catch (error) { database?.close(); lock.release(); throw error; }

  const settings = await appSettingsStore.get();
  const sessionIndexStore = runtimeManager.getRuntime().sessionIndexStore;
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
  const dispose = async () => { await runtimeManager.dispose(); await server.close(); database?.close(); diagnosticLog.flush(); lock.release(); };
  process.once("SIGINT", () => { void dispose().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void dispose().finally(() => process.exit(0)); });
  process.stdin.once("end", () => { void dispose(); });
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
