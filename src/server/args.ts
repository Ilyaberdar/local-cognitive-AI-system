import { parseArgs } from "util";
import { CliError, ExitCode } from "./exitCodes";

export type InferencePreference = "auto" | "cuda" | "cpu";
export type ServerCommand = "init" | "start" | "status" | "drain" | "help" | "version" | "connect-key" | "devices" | "revoke-device" | "reset-owner";
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
  /** connect-key: key lifetime in minutes. */
  ttlMinutes?: number;
  /** revoke-device: the device id from `devices`. */
  deviceId?: string;
  yes: boolean;
}

const commands: ServerCommand[] = ["init", "start", "status", "drain", "help", "version", "connect-key", "devices", "revoke-device", "reset-owner"];

export const usage = `Usage: local-cognitive-server <command> [options]

Commands:
  init      Create a data directory and the credential storage key
  start     Run the server in the foreground (systemd or a terminal)
  status    Show whether the server runs and what it is doing
  drain     Finish accepted work, then stop the server
  connect-key            Print a one-time key to connect a computer (Remote → Connect)
  devices                List computers that can connect to this server
  revoke-device <id>     Remove a computer's access
  reset-owner --yes      Unlink the server from its account and remove every computer
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
  --no-wait                 drain: return once draining started
  --ttl <minutes>           connect-key: key lifetime (1-60, default: 10)
  --yes                     reset-owner: confirm
  --json                    Machine-readable output
  --quiet                   status: no output, only the exit code
  --allow-root              Allow running as root (not recommended)`;

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
      ttl: { type: "string" }, yes: { type: "boolean" }
    } });
  } catch (error) { throw new CliError(error instanceof Error ? error.message : String(error), ExitCode.usage); }
  const { values, positionals } = parsed;
  const command = values.help ? "help" : values.version ? "version" : (positionals[0] ?? "help") as ServerCommand;
  if (!commands.includes(command)) throw new CliError(`Unknown command: ${command}`, ExitCode.usage);
  const extra = command === "revoke-device" ? 2 : 1;
  if (positionals.length > extra) throw new CliError(`Unexpected argument: ${positionals[extra]}`, ExitCode.usage);
  const deviceId = command === "revoke-device" ? positionals[1] : undefined;
  if (command === "revoke-device" && !/^[0-9a-f-]{36}$/i.test(deviceId ?? "")) throw new CliError("revoke-device needs a device id (see `devices`).", ExitCode.usage);
  if (command === "reset-owner" && !values.yes) throw new CliError("reset-owner removes every computer's access: add --yes to confirm.", ExitCode.usage);
  const inference = values.inference;
  if (inference !== undefined && !["auto", "cuda", "cpu"].includes(inference)) throw new CliError("--inference must be auto, cuda or cpu.", ExitCode.usage);
  const dataDir = values["data-dir"] ?? env.LOCAL_COGNITIVE_DATA_DIR;
  if (["init", "start", "status", "drain", "connect-key", "devices", "revoke-device", "reset-owner"].includes(command) && !dataDir) throw new CliError("--data-dir (or LOCAL_COGNITIVE_DATA_DIR) is required.", ExitCode.usage);
  return {
    command, dataDir, inference: inference as InferencePreference | undefined,
    httpPort: integer(values["http-port"], "http-port", 0, 65535), http: values["no-http"] ? false : undefined,
    init: Boolean(values.init), envFile: values["env-file"], llamaRuntimeDir: values["llama-runtime-dir"],
    drainTimeoutSec: integer(values["drain-timeout"] ?? values.timeout, values.timeout !== undefined ? "timeout" : "drain-timeout", 0, 86_400),
    vaultKeyFile: values["vault-key-file"], allowRoot: Boolean(values["allow-root"]), json: Boolean(values.json), quiet: Boolean(values.quiet),
    wait: !values["no-wait"], ttlMinutes: integer(values.ttl, "ttl", 1, 60), ...(deviceId ? { deviceId } : {}), yes: Boolean(values.yes)
  };
};
