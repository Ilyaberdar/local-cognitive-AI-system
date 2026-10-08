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
import { createChatOperations } from "../runtime/chatOperations";

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
  const remote = await startRemote({ host, vault: vault.vault, vaultConfigured: vault.configured, env: process.env, logger,
    operations: createChatOperations({ runtimeManager: backend.runtimeManager, sessionIndexStore: backend.runtimeManager.getRuntime().sessionIndexStore,
      runService: host.runService, journal: host.journal, scopeOf: context => `remote:${context.accountId}:${context.deviceId}` }),
    status: () => {
      const { phase, activeWork, scheduler, telegram } = backend.status();
      let loadedModels: string[] = [];
      try { loadedModels = backend.runtimeManager.getRuntime().localModelService.snapshot().runtime.loadedModelIds ?? []; } catch { /* Runtime not built. */ }
      return { version: appVersion(), phase, activeWork, scheduler, telegram, inference: inference(), loadedModels };
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
