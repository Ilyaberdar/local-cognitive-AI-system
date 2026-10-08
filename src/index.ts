import express, { NextFunction, Request, Response } from "express";
import { createApiRouter } from "./api/routes";
import path from "path";
import { AppSettingsStore } from "./app/AppSettingsStore";
import { RuntimeManager, IntegrationRuntimeOptions } from "./app/RuntimeManager";
import { AppConfig, config as defaultConfig } from "./config/config";
import { Server } from "node:http";
import { LocalModelError } from "./local/types";
import { SettingsValidationError } from "./app/settingsValidation";
import { AttachmentError } from "./utils/attachments";
import { SessionIndexStore } from "./session/SessionIndexStore";
import { ScheduleRunner } from "./schedules/ScheduleRunner";
import { TelegramBotTransport } from "./transports/telegram/TelegramBotTransport";
import { Logger } from "./utils/Logger";
import { formatStartupSummary } from "./utils/startupSummary";
import { DataRootLock, RuntimeKind } from "./runtime/db/DataRootLock";
import { appVersion } from "./utils/appVersion";
import { createDrainGate } from "./api/drainGate";
import { processRunRegistry } from "./api/ProcessRunRegistry";
import { WorkflowRunner } from "./workflows/WorkflowRunner";

const logger = new Logger();

export interface ActiveWork { processRuns: number; workflowRuns: number; inferenceBusy: boolean; inferenceQueued: number; scheduleTick: boolean; total: number }

export interface BackendStatus {
  phase: "running" | "draining";
  http?: { host: string; port: number };
  ui: boolean;
  scheduler: boolean;
  telegram: boolean;
  activeWork: ActiveWork;
}

export interface BackendHandle {
  runtimeManager: RuntimeManager;
  server?: Server;
  status(): BackendStatus;
  activeWork(): ActiveWork;
  /** Stops the scheduler and Telegram and rejects new HTTP work; accepted work continues. */
  stopAcceptingWork(): void;
  /** Cancels running chat requests after the drain deadline. */
  interruptActiveWork(): number;
  dispose(): Promise<void>;
}

export interface BackendOptions { runtimeKind?: RuntimeKind }

export const startBackend = async (config: AppConfig = defaultConfig, integrations: IntegrationRuntimeOptions = {}, options: BackendOptions = {}): Promise<BackendHandle> => {
  // One runtime owns a data directory; a second backend or MCP server on it is refused.
  // The short wait covers restarts (tsx watch, app relaunch) of the previous owner.
  const lock = await DataRootLock.acquire(config.appDataDir, options.runtimeKind ?? "server", appVersion(), { waitMs: 3000 });
  if (lock.previousShutdown === "unclean") logger.warn("The previous runtime did not shut down cleanly", { kind: lock.previousOwner?.kind });
  const appSettingsStore = new AppSettingsStore(config.appDataDir, config);
  const runtimeManager = new RuntimeManager(config, appSettingsStore, logger, {}, integrations);
  let runtime;
  try { runtime = await runtimeManager.init(); }
  catch (error) { lock.release(); throw error; }
  const appSettings = await appSettingsStore.get();
  const sessionIndexStore = runtime.sessionIndexStore;

  let server: Server | undefined;
  let scheduler: ScheduleRunner | undefined;
  let telegram: TelegramBotTransport | undefined;
  let disposing: Promise<void> | undefined;
  let draining = false;
  const dispose = (): Promise<void> => disposing ??= (async () => {
    scheduler?.stop();
    telegram?.stop();
    // Stop listening before the runtime goes away, then drop remaining connections.
    const closed = server ? new Promise<void>((resolve) => server!.close(() => resolve())) : Promise.resolve();
    await runtimeManager.dispose();
    server?.closeAllConnections();
    await closed;
    lock.release();
  })();
  const activeWork = (): ActiveWork => {
    let inference = { busy: false, queued: 0 };
    try { inference = runtimeManager.getRuntime().localModelService.activity(); } catch { /* Runtime not built. */ }
    const work = { processRuns: processRunRegistry.activeCount(), workflowRuns: WorkflowRunner.activeRunIds().length, inferenceBusy: inference.busy,
      inferenceQueued: inference.queued, scheduleTick: scheduler?.busy ?? false };
    return { ...work, total: work.processRuns + work.workflowRuns + (work.inferenceBusy ? 1 : 0) + work.inferenceQueued + (work.scheduleTick ? 1 : 0) };
  };

  try {
  if (config.server.enabled) {
    const app = express();
    app.use(express.json({ limit: "8mb" }));
    app.use(createDrainGate(() => draining));
    app.use("/", createApiRouter(runtimeManager, sessionIndexStore));
    // The headless server has no UI: clients bring their own (desktop app).
    if (config.ui.serve !== false) {
      app.use(express.static(config.ui.publicDir));
      app.get("/", (_req, res) => {
        res.sendFile(path.join(config.ui.publicDir, "index.html"));
      });
    }
    app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error("Unhandled request error", { message: error.message });
      const known = error instanceof LocalModelError || error instanceof AttachmentError || error instanceof SettingsValidationError;
      const statusCode = "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
      res.status(known ? error.statusCode : statusCode).json({
        error: known || statusCode < 500 ? error.message : "Internal server error",
        message: error.message
      });
    });

    await new Promise<void>((resolve, reject) => {
      server = app.listen(config.server.port, config.server.host, () => {
        resolve();
      });
      server.once("error", reject);
    });
  }

  // Schedules run with or without the HTTP API.
  scheduler = new ScheduleRunner(
    () => runtimeManager.getRuntime().scheduleService,
    logger
  );
  scheduler.start();

  const telegramConfig = {
    enabled: appSettings.telegram.enabled,
    botToken: appSettings.telegram.botToken ?? config.telegram.botToken,
    ownerUserIds: appSettings.telegram.ownerUserIds,
    pollTimeoutSec: appSettings.telegram.pollTimeoutSec
  };

  if (telegramConfig.enabled && telegramConfig.botToken && telegramConfig.ownerUserIds.length > 0) {
    telegram = new TelegramBotTransport(
      {
        token: telegramConfig.botToken,
        ownerUserIds: telegramConfig.ownerUserIds,
        pollTimeoutSec: telegramConfig.pollTimeoutSec
      },
      runtime.engine,
      runtime.formatter,
      runtime.sessionSettingsStore,
      runtime.modelCatalog,
      runtime.localModelManager,
      runtime.providerDescriptors,
      logger,
      () => runtimeManager.getRuntime()
    );

    telegram.start();
  } else if (telegramConfig.enabled) {
    logger.warn("Telegram transport was not started because an owner user ID is required", {
      hasToken: Boolean(telegramConfig.botToken)
    });
  }

  logger.info(
    formatStartupSummary({
      config,
      settings: appSettings,
      runtime,
      telegram: {
        enabled: telegramConfig.enabled,
        configured: Boolean(telegramConfig.botToken),
        pollTimeoutSec: telegramConfig.pollTimeoutSec
      }
    })
  );
  const status = (): BackendStatus => {
    const address = server?.address();
    return { phase: draining ? "draining" : "running", http: address && typeof address === "object" ? { host: address.address, port: address.port } : undefined,
      ui: Boolean(server) && config.ui.serve !== false, scheduler: scheduler?.running ?? false, telegram: Boolean(telegram), activeWork: activeWork() };
  };
  const stopAcceptingWork = () => { draining = true; scheduler?.stop(); telegram?.stop(); };
  return { runtimeManager, server, status, activeWork, stopAcceptingWork, interruptActiveWork: () => processRunRegistry.cancelAll(), dispose };
  } catch (error) { await dispose(); throw error; }
};

if (require.main === module) void (async () => {
  // Plain `npm start` (development headless run): the server CLI is local-cognitive-server.
  const { resolveHeadlessVault } = await import("./security/headlessVault");
  const vault = resolveHeadlessVault(defaultConfig);
  if (vault.error) throw new Error(vault.error);
  if (!vault.configured) logger.warn("Credential storage is not configured; account connections are unavailable.");
  return startBackend(defaultConfig, { vault: vault.vault });
})().then((backend) => {
  const stop = () => { void backend.dispose().then(() => process.exit(0), () => process.exit(1)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}).catch((error) => {
  logger.error("Bootstrap failed", {
    message: error instanceof Error ? error.message : "unknown_error"
  });
  process.exit(1);
});
