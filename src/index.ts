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
import { HostDatabase } from "./runtime/db/HostDatabase";
import { hostMigrations } from "./runtime/db/hostSchema";
import { RemoteHostStore } from "./remote/host/RemoteHostStore";
import { UsageLedger } from "./usage/UsageLedger";
import { UsageOutbox } from "./usage/UsageOutbox";
import { DiagnosticLog, setDiagnosticSink } from "./diagnostics/DiagnosticLog";
import { errorCategory } from "./diagnostics/errorCategory";
import { CommandLedger } from "./runtime/CommandLedger";
import { EventJournal } from "./runtime/EventJournal";
import { createChatScrubber, withoutAttachmentData } from "./runtime/chatOperations";
import type { ChatAttachment } from "./types";
import { RunService } from "./runtime/RunService";
import { processRuntimeInput } from "./transports/shared/runtimeActions";
import { loadSessionMessages } from "./conversations/sessionHistory";

const logger = new Logger();

export interface ActiveWork { processRuns: number; workflowRuns: number; inferenceBusy: boolean; inferenceQueued: number; scheduleTick: boolean; total: number;
  /** Durable chat turns (headless server). */
  chatRuns?: number;
  /** Synthesis runs: a drain waits for them too. */
  synthesisRuns?: number }

/** The host's durable store and the services on it (headless server only in R4). */
export interface HostServices { database: HostDatabase; journal: EventJournal; runService: RunService; ledger: CommandLedger }

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
  host?: HostServices;
  /** This runtime's usage ledger; absent when host.db could not be opened on a desktop. */
  usage?: UsageLedger;
  /** Sends the ledger to the Cloud once a sender is set (the account's, or the server's). */
  usageOutbox?: UsageOutbox;
  /** The technical log: event codes only (diagnostics, bug reports). */
  diagnosticLog: DiagnosticLog;
}

export interface BackendOptions {
  runtimeKind?: RuntimeKind;
  /** The account signed in to this computer (desktop); a server's account is its owner. */
  usageAccount?: () => string | undefined;
}

export const startBackend = async (config: AppConfig = defaultConfig, integrations: IntegrationRuntimeOptions = {}, options: BackendOptions = {}): Promise<BackendHandle> => {
  // One runtime owns a data directory; a second backend or MCP server on it is refused.
  // The short wait covers restarts (tsx watch, app relaunch) of the previous owner.
  const lock = await DataRootLock.acquire(config.appDataDir, options.runtimeKind ?? "server", appVersion(), { waitMs: 3000 });
  if (lock.previousShutdown === "unclean") logger.warn("The previous runtime did not shut down cleanly", { kind: lock.previousOwner?.kind });
  const diagnosticLog = new DiagnosticLog(path.join(config.appDataDir, "diagnostics"));
  setDiagnosticSink(diagnosticLog);
  diagnosticLog.record("app.started", { runtimeKind: options.runtimeKind ?? "server", previousShutdown: lock.previousShutdown });
  const failed = (error: unknown) => { diagnosticLog.record("startup.failed", { category: errorCategory(error) }); diagnosticLog.flush(); };
  const appSettingsStore = new AppSettingsStore(config.appDataDir, config);
  // host.db: the server's durable runs, and every runtime's usage ledger.
  let database: HostDatabase | undefined;
  try { database = HostDatabase.open(path.join(config.appDataDir, "runtime", "host.db"), hostMigrations); }
  catch (error) {
    if (options.runtimeKind === "server") { failed(error); lock.release(); throw error; }
    logger.warn("Usage is not recorded: host.db could not be opened", { message: error instanceof Error ? error.message : String(error) });
  }
  const remoteStore = database && options.runtimeKind === "server" ? new RemoteHostStore(database) : undefined;
  const usage = database ? new UsageLedger(database, () => remoteStore
    ? { accountId: remoteStore.owner(), hostId: remoteStore.hostId() }
    : { accountId: options.usageAccount?.() }, logger) : undefined;
  const usageOutbox = usage ? new UsageOutbox(usage, logger) : undefined;
  const runtimeManager = new RuntimeManager(config, appSettingsStore, logger, {}, { ...integrations, ...(usage ? { usage } : {}) });
  let runtime;
  try { runtime = await runtimeManager.init(); }
  catch (error) { failed(error); usageOutbox?.stop(); database?.close(); lock.release(); throw error; }
  const appSettings = await appSettingsStore.get();
  const sessionIndexStore = runtime.sessionIndexStore;
  // The server keeps chat turns durable across disconnects and restarts (R4); the desktop does not yet.
  let host: HostServices | undefined;
  if (options.runtimeKind === "server") {
    try { host = openHostServices(database!, config, runtimeManager, sessionIndexStore); }
    catch (error) { failed(error); await runtimeManager.dispose(); usageOutbox?.stop(); database?.close(); lock.release(); throw error; }
  }

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
    await host?.runService.dispose();
    await runtimeManager.dispose();
    usageOutbox?.stop();
    database?.close();
    diagnosticLog.flush();
    server?.closeAllConnections();
    await closed;
    lock.release();
  })();
  const activeWork = (): ActiveWork => {
    let inference = { busy: false, queued: 0 }, synthesisRuns = 0;
    try { inference = runtimeManager.getRuntime().localModelService.activity(); } catch { /* Runtime not built. */ }
    try { synthesisRuns = runtimeManager.getRuntime().synthesis.activeCount(); } catch { /* Runtime not built. */ }
    const work = { processRuns: processRunRegistry.activeCount(), workflowRuns: WorkflowRunner.activeRunIds().length, inferenceBusy: inference.busy,
      inferenceQueued: inference.queued, scheduleTick: scheduler?.busy ?? false, chatRuns: host?.runService.activeCount() ?? 0, synthesisRuns };
    return { ...work, total: work.processRuns + work.workflowRuns + (work.inferenceBusy ? 1 : 0) + work.inferenceQueued + (work.scheduleTick ? 1 : 0) + work.chatRuns + synthesisRuns };
  };

  try {
  if (config.server.enabled) {
    const app = express();
    app.use(express.json({ limit: "8mb" }));
    app.use(createDrainGate(() => draining));
    app.use("/", createApiRouter(runtimeManager, sessionIndexStore, host ? {
      forgetSession: sessionId => host!.runService.forgetSession(sessionId), forgotSession: (sessionId, deleted) => host!.runService.forgotSession(sessionId, deleted) } : undefined));
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
  const stopAcceptingWork = () => { draining = true; scheduler?.stop(); telegram?.stop(); host?.runService.stopAccepting();
    try { runtimeManager.getRuntime().synthesis.stopAccepting(); } catch { /* Runtime not built. */ } };
  const interruptActiveWork = () => processRunRegistry.cancelAll() + (host?.runService.interruptAll() ?? 0);
  return { runtimeManager, server, status, activeWork, stopAcceptingWork, interruptActiveWork, dispose, ...(host ? { host } : {}), ...(usage ? { usage } : {}), ...(usageOutbox ? { usageOutbox } : {}), diagnosticLog };
  } catch (error) { failed(error); await dispose(); throw error; }
};

/** What the engine is told about a paired device's turn: it is a device's (never full access), its
 * attachments, and no plugins of this host (plugins for devices come later; without a selection the
 * engine would offer every enabled plugin, and `@plugin` in the message would choose one). */
export const deviceRunMetadata = (run: { runId: string; attachments?: ChatAttachment[] }) => ({
  chatRunId: run.runId, deviceRun: true, pluginIds: [] as string[], ...(run.attachments?.length ? { attachments: run.attachments } : {})
});

/** Interrupts turns a crash left running, and wires chat runs to the shared engine. */
const openHostServices = (database: HostDatabase, config: AppConfig, runtimeManager: RuntimeManager, sessionIndexStore: SessionIndexStore): HostServices => {
  const journal = new EventJournal(database);
  const runService = new RunService({
    host: database, journal, logger,
    sessionExists: async sessionId => Boolean(await sessionIndexStore.get(sessionId)),
    legacyBusy: sessionId => processRunRegistry.hasActiveSession(sessionId),
    // Events are written as a device may see them: no folder of this server.
    scrubber: createChatScrubber({ runtimeManager, hostDirectories: [path.dirname(config.appDataDir)] }),
    // The same entry, channel and profile as the local chat: one history per session.
    execute: async (run, hooks) => {
      const settings = await runtimeManager.getSettings();
      // The first message names a new chat; a chat that has a name (renamed on a device) keeps it.
      const title = (await sessionIndexStore.get(run.sessionId))?.title;
      const sessionTitle = title && title !== "New chat" ? title : undefined;
      const result = await processRuntimeInput(runtimeManager, sessionIndexStore, { input: run.input, sessionId: run.sessionId, userId: settings.memory.localProfileId, sessionTitle,
        metadata: deviceRunMetadata(run), signal: hooks.signal, onProgress: hooks.onProgress, requestApproval: hooks.requestApproval }, "http");
      return { ...(result.result.error ? { error: result.result.error } : {}) };
    },
    // The finished turn as a device receives it: attachment contents stay on the host.
    completedTurn: async (sessionId, runId) => (await loadSessionMessages(runtimeManager, sessionId, 4)).messages.filter(message => message.runId === runId).map(withoutAttachmentData)
  });
  const recovered = runService.recover();
  if (recovered) logger.warn("Chat turns were interrupted by the previous shutdown", { count: recovered });
  journal.compact();
  setInterval(() => { try { journal.compact(); } catch (error) { logger.warn("Event journal compaction failed", { message: error instanceof Error ? error.message : String(error) }); } }, 3_600_000).unref();
  return { database, journal, runService, ledger: new CommandLedger(database) };
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
