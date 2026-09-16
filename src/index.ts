import express, { NextFunction, Request, Response } from "express";
import { createApiRouter } from "./api/routes";
import path from "path";
import { AppSettingsStore } from "./app/AppSettingsStore";
import { RuntimeManager } from "./app/RuntimeManager";
import { AppConfig, config as defaultConfig } from "./config/config";
import { Server } from "node:http";
import { LocalModelError } from "./local/types";
import { AttachmentError } from "./utils/attachments";
import { SessionIndexStore } from "./session/SessionIndexStore";
import { ScheduleRunner } from "./schedules/ScheduleRunner";
import { TelegramBotTransport } from "./transports/telegram/TelegramBotTransport";
import { Logger } from "./utils/Logger";
import { formatStartupSummary } from "./utils/startupSummary";

const logger = new Logger();

export interface BackendHandle {
  runtimeManager: RuntimeManager;
  server?: Server;
  dispose(): Promise<void>;
}

export const startBackend = async (config: AppConfig = defaultConfig): Promise<BackendHandle> => {
  const appSettingsStore = new AppSettingsStore(config.appDataDir, config);
  const runtimeManager = new RuntimeManager(config, appSettingsStore, logger);
  const runtime = await runtimeManager.init();
  const appSettings = await appSettingsStore.get();
  const sessionIndexStore = new SessionIndexStore(config.appDataDir);

  let server: Server | undefined;
  let scheduler: ScheduleRunner | undefined;
  let telegram: TelegramBotTransport | undefined;
  let disposing: Promise<void> | undefined;
  const dispose = (): Promise<void> => disposing ??= (async () => {
    scheduler?.stop();
    telegram?.stop();
    await runtimeManager.dispose();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  })();

  try {
  if (config.server.enabled) {
    const app = express();
    app.use(express.json({ limit: "8mb" }));
    app.use("/", createApiRouter(runtimeManager, sessionIndexStore));
    app.use(express.static(config.ui.publicDir));
    app.get("/", (_req, res) => {
      res.sendFile(path.join(config.ui.publicDir, "index.html"));
    });
    app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error("Unhandled request error", { message: error.message });
      const known = error instanceof LocalModelError || error instanceof AttachmentError;
      res.status(known ? error.statusCode : 500).json({
        error: known ? error.message : "Internal server error",
        message: error.message
      });
    });

    await new Promise<void>((resolve, reject) => {
      server = app.listen(config.server.port, config.server.host, () => {
        resolve();
      });
      server.once("error", reject);
    });

    scheduler = new ScheduleRunner(
      () => runtimeManager.getRuntime().scheduleService,
      logger
    );
    scheduler.start();
  }

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
  return { runtimeManager, server, dispose };
  } catch (error) { await dispose(); throw error; }
};

if (require.main === module) void startBackend().then((backend) => {
  const stop = () => { void backend.dispose().then(() => process.exit(0), () => process.exit(1)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}).catch((error) => {
  logger.error("Bootstrap failed", {
    message: error instanceof Error ? error.message : "unknown_error"
  });
  process.exit(1);
});
