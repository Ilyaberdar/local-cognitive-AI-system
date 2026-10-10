#!/usr/bin/env node
import fs from "fs";
import os from "os";
import path from "path";
import { appVersion, releaseRoot } from "../utils/appVersion";
import { initVaultKey } from "../security/vaultKey";
import { parseServerArgs, ServerArgs, usage } from "./args";
import { controlRequest } from "./ControlServer";
import { checkDataRoot, controlSocketPathFor, dataDirectories, initDataRoot, readServerConfig } from "./dataRoot";
import { consentFilePath, readConsent, writeConsent } from "../diagnostics/consentFile";
import { backupDataRoot, listBackups, restoreDataRoot } from "../update/dataBackup";
import { updateCommand } from "./updateCommand";
import { DataRootLock, DataRootLockedError } from "../runtime/db/DataRootLock";
import { CliError, ExitCode } from "./exitCodes";
import { selectInference } from "./inference";
import { addAdminFolder, FolderError, listAdminFolders, removeAdminFolder } from "../runtime/hostFolders";
import { serverEnvironment } from "./serverEnv";
import { printable, printableDeep, printableMessage } from "./terminalText";

// Only modules that do not read the application configuration are imported above: the
// configuration is evaluated when its module loads, after `start` has set the environment.

const print = (args: ServerArgs, text: string, json: unknown) => { if (!args.quiet) process.stdout.write(args.json ? `${JSON.stringify(json)}\n` : `${text}\n`); };
const defaultKeyFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "local-cognitive", "vault.key");
const ownerFile = (root: string) => path.join(dataDirectories(root).app, "runtime", "data-root.owner.json");
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
const unreachable = (error: unknown) => ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "");
/** The server's control socket belongs to its user: anyone else is refused by the system. */
const notPermitted = (error: unknown, command: string) => ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
  ? new CliError(`Permission denied: the server's files belong to its user. Run: sudo local-cognitive-server ${command}`, ExitCode.config) : error;

const init = (args: ServerArgs) => {
  const { root, created, config } = initDataRoot(args.dataDir!, { inference: args.inference, httpPort: args.httpPort, http: args.http });
  const keyFile = path.resolve(args.vaultKeyFile || process.env.LOCAL_COGNITIVE_VAULT_KEY_FILE || defaultKeyFile());
  const key = initVaultKey(keyFile, { forbiddenRoots: [root, releaseRoot()] });
  print(args, [
    `Data directory: ${root}${created.length ? ` (created ${created.length} entries)` : " (already initialised)"}`,
    `Credential key: ${keyFile} (${key.created ? "created" : "already present"}, id ${key.id})`,
    `Set LOCAL_COGNITIVE_VAULT_KEY_FILE=${keyFile} for the server.`,
    "Back up the key separately from the data directory: without it saved credentials cannot be read."
  ].join("\n"), { dataDir: root, created, config, vaultKeyFile: keyFile, vaultKeyId: key.id, vaultKeyCreated: key.created });
  return ExitCode.ok;
};

const start = async (args: ServerArgs) => {
  if (process.platform === "win32") throw new CliError("The server runs on Linux and macOS.", ExitCode.config);
  if (process.getuid?.() === 0 && !args.allowRoot) throw new CliError("Refusing to run as root. Use a dedicated user, or pass --allow-root.", ExitCode.config);
  if (args.init) initDataRoot(args.dataDir!, { inference: args.inference, httpPort: args.httpPort, http: args.http });
  const root = path.resolve(args.dataDir!);
  const serverConfig = readServerConfig(root);
  checkDataRoot(root);
  const release = releaseRoot();
  const inference = selectInference(args.inference ?? serverConfig.inference, { release, override: args.llamaRuntimeDir || process.env.LLAMA_RUNTIME_DIR });
  const { env, overridden } = serverEnvironment({ root, config: serverConfig, args, release, inference, base: process.env });
  controlSocketPathFor(dataDirectories(root).app, env);
  Object.assign(process.env, env);
  process.umask(0o077);
  // Agent commands run here; .env and config files are never read from this directory.
  process.chdir(dataDirectories(root).output);
  const { runDaemon } = await import("./daemon");
  return runDaemon({ drainTimeoutSec: args.drainTimeoutSec ?? serverConfig.drainTimeoutSec, inference, overriddenEnv: overridden });
};

interface StatusResult {
  phase: string; pid: number; version?: string; activeWork: { total: number }; http?: { port: number };
  inference: { backend: string; active?: string; fallbackReason?: string };
  remote?: { state?: string; claimed?: boolean; devices?: number; sessions?: number; reason?: string; lastError?: string };
  update?: { available?: string | null; error?: string | null };
}

/** What `status` says to a person: whether computers can reach the server, and what to do next. */
export const describeStatus = (result: StatusResult): string => {
  const { backend, active, fallbackReason } = result.inference;
  const inference = active && active.toLowerCase() !== backend ? `${backend} → ${active}${fallbackReason ? ` (${fallbackReason})` : ""}` : backend;
  const remote = result.remote;
  const devices = remote?.devices ?? 0, sessions = remote?.sessions ?? 0;
  const computers = `${devices} computer${devices === 1 ? "" : "s"} paired${sessions ? `, ${sessions} connected now` : ""}`;
  const remoteLine = !remote || remote.state === "off" ? `off${remote?.reason ? ` — ${remote.reason.replace(/\.$/, "")}` : ""}`
    : remote.state === "online" ? `online, ${remote.claimed ? computers : "no owner yet: run pair to connect your computer"}`
      : `${remote.state ?? "unknown"}${remote.lastError ? ` (${remote.lastError})` : ""}, ${computers}`;
  const work = result.activeWork.total ? `${result.activeWork.total} task${result.activeWork.total === 1 ? "" : "s"} running` : "idle";
  return [
    `Local Cognitive Server ${result.version ?? ""} — ${result.phase === "running" ? "running" : result.phase}`.replace("  ", " "),
    `  Remote:     ${remoteLine}`,
    `  Inference:  ${inference}`,
    `  Work:       ${work}`,
    ...(result.update?.available ? [`  Update:     ${result.update.available} is available: sudo local-cognitive-server update`] : [])
  ].join("\n");
};

const status = async (args: ServerArgs) => {
  const root = path.resolve(args.dataDir!);
  try {
    const response = await controlRequest(controlSocketPathFor(dataDirectories(root).app), { op: "status" }, { timeoutMs: 5_000 });
    const result = response.result as StatusResult;
    print(args, describeStatus(printableDeep(result)), { running: true, ...result });
    return ExitCode.ok;
  } catch (error) {
    if (!unreachable(error)) throw notPermitted(error, "status");
    let owner: { pid?: number } | undefined;
    try { owner = JSON.parse(fs.readFileSync(ownerFile(root), "utf8")); } catch { owner = undefined; }
    if (owner?.pid && isAlive(owner.pid)) { print(args, `Starting or not responding (pid ${owner.pid}).`, { running: "unknown", pid: owner.pid }); return ExitCode.unknownState; }
    print(args, "Not running. Start it: sudo systemctl start local-cognitive", { running: false });
    return ExitCode.notRunning;
  }
};

const drain = async (args: ServerArgs) => {
  const root = path.resolve(args.dataDir!);
  let result: Record<string, unknown> | undefined;
  try {
    await controlRequest(controlSocketPathFor(dataDirectories(root).app), { op: "drain", timeoutSec: args.drainTimeoutSec }, {
      onEvent: event => {
        if (event.event === "drain.progress" && !args.json && !args.quiet) process.stdout.write(`Waiting for ${String(event.active)} active task(s)…\n`);
        if (event.event === "drain.done") result = event;
      }
    });
  } catch (error) {
    if (!unreachable(error)) throw notPermitted(error, "drain");
    throw new CliError("The server is not running.", ExitCode.unavailable);
  }
  if (args.wait) for (let waited = 0; fs.existsSync(ownerFile(root)) && waited < 60_000; waited += 250) await new Promise(resolve => setTimeout(resolve, 250));
  print(args, result?.drained ? "Drained and stopped." : `Stopped after the timeout; ${String(result?.remaining ?? "some")} task(s) were interrupted.`, result ?? {});
  return result?.drained === false ? ExitCode.failure : ExitCode.ok;
};

/** Sends a pairing administration request to the running server. */
const remoteRequest = async (args: ServerArgs, request: Record<string, unknown>) => {
  const root = path.resolve(args.dataDir!);
  let response: Record<string, unknown>;
  try { response = await controlRequest(controlSocketPathFor(dataDirectories(root).app), request, { timeoutMs: 15_000 }); }
  catch (error) { if (unreachable(error)) throw new CliError("The server is not running. Start it: sudo systemctl start local-cognitive", ExitCode.unavailable); throw notPermitted(error, args.command); }
  if (!response.ok) {
    const error = response.error as { code?: string; message?: string } | undefined;
    // The message may carry text from the network (the Cloud's last error).
    throw new CliError(printableMessage(error?.message ?? "The server refused the request."), error?.code === "offline" || error?.code === "remote_off" ? ExitCode.unavailable : ExitCode.failure);
  }
  return response.result as Record<string, unknown>;
};

/** pair: a one-time key for Remote → Connect, then waits until a computer uses that key, like
 * pairing two devices (a computer paired before counts too). connect-key prints the key only. */
const pair = async (args: ServerArgs, wait: boolean) => {
  const result = await remoteRequest(args, { op: "connect-key", ...(args.ttlMinutes ? { ttlSec: args.ttlMinutes * 60 } : {}) }) as { key: string; invitationId: string; expiresAt: number; claimed: boolean };
  const until = new Date(result.expiresAt).toTimeString().slice(0, 5);
  // The key is a secret: only this command's output shows it, never the service log.
  if (args.quiet) { process.stdout.write(`${result.key}\n`); return ExitCode.ok; }
  print(args, [
    `Connection key (one use, valid until ${until}; restarting the server cancels it):`, "", `    ${result.key}`, "",
    "On your computer: Local Cognitive → Remote → Connect, then paste the key.",
    result.claimed ? "Only the account that owns this server can connect with it." : "No account owns this server yet: the account that connects first becomes its owner. No sign-in is needed here."
  ].join("\n"), result);
  if (!wait || args.json) return ExitCode.ok;
  process.stdout.write("\nWaiting for the computer to connect… (Ctrl+C stops waiting; the key stays valid)\n");
  while (Date.now() < result.expiresAt) {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const used = await remoteRequest(args, { op: "invitation", invitationId: result.invitationId }) as { consumed: boolean; deviceName?: string };
    if (used.consumed) { process.stdout.write(`✓ ${used.deviceName ? printable(used.deviceName) : "A computer"} is connected.\n`); return ExitCode.ok; }
  }
  process.stdout.write("The key expired before a computer used it. Run pair again for a new one.\n");
  return ExitCode.failure;
};

const devices = async (args: ServerArgs) => {
  const { devices: list } = await remoteRequest(args, { op: "devices" }) as { devices: Array<{ deviceId: string; deviceName?: string; status: string; grantedAt: string; lastConnectedAt?: string }> };
  const active = list.filter(device => device.status === "active");
  print(args, active.length ? active.map(device => `${device.deviceId}  ${device.deviceName ? printable(device.deviceName) : "(unnamed)"}  paired ${device.grantedAt.slice(0, 10)}${device.lastConnectedAt ? `, last seen ${device.lastConnectedAt.slice(0, 16).replace("T", " ")}` : ""}`).join("\n")
    : "No computers can connect yet. Run pair to add one.", { devices: list });
  return ExitCode.ok;
};

/** Backups of the server's state (not its models): taken and restored with the server stopped,
 * under the data root lock, as the server's user. */
const backupCommand = async (args: ServerArgs) => {
  if (process.getuid?.() === 0 && !args.allowRoot) throw new CliError(`Run ${args.command} as the server's user (sudo -u <user> …), or pass --allow-root.`, ExitCode.config);
  const root = path.resolve(args.dataDir!);
  checkDataRoot(root);
  if (args.command === "backups") {
    const backups = listBackups(root);
    if (args.json) process.stdout.write(`${JSON.stringify(backups)}\n`);
    else process.stdout.write(backups.length ? `${backups.map(item => `${item.name}  ${item.appVersion ?? "?"}  ${Math.ceil((item.bytes ?? 0) / 1024 ** 2)} MB`).join("\n")}\n` : "No backups.\n");
    return ExitCode.ok;
  }
  let lock: DataRootLock;
  try { lock = await DataRootLock.acquire(dataDirectories(root).app, "maintenance", appVersion(), { waitMs: 0 }); }
  catch (error) {
    if (error instanceof DataRootLockedError) throw new CliError("The server is running: stop it first (systemctl stop local-cognitive).", ExitCode.locked);
    throw error;
  }
  try {
    if (args.command === "backup") {
      const result = backupDataRoot(root, { label: args.label ?? `manual-${appVersion()}` });
      if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else process.stdout.write(`Backed up ${result.files} files (${Math.ceil(result.bytes / 1024 ** 2)} MB) to ${result.directory}\n`);
    } else {
      const result = restoreDataRoot(root, path.join(root, "backups", args.backupName!));
      if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else process.stdout.write(`Restored ${args.backupName}. The state it replaced is in ${result.replaced}\n`);
    }
    return ExitCode.ok;
  } finally { lock.release(); }
};

/** Error reports to the developer (Sentry, EU): the owner's choice, off until turned on. A file
 * in the data directory, read again by the running server: no restart is needed. */
const errorReports = (args: ServerArgs) => {
  // Run as the server's user: a file root writes is one the server cannot read (reports stay off).
  if (process.getuid?.() === 0 && !args.allowRoot) throw new CliError("Run error-reports as the server's user (sudo -u <user> …), or pass --allow-root.", ExitCode.config);
  const root = path.resolve(args.dataDir!);
  checkDataRoot(root);
  const file = consentFilePath(dataDirectories(root).app);
  const consent = args.errorReports === "on" || args.errorReports === "off" ? writeConsent(file, args.errorReports === "on") : readConsent(file);
  if (args.json) process.stdout.write(`${JSON.stringify(consent)}\n`);
  else process.stdout.write(`Error reports to the developer are ${consent.automatic ? "on" : "off"}.${consent.automatic
    ? " Uncaught errors are sent to Sentry (EU region) without chats, prompts, keys, paths or file contents."
    : " Turn them on with: local-cognitive-server error-reports on"}\n`);
  return ExitCode.ok;
};

/** Shared folders are a file in the data directory, read at every use: no restart is needed. */
const folders = async (args: ServerArgs) => {
  // Run as the server's user: a list root writes is one the server cannot read (it would share nothing).
  if (process.getuid?.() === 0 && !args.allowRoot) throw new CliError("Run folders as the server's user (sudo -u <user> …), or pass --allow-root.", ExitCode.config);
  const root = path.resolve(args.dataDir!);
  checkDataRoot(root);
  const request = args.folders!;
  // One change at a time, across processes.
  const lock = path.join(root, "folders.json.lock");
  for (let attempt = 0; ; attempt++) {
    try { fs.closeSync(fs.openSync(lock, "wx", 0o600)); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt > 50) throw new CliError(`Another folders command is running (or ${lock} was left behind; remove it).`, ExitCode.failure);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try {
    if (request.action === "add") {
      const keyFile = path.resolve(process.env.LOCAL_COGNITIVE_VAULT_KEY_FILE || defaultKeyFile());
      const added = addAdminFolder(root, request.path, { label: request.label, allowCreate: request.allowCreate, protectedFiles: [keyFile] });
      print(args, `Shared ${added.path} as "${added.label ?? path.basename(added.path)}" (id ${added.id})${added.allowCreate ? ", folders may be made in it" : ""}.`, added);
    } else if (request.action === "remove") {
      const removed = removeAdminFolder(root, request.id);
      print(args, removed ? "No longer shared. Computers lose access at once." : "No shared folder has this id.", { removed });
      return removed ? ExitCode.ok : ExitCode.failure;
    } else {
      const list = listAdminFolders(root);
      print(args, list.length ? list.map(folder => `${folder.id}  ${folder.label ?? path.basename(folder.path)}  ${folder.path}${folder.allowCreate ? "  (new folders allowed)" : ""}`).join("\n")
        : "No folders are shared. Computers can use the server's Projects folder; share more with: folders add <path>", { folders: list });
    }
    return ExitCode.ok;
  } catch (error) {
    if (error instanceof FolderError) throw new CliError(error.message, ExitCode.config);
    throw error;
  } finally { fs.rmSync(lock, { force: true }); }
};

export const main = async (argv: string[]): Promise<number> => {
  try {
    const args = parseServerArgs(argv);
    switch (args.command) {
      case "help": process.stdout.write(`${usage}\n`); return ExitCode.ok;
      case "version": process.stdout.write(`${appVersion()}\n`); return ExitCode.ok;
      case "init": return init(args);
      case "start": return await start(args);
      case "status": return await status(args);
      case "drain": return await drain(args);
      case "console": {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError("The console needs a terminal.", ExitCode.usage);
        const { runConsole } = await import("./console");
        return await runConsole({ dataDir: args.dataDir! });
      }
      case "pair": return await pair(args, args.wait);
      case "connect-key": return await pair(args, false);
      case "devices": return await devices(args);
      case "folders": return await folders(args);
      case "error-reports": return errorReports(args);
      case "backup": case "backups": case "restore": return await backupCommand(args);
      case "update": case "rollback": case "adopt": return await updateCommand(args);
      case "revoke-device": {
        const { revoked } = await remoteRequest(args, { op: "revoke-device", deviceId: args.deviceId }) as { revoked: boolean };
        print(args, revoked ? "Access removed. The computer was disconnected." : "No active access for this device.", { revoked });
        return revoked ? ExitCode.ok : ExitCode.failure;
      }
      case "reset-owner":
        print(args, "The server is no longer linked to an account; every computer lost access.", await remoteRequest(args, { op: "reset-owner" }));
        return ExitCode.ok;
    }
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      if (error.exitCode === ExitCode.usage) process.stderr.write(`\n${usage}\n`);
      return error.exitCode;
    }
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return ExitCode.failure;
  }
};

if (require.main === module) void main(process.argv.slice(2)).then(code => process.exit(code));
