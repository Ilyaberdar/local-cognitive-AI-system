import path from "path";
import type net from "net";
import { config } from "../config/config";
import { startBackend } from "../index";
import { DataRootLockedError } from "../runtime/db/DataRootLock";
import { resolveHeadlessVault } from "../security/headlessVault";
import { appVersion } from "../utils/appVersion";
import { Logger } from "../utils/Logger";
import { ControlError, ControlServer } from "./ControlServer";
import { controlSocketPathFor } from "./dataRoot";
import { drainBackend } from "./drain";
import { CliError, ExitCode } from "./exitCodes";
import type { InferenceSelection } from "./inference";
import { serveMcpSession } from "./mcpBridge";
import { startRemote } from "./remote";
import { createChatOperations, createChatScrubber, requireRemoteSession } from "../runtime/chatOperations";
import { UploadStore } from "../runtime/uploadStore";
import { createFolderOperations } from "../runtime/folderOperations";
import { HostFolders } from "../runtime/hostFolders";
import { createProjectAccess, createProjectOperations, PROJECT_ON_HOST } from "../runtime/projectOperations";
import { createSynthesisOperations } from "../runtime/synthesisOperations";
import { createEventStreamOperations } from "../runtime/eventStreams";
import { createModelOperations } from "../runtime/modelOperations";
import { createOrchestrationOperations, createWorkflowRunStreams } from "../runtime/orchestrationOperations";
import { createSettingsOperations } from "../runtime/settingsOperations";
import { publicError } from "../runtime/publicError";

/** Runs the server until it is drained or stopped. Imported only after the CLI has set the
 * environment: the configuration is read when its module loads. */
export const runDaemon = async (options: { drainTimeoutSec: number; inference: InferenceSelection; overriddenEnv: string[] }): Promise<number> => {
  const logger = new Logger();
  if (options.overriddenEnv.length) logger.warn("Environment values replaced by the data directory layout", { names: options.overriddenEnv });
  const vault = resolveHeadlessVault(config);
  if (vault.error) throw new CliError(vault.error, ExitCode.config);
  if (!vault.configured) logger.warn("Credential storage is not configured; account connections are unavailable. Run local-cognitive-server init.");
  if (options.inference.fallbackReason) logger.warn(options.inference.fallbackReason);

  let handle;
  try { handle = await startBackend(config, { vault: vault.vault }, { runtimeKind: "server" }); }
  catch (error) { if (error instanceof DataRootLockedError) throw new CliError(error.message, ExitCode.locked); throw error; }
  const backend = handle;
  const runtime = backend.runtimeManager.getRuntime();
  const settings = await backend.runtimeManager.getSettings();
  const mcpSessions = new Set<net.Socket>();
  let drained: ReturnType<typeof drainBackend> | undefined;
  let finish!: (code: number) => void;
  const exited = new Promise<number>(resolve => { finish = resolve; });

  const drain = (timeoutSec = options.drainTimeoutSec, onProgress?: (active: number) => void) =>
    drained ??= drainBackend(backend, { timeoutMs: timeoutSec * 1000, onProgress: active => { logger.info("Draining", { active }); onProgress?.(active); } });

  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    // A watchdog guarantees exit even if a dependency hangs during shutdown.
    setTimeout(() => process.exit(1), 45_000).unref();
    for (const socket of mcpSessions) socket.destroy();
    remote.close();
    await control.close();
    await backend.dispose();
    logger.info("Server stopped", { code });
    finish(code);
  };

  // The selected build is fixed at start; the active backend is what the runtime actually uses.
  const inference = () => {
    let active: { backend?: string; fallbackReason?: string } = {};
    try { active = backend.runtimeManager.getRuntime().localModelService.snapshot().runtime; } catch { /* Runtime not built. */ }
    return { preference: options.inference.preference, runtimeId: options.inference.runtimeId, backend: options.inference.backend,
      active: active.backend, fallbackReason: active.fallbackReason ?? options.inference.fallbackReason };
  };
  const host = backend.host!;
  const sessionIndexStore = backend.runtimeManager.getRuntime().sessionIndexStore;
  // Run outputs and events a device receives name no folder of this server.
  const orchestration = { runtimeManager: backend.runtimeManager, journalEpoch: () => host.journal.epoch, hostDirectories: [path.dirname(config.appDataDir)] };
  // The folders devices may browse and use: the server's own "Projects" and those its admin shared.
  const folders = new HostFolders(path.dirname(config.appDataDir));
  folders.ensureManaged();
  // A project a device may use lies in one of those folders, checked at every use.
  const projects = createProjectAccess({ runtimeManager: backend.runtimeManager, folders });
  // A device's turn in a project chat stops once the project is archived or its folder unshared.
  host.runService.setGuard(async sessionId => {
    const projectId = (await sessionIndexStore.get(sessionId))?.projectId;
    if (!projectId) return undefined;
    if (!await projects.visible(projectId)) return PROJECT_ON_HOST;
    return (await projects.usable(projectId)).reason;
  });
  // Attachments devices send for their next turn; expired ones are dropped even when none arrive.
  const uploads = new UploadStore();
  setInterval(() => uploads.sweep(), 60 * 60 * 1000).unref();
  const remote = await startRemote({ host, vault: vault.vault, vaultConfigured: vault.configured, env: process.env, logger,
    operations: {
      ...createChatOperations({ runtimeManager: backend.runtimeManager, sessionIndexStore, hostDirectories: orchestration.hostDirectories, uploads, projects,
        runService: host.runService, journal: host.journal, scopeOf: context => `remote:${context.accountId}:${context.deviceId}` }),
      ...createEventStreamOperations({ journal: host.journal, requireSession: sessionId => requireRemoteSession(sessionIndexStore, sessionId, projects),
        sources: [createWorkflowRunStreams(orchestration)], scrubSession: createChatScrubber(orchestration) }),
      ...createModelOperations({ runtimeManager: backend.runtimeManager }),
      ...createOrchestrationOperations({ ...orchestration, ledger: host.ledger, projects, folders,
        scopeOf: context => `remote:${context.accountId}:${context.deviceId}`, isDraining: () => backend.status().phase === "draining" }),
      ...createSettingsOperations({ runtimeManager: backend.runtimeManager, isDraining: () => backend.status().phase === "draining" }),
      ...createFolderOperations({ folders }),
      ...createSynthesisOperations({ runtimeManager: backend.runtimeManager, ledger: host.ledger, projects, hostDirectories: orchestration.hostDirectories,
        scopeOf: context => `remote:${context.accountId}:${context.deviceId}`, isDraining: () => backend.status().phase === "draining" }),
      ...createProjectOperations({ runtimeManager: backend.runtimeManager, folders, ledger: host.ledger,
        scopeOf: context => `remote:${context.accountId}:${context.deviceId}`, isDraining: () => backend.status().phase === "draining" })
    },
    status: () => {
      const { phase, activeWork, scheduler, telegram } = backend.status();
      let loadedModels: string[] = [];
      try { loadedModels = backend.runtimeManager.getRuntime().localModelService.snapshot().runtime.loadedModelIds ?? []; } catch { /* Runtime not built. */ }
      const { fallbackReason, ...current } = inference();
      return { version: appVersion(), phase, activeWork, scheduler, telegram, loadedModels,
        inference: { ...current, ...(fallbackReason ? { fallbackReason: publicError(fallbackReason) } : {}) } };
    } });
  const control = await ControlServer.listen(controlSocketPathFor(config.appDataDir), {
    status: () => ({ pid: process.pid, version: appVersion(), inference: inference(),
      remote: remote.agent ? remote.agent.status() : { state: "off", reason: remote.disabledReason },
      vault: { configured: vault.configured, keyIds: vault.keyIds }, mcpSessions: mcpSessions.size, ...backend.status() }),
    drain: async (timeoutSec, progress) => {
      const result = await drain(timeoutSec, progress);
      setImmediate(() => void stop(result.drained ? ExitCode.ok : ExitCode.failure));
      return result;
    },
    remote: async (op, request) => {
      const agent = remote.agent;
      if (!agent) throw new ControlError(remote.disabledReason ?? "Remote is off.", "remote_off");
      if (op === "connect-key") return agent.connectKey((request.ttlSec ?? 600) * 1000);
      if (op === "devices") return { devices: agent.devices() };
      if (op === "revoke-device") return { revoked: agent.revokeDevice(String(request.deviceId)) };
      agent.resetOwner();
      return { reset: true };
    },
    mcp: config.mcp.server.enabled ? socket => {
      if (drained) { socket.destroy(); return; }
      mcpSessions.add(socket);
      socket.once("close", () => mcpSessions.delete(socket));
      serveMcpSession(socket, { runtimeManager: backend.runtimeManager, sessionIndexStore: runtime.sessionIndexStore,
        defaultSessionId: settings.mcp.server.defaultSessionId || config.mcp.server.defaultSessionId });
    } : undefined
  }, logger);

  const onSignal = (signal: NodeJS.Signals) => {
    if (drained) { logger.warn("Second stop signal: stopping without waiting", { signal }); void stop(ExitCode.failure); return; }
    logger.info("Stop requested; finishing accepted work", { signal, timeoutSec: options.drainTimeoutSec });
    void drain().then(result => stop(result.drained ? ExitCode.ok : ExitCode.failure));
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, onSignal);
  logger.info("Server ready", { pid: process.pid, version: appVersion(), http: backend.status().http, inference: options.inference.backend, dataRoot: config.appDataDir });
  return exited;
};
