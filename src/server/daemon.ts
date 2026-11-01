import os from "os";
import path from "path";
import type net from "net";
import { config } from "../config/config";
import { startBackend } from "../index";
import { apiTokenFilePath, createApiToken } from "../api/localApiAuth";
import { HostDatabaseError } from "../runtime/db/HostDatabase";
import { consentFilePath, liveConsent } from "../diagnostics/consentFile";
import { flushServerErrorReports, startServerErrorReports } from "../diagnostics/serverSentry";
import { UpdateChecker } from "../update/updateChecker";
import { RELEASE_KEYS } from "../update/releaseKeys";
import { DEFAULT_MANIFEST_URL } from "./updateCommand";
import { DataRootLockedError } from "../runtime/db/DataRootLock";
import { resolveHeadlessVault } from "../security/headlessVault";
import { appVersion } from "../utils/appVersion";
import { Logger } from "../utils/Logger";
import { createCloudModelsControl } from "./cloudModels";
import { createWebTargetsControl } from "./webTargets";
import { ControlError, ControlServer } from "./ControlServer";
import { controlSocketPathFor } from "./dataRoot";
import { drainBackend } from "./drain";
import { CliError, ExitCode } from "./exitCodes";
import type { InferenceSelection } from "./inference";
import { serveMcpSession } from "./mcpBridge";
import { startRemote } from "./remote";
import { createHostOperations } from "../remote/host/hostRuntime";
import { publicError } from "../runtime/publicError";
import { systemMetricsSnapshot } from "../local/systemMetrics";

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
  // A new key for the loopback HTTP API at every start, in a file only the server's user can read
  // (`local-cognitive-server api-token`); removed when the server stops.
  try { handle = await startBackend(config, { vault: vault.vault }, { runtimeKind: "server", apiToken: createApiToken(), apiTokenFile: apiTokenFilePath(config.appDataDir) }); }
  catch (error) {
    if (error instanceof DataRootLockedError) throw new CliError(error.message, ExitCode.locked);
    // Data of a newer version (after going back to an older one): exit 78, so systemd stops restarting.
    if (error instanceof HostDatabaseError && error.code === "schema_too_new") {
      throw new CliError(`${error.message} Install that newer version again, or restore the backup made before updating to it.`, ExitCode.config);
    }
    throw error;
  }
  const backend = handle;
  // Newer releases, looked for once a day (never installed from here: `update` runs as root).
  const updates = new UpdateChecker({ manifestUrl: process.env.LOCAL_COGNITIVE_UPDATE_URL || DEFAULT_MANIFEST_URL, keys: RELEASE_KEYS, currentVersion: appVersion(),
    enabled: process.env.LOCAL_COGNITIVE_UPDATE_CHECK !== "off" });
  updates.start();
  // Error reports only while the owner's consent is on (error-reports on, or Settings through Remote).
  const consentFile = consentFilePath(config.appDataDir);
  startServerErrorReports({ consent: liveConsent(consentFile), diagnosticLog: backend.diagnosticLog });
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
    updates.stop();
    for (const socket of mcpSessions) socket.destroy();
    remote.close();
    await control.close();
    await backend.dispose();
    await flushServerErrorReports().catch(() => false);
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
  // What devices may do here, the same set a desktop that hosts offers.
  const { operations } = createHostOperations({ backend, dataRoot: path.dirname(config.appDataDir), consentFile });
  const remote = await startRemote({ host: backend.host!, vault: vault.vault, vaultConfigured: vault.configured, env: process.env, logger, usage: backend.usageOutbox, operations,
    status: () => {
      const { phase, activeWork, scheduler, telegram } = backend.status();
      let loadedModels: string[] = [];
      try { loadedModels = backend.runtimeManager.getRuntime().localModelService.snapshot().runtime.loadedModelIds ?? []; } catch { /* Runtime not built. */ }
      const { fallbackReason, ...current } = inference();
      return { version: appVersion(), update: updates.status(), phase, activeWork, scheduler, telegram, loadedModels,
        inference: { ...current, ...(fallbackReason ? { fallbackReason: publicError(fallbackReason) } : {}) } };
    } });
  const startedAt = new Date().toISOString();
  const controlStatus = () => ({ pid: process.pid, version: appVersion(), update: updates.status(), inference: inference(),
    remote: remote.agent ? remote.agent.status() : { state: "off", reason: remote.disabledReason },
    vault: { configured: vault.configured, keyIds: vault.keyIds }, mcpSessions: mcpSessions.size, ...backend.status() });
  const control = await ControlServer.listen(controlSocketPathFor(config.appDataDir), {
    status: controlStatus,
    // The console's live view (root on this machine only): names, never paths or keys.
    overview: () => {
      let models: Array<{ id: string; name: string; status: string; placement?: string }> = [];
      let gpus: Parameters<typeof systemMetricsSnapshot>[0];
      try {
        const local = backend.runtimeManager.getRuntime().localModelService;
        const snapshot = local.snapshot();
        models = (snapshot.runtime.instances ?? []).filter(instance => instance.modelId).map(instance => ({ id: instance.modelId!,
          name: snapshot.models.find(model => model.id === instance.modelId)?.displayName ?? instance.modelId!, status: instance.status,
          ...(instance.placement?.label ? { placement: instance.placement.label } : {}) }));
        gpus = local.gpuMetrics();
      } catch { /* The runtime is not built yet. */ }
      return { ...controlStatus(), startedAt, hostName: os.hostname(), models, metrics: systemMetricsSnapshot(gpus), connected: remote.agent?.connectedDevices() ?? [] };
    },
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
      if (op === "invitation") return agent.invitation(String(request.invitationId));
      if (op === "revoke-device") return { revoked: agent.revokeDevice(String(request.deviceId)) };
      if (op === "trust-device" || op === "untrust-device") return { trusted: op === "trust-device", changed: agent.setDeviceTrust(String(request.deviceId), op === "trust-device", "cli") };
      // Named, never what is left: an op added elsewhere must not unlink the server.
      if (op === "reset-owner") { agent.resetOwner(); return { reset: true }; }
      throw new ControlError("This server does not know that request.", "unknown_op");
    },
    // The runtime is rebuilt when settings change: each request reaches the current one.
    cloudModels: createCloudModelsControl({ projects: () => backend.runtimeManager.getRuntime().projectStore,
      synthesis: () => backend.runtimeManager.getRuntime().synthesis, logger }),
    webTargets: createWebTargetsControl({ projects: () => backend.runtimeManager.getRuntime().projectStore,
      synthesis: () => backend.runtimeManager.getRuntime().synthesis, logger }),
    inferenceApi: async request => {
      const api = backend.inferenceApi;
      if (request.action === "key") return { key: await api.createKey(request.name), status: await api.status() };
      if (request.action === "revoke") {
        if (!await api.revokeKey(request.id)) throw new ControlError("No key has that id: see `api`.", "key_unknown");
        return { revoked: request.id, status: await api.status() };
      }
      if (request.action === "on") return { status: await api.configure({ enabled: true, lan: request.lan, ...(request.port !== undefined ? { port: request.port } : {}) }) };
      if (request.action === "off") return { status: await api.configure({ enabled: false }) };
      return { status: await api.status() };
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
