import express, { NextFunction, Request, Response } from "express";
import { createApiRouter } from "./api/routes";
import path from "path";
import { AppSettingsStore } from "./app/AppSettingsStore";
import { RuntimeManager } from "./app/RuntimeManager";
import { config } from "./config/config";
import { SessionIndexStore } from "./session/SessionIndexStore";
import { TelegramBotTransport } from "./transports/telegram/TelegramBotTransport";
import { Logger } from "./utils/Logger";

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

    app.listen(config.server.port, config.server.host, () => {
      logger.info("Local Cognitive AI System started", {
        host: config.server.host,
        port: config.server.port,
        memoryAdapter: config.memory.adapter,
        providers: runtime.providerDescriptors,
        ui: config.ui.publicDir
      });
    });
  }

  const telegramConfig = {
    enabled: appSettings.telegram.enabled,
    botToken: appSettings.telegram.botToken ?? config.telegram.botToken,
    pollTimeoutSec: appSettings.telegram.pollTimeoutSec
  };

  if (telegramConfig.enabled && telegramConfig.botToken) {
    const telegram = new TelegramBotTransport(
      {
        token: telegramConfig.botToken,
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
    logger.info("Telegram transport started", {
      pollTimeoutSec: telegramConfig.pollTimeoutSec
    });
  }
};

void bootstrap().catch((error) => {
  logger.error("Bootstrap failed", {
    message: error instanceof Error ? error.message : "unknown_error"
  });
  process.exit(1);
});
