import fs from "fs";
import path from "path";
import { z } from "zod";
import { appVersion, releaseRoot } from "../utils/appVersion";
import type { InferencePreference } from "./args";
import { CliError, ExitCode } from "./exitCodes";

export const DATA_SUBDIRECTORIES = ["app", "memory", "sessions", "output", "models"] as const;

// No secrets: provider keys go to the env file, credentials to the vault.
const serverConfigSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  createdByVersion: z.string(),
  inference: z.enum(["auto", "cuda", "cpu"]),
  http: z.object({ enabled: z.boolean(), port: z.number().int().min(0).max(65535) }).strict(),
  drainTimeoutSec: z.number().int().min(0).max(86_400)
}).strict();
export type ServerConfig = z.infer<typeof serverConfigSchema>;

export const dataDirectories = (root: string) => Object.fromEntries(DATA_SUBDIRECTORIES.map(name => [name, path.join(root, name)])) as Record<typeof DATA_SUBDIRECTORIES[number], string>;
export const serverConfigPath = (root: string) => path.join(root, "server.json");

const isInside = (child: string, parent: string) => { const relative = path.relative(parent, child); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };

const assertLocation = (root: string) => {
  if (path.parse(root).root === root) throw new CliError("The data directory must not be a filesystem root.", ExitCode.config);
  if (isInside(root, releaseRoot())) throw new CliError("The data directory must be outside the application release directory.", ExitCode.config);
};

const privateDirectory = (directory: string, created: string[]) => {
  if (!fs.existsSync(directory)) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); created.push(directory); }
  if (process.platform !== "win32" && (fs.statSync(directory).mode & 0o077)) fs.chmodSync(directory, 0o700);
};

/** Creates the data directory layout and server.json once; existing files are kept. */
export const initDataRoot = (rootInput: string, options: { inference?: InferencePreference; httpPort?: number; http?: boolean; drainTimeoutSec?: number } = {}) => {
  const root = path.resolve(rootInput);
  assertLocation(root);
  const created: string[] = [];
  privateDirectory(root, created);
  for (const directory of Object.values(dataDirectories(root))) privateDirectory(directory, created);
  const file = serverConfigPath(root);
  if (!fs.existsSync(file)) {
    const config: ServerConfig = { schemaVersion: 1, createdAt: new Date().toISOString(), createdByVersion: appVersion(), inference: options.inference ?? "auto",
      http: { enabled: options.http ?? true, port: options.httpPort ?? 3000 }, drainTimeoutSec: options.drainTimeoutSec ?? 120 };
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    created.push(file);
  }
  return { root, created, config: readServerConfig(root) };
};

export const readServerConfig = (rootInput: string): ServerConfig => {
  const root = path.resolve(rootInput), file = serverConfigPath(root);
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch { throw new CliError(`${root} is not initialised. Run: local-cognitive-server init --data-dir ${root}`, ExitCode.config); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new CliError(`${file} is not valid JSON.`, ExitCode.config); }
  const result = serverConfigSchema.safeParse(parsed);
  if (!result.success) throw new CliError(`${file} is invalid: ${z.prettifyError(result.error)}`, ExitCode.config);
  return result.data;
};

/** Refuses a data directory other users can read: it holds chats, models and credentials. */
export const checkDataRoot = (rootInput: string) => {
  const root = path.resolve(rootInput);
  assertLocation(root);
  if (process.platform === "win32") return;
  for (const directory of [root, ...Object.values(dataDirectories(root))]) {
    if (!fs.existsSync(directory)) throw new CliError(`${directory} is missing. Run: local-cognitive-server init --data-dir ${root}`, ExitCode.config);
    if (fs.statSync(directory).mode & 0o077) throw new CliError(`${directory} is accessible to other users. Restrict it (chmod 700).`, ExitCode.config);
  }
};

/** Unix socket of the running server; long paths are silently truncated by the OS, so they are refused. */
export const controlSocketPathFor = (appDataDir: string, env: NodeJS.ProcessEnv = process.env): string => {
  const socket = env.LOCAL_COGNITIVE_CONTROL_SOCKET || path.join(appDataDir, "runtime", "control.sock");
  const limit = process.platform === "darwin" ? 103 : 107;
  if (Buffer.byteLength(socket) > limit) throw new CliError(`The control socket path is longer than ${limit} bytes: ${socket}. Use a shorter --data-dir.`, ExitCode.config);
  return socket;
};
