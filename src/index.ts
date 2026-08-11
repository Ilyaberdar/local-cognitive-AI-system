import express, { NextFunction, Request, Response } from "express";
import { createApiRouter } from "./api/routes";
import path from "path";
import { AppSettingsStore } from "./app/AppSettingsStore";
import { RuntimeManager } from "./app/RuntimeManager";
import { config } from "./config/config";
import { SessionIndexStore } from "./session/SessionIndexStore";
import { ScheduleRunner } from "./schedules/ScheduleRunner";
import { TelegramBotTransport } from "./transports/telegram/TelegramBotTransport";
import { Logger } from "./utils/Logger";
import { formatStartupSummary } from "./utils/startupSummary";

const logger = new Logger();

const bootstrap = async (): Promise<void> => {
  const appSettingsStore = new AppSettingsStore(config.appDataDir, config);
  const runtimeManager = new RuntimeManager(config, appSettingsStore, logger);
  const runtime = await runtimeManager.init();
  const appSettings = await appSettingsStore.get();
  const sessionIndexStore = new SessionIndexStore(config.appDataDir);

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
      res.status(500).json({
        error: "Internal server error",
        message: error.message
      });
    });

    await new Promise<void>((resolve, reject) => {
      const server = app.listen(config.server.port, config.server.host, () => {
        resolve();
      });
      server.once("error", reject);
    });

    new ScheduleRunner(
      () => runtimeManager.getRuntime().scheduleService,
      logger
    ).start();
  }

  const telegramConfig = {
    enabled: appSettings.telegram.enabled,
    botToken: appSettings.telegram.botToken ?? config.telegram.botToken,
    ownerUserIds: appSettings.telegram.ownerUserIds,
    pollTimeoutSec: appSettings.telegram.pollTimeoutSec
  };

  if (telegramConfig.enabled && telegramConfig.botToken && telegramConfig.ownerUserIds.length > 0) {
    const telegram = new TelegramBotTransport(
      {
        token: telegramConfig.botToken,
        ownerUserIds: telegramConfig.ownerUserIds,
        pollTimeoutSec: telegramConfig.pollTimeoutSec
      },
      runtime.engine,
      runtime.formatter,
      runtime.sessionSettingsStore,
      runtime.modelCatalog,
      runtime.lmStudioManager,
      runtime.providerDescriptors,
      logger
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
};

void bootstrap().catch((error) => {
  logger.error("Bootstrap failed", {
    message: error instanceof Error ? error.message : "unknown_error"
  });
  process.exit(1);
});
