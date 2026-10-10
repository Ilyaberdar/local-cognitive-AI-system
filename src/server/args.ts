import { parseArgs } from "util";
import { CliError, ExitCode } from "./exitCodes";

export type InferencePreference = "auto" | "cuda" | "cpu";
export type ServerCommand = "init" | "start" | "status" | "drain" | "help" | "version" | "console" | "pair" | "connect-key" | "devices" | "revoke-device" | "reset-owner" | "folders" | "error-reports" | "backup" | "backups" | "restore" | "update" | "rollback" | "adopt";
export interface ServerArgs {
  command: ServerCommand;
  dataDir?: string;
  inference?: InferencePreference;
  httpPort?: number;
  http?: boolean;
  init: boolean;
  envFile?: string;
  llamaRuntimeDir?: string;
  drainTimeoutSec?: number;
  vaultKeyFile?: string;
  allowRoot: boolean;
  json: boolean;
  quiet: boolean;
  wait: boolean;
  /** pair (connect-key): key lifetime in minutes. */
  ttlMinutes?: number;
  /** revoke-device: the device id from `devices`. */
  deviceId?: string;
  /** folders: list, add <path> or remove <id>. */
  folders?: { action: "list" } | { action: "add"; path: string; label?: string; allowCreate: boolean } | { action: "remove"; id: string };
  /** error-reports: show, or turn on or off, this server's error reports to the developer. */
  errorReports?: "show" | "on" | "off";
  /** backup: a name part for the backup; restore: the backup's name (from `backups`). */
  label?: string;
  backupName?: string;
  /** update/rollback/adopt (run as root): where releases live, the unit and the server's user. */
  update?: { check: boolean; wait: boolean; manifestUrl?: string; prefix: string; unit: string; user: string; fromApp?: string; fromNode?: string };
  yes: boolean;
  /** console: no colours (sudo drops NO_COLOR) and plain ASCII drawing. */
  noColor?: boolean;
  ascii?: boolean;
}

const commands: ServerCommand[] = ["init", "start", "status", "drain", "help", "version", "console", "pair", "connect-key", "devices", "revoke-device", "reset-owner", "folders", "error-reports", "backup", "backups", "restore", "update", "rollback", "adopt"];

export const usage = `Usage: local-cognitive-server <command> [options]

Commands:
  init      Create a data directory and the credential storage key
  start     Run the server in the foreground (systemd or a terminal)
  status    Show whether the server runs and what it is doing
  drain     Finish accepted work, then stop the server
  console                The interactive console (as root): status, live view, the commands below
                         (--no-color, --ascii)
  pair                   Connect a computer: prints a one-time key and waits until it is used
                         (on the computer: Local Cognitive → Remote → Connect; --no-wait, --ttl)
  connect-key            The same as pair, without waiting
  devices                List computers that can connect to this server
  revoke-device <id>     Remove a computer's access
  reset-owner --yes      Unlink the server from its account and remove every computer
  folders                List the folders connected computers may browse and use
  folders add <path>     Share a folder with connected computers (--label, --allow-create)
  folders remove <id>    Stop sharing a folder
  error-reports [on|off] Show, or turn on or off, sending this server's error reports to the developer
  backup                 Back up the server's state (not its models), with the server stopped (--label)
  backups                List the backups
  restore <name>         Put a backup's state back, with the server stopped (the current state is kept aside)
  update                 Install the newest release (as root): backed up, checked, rolled back if it fails
                         (--check to only look, --wait for running work, --yes to skip the question)
  rollback               Go back to the previous release and the data from before the last update (as root)
  adopt                  Once: move an install in --from-app and --from-node into <prefix>/releases (as root)
  help      Show this help

Options:
  --data-dir <dir>          Data directory (or LOCAL_COGNITIVE_DATA_DIR)
  --inference auto|cuda|cpu Inference backend (default: auto)
  --http-port <port>        Loopback HTTP API port (default: 3000)
  --no-http                 Disable the loopback HTTP API
  --init                    start: initialise the data directory first
  --env-file <file>         start: provider keys and options (KEY=value)
  --llama-runtime-dir <dir> start: use this llama.cpp runtime directory
  --drain-timeout <sec>     start: maximum drain time on stop (default: 120)
  --vault-key-file <file>   init: where to create the credential key
  --timeout <sec>           drain: maximum time to wait
  --no-wait                 drain: return once draining started; pair: do not wait for the computer
  --ttl <minutes>           pair: key lifetime (1-60, default: 10)
  --yes                     reset-owner: confirm
  --label <name>            folders add: the name computers see
  --allow-create            folders add: computers may make folders in it
  --json                    Machine-readable output
  --quiet                   status: no output, only the exit code
  --allow-root              Allow running as root (not recommended)
  --prefix <dir>            update: where releases are installed (default: /opt/local-cognitive)
  --unit <name>             update: the systemd unit (default: local-cognitive)
  --user <name>             update: the server's user (default: local-cognitive)
  --manifest-url <url>      update: the release manifest (default: this project's newest GitHub release)`;

const integer = (value: string | undefined, name: string, min: number, max: number): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new CliError(`--${name} must be an integer between ${min} and ${max}.`, ExitCode.usage);
  return parsed;
};

export const parseServerArgs = (argv: string[], env: NodeJS.ProcessEnv = process.env): ServerArgs => {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      "data-dir": { type: "string" }, inference: { type: "string" }, "http-port": { type: "string" }, "no-http": { type: "boolean" },
      init: { type: "boolean" }, "env-file": { type: "string" }, "llama-runtime-dir": { type: "string" }, "drain-timeout": { type: "string" },
      "vault-key-file": { type: "string" }, timeout: { type: "string" }, "no-wait": { type: "boolean" }, json: { type: "boolean" },
      quiet: { type: "boolean" }, "allow-root": { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" },
      ttl: { type: "string" }, yes: { type: "boolean" }, label: { type: "string" }, "allow-create": { type: "boolean" },
      check: { type: "boolean" }, wait: { type: "boolean" }, "manifest-url": { type: "string" }, prefix: { type: "string" }, unit: { type: "string" },
      user: { type: "string" }, "from-app": { type: "string" }, "from-node": { type: "string" }, "no-color": { type: "boolean" }, ascii: { type: "boolean" }
    } });
  } catch (error) { throw new CliError(error instanceof Error ? error.message : String(error), ExitCode.usage); }
  const { values, positionals } = parsed;
  const command = values.help ? "help" : values.version ? "version" : (positionals[0] ?? "help") as ServerCommand;
  if (!commands.includes(command)) throw new CliError(`Unknown command: ${command}`, ExitCode.usage);
  const extra = command === "revoke-device" || command === "error-reports" || command === "restore" ? 2 : command === "folders" ? 3 : 1;
  if (positionals.length > extra) throw new CliError(`Unexpected argument: ${positionals[extra]}`, ExitCode.usage);
  const deviceId = command === "revoke-device" ? positionals[1] : undefined;
  if (command === "revoke-device" && !/^[0-9a-f-]{36}$/i.test(deviceId ?? "")) throw new CliError("revoke-device needs a device id (see `devices`).", ExitCode.usage);
  if (command === "reset-owner" && !values.yes) throw new CliError("reset-owner removes every computer's access: add --yes to confirm.", ExitCode.usage);
  let folders: ServerArgs["folders"];
  if (command === "folders") {
    const [action = "list", target] = positionals.slice(1);
    if (action === "list" && !target) folders = { action };
    else if (action === "add" && target) folders = { action, path: target, ...(values.label ? { label: values.label } : {}), allowCreate: Boolean(values["allow-create"]) };
    else if (action === "remove" && target) folders = { action, id: target };
    else throw new CliError("Use: folders, folders add <path> [--label <name>] [--allow-create], or folders remove <id>.", ExitCode.usage);
  }
  const backupName = command === "restore" ? positionals[1] : undefined;
  if (command === "restore" && !/^\d{8}T\d{6}Z-[\w.+-]{1,80}$/.test(backupName ?? "")) throw new CliError("restore needs a backup name (see `backups`).", ExitCode.usage);
  if (values.label !== undefined && command === "backup" && !/^[\w.+-]{1,80}$/.test(values.label)) throw new CliError("--label is letters, digits and . _ + - only.", ExitCode.usage);
  let errorReports: ServerArgs["errorReports"];
  if (command === "error-reports") {
    const choice = positionals[1] ?? "show";
    if (!["show", "on", "off"].includes(choice)) throw new CliError("Use: error-reports, error-reports on, or error-reports off.", ExitCode.usage);
    errorReports = choice as ServerArgs["errorReports"];
  }
  const inference = values.inference;
  if (inference !== undefined && !["auto", "cuda", "cpu"].includes(inference)) throw new CliError("--inference must be auto, cuda or cpu.", ExitCode.usage);
  const dataDir = values["data-dir"] ?? env.LOCAL_COGNITIVE_DATA_DIR;
  if (["init", "start", "status", "drain", "console", "pair", "connect-key", "devices", "revoke-device", "reset-owner", "folders", "error-reports", "backup", "backups", "restore", "update", "rollback", "adopt"].includes(command) && !dataDir) throw new CliError("--data-dir (or LOCAL_COGNITIVE_DATA_DIR) is required.", ExitCode.usage);
  return {
    command, dataDir, inference: inference as InferencePreference | undefined,
    httpPort: integer(values["http-port"], "http-port", 0, 65535), http: values["no-http"] ? false : undefined,
    init: Boolean(values.init), envFile: values["env-file"], llamaRuntimeDir: values["llama-runtime-dir"],
    drainTimeoutSec: integer(values["drain-timeout"] ?? values.timeout, values.timeout !== undefined ? "timeout" : "drain-timeout", 0, 86_400),
    vaultKeyFile: values["vault-key-file"], allowRoot: Boolean(values["allow-root"]), json: Boolean(values.json), quiet: Boolean(values.quiet),
    wait: !values["no-wait"], ttlMinutes: integer(values.ttl, "ttl", 1, 60), ...(deviceId ? { deviceId } : {}), yes: Boolean(values.yes), ...(folders ? { folders } : {}), ...(errorReports ? { errorReports } : {}),
    ...(command === "backup" && values.label ? { label: values.label } : {}), ...(backupName ? { backupName } : {}),
    ...(values["no-color"] ? { noColor: true } : {}), ...(values.ascii ? { ascii: true } : {}),
    ...(["update", "rollback", "adopt"].includes(command) ? { update: { check: Boolean(values.check), wait: Boolean(values.wait),
      ...(values["manifest-url"] ? { manifestUrl: values["manifest-url"] } : {}), prefix: values.prefix ?? "/opt/local-cognitive",
      unit: values.unit ?? "local-cognitive", user: values.user ?? "local-cognitive",
      ...(values["from-app"] ? { fromApp: values["from-app"] } : {}), ...(values["from-node"] ? { fromNode: values["from-node"] } : {}) } } : {})
  };
};
