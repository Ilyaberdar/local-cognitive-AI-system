import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline/promises";
import { checkForUpdate, journalFile, linkedRelease, pointLink, releasesDir, rollback, updateServer, UpdateError } from "../update/serverUpdate";
import { ManifestError } from "../update/manifest";
import { RELEASE_KEYS } from "../update/releaseKeys";
import { releaseRunner, serviceUser, systemdService } from "../update/systemdService";
import { appVersion } from "../utils/appVersion";
import type { ServerArgs } from "./args";
import { checkDataRoot } from "./dataRoot";
import { CliError, ExitCode } from "./exitCodes";

/** The project's newest release (the repository is public; GitHub serves the latest's assets here). */
export const DEFAULT_MANIFEST_URL = "https://github.com/Ilyaberdar/local-cognitive-AI-system/releases/latest/download/server-manifest.json";

const manifestUrlOf = (value: string | undefined) => {
  const url = value || process.env.LOCAL_COGNITIVE_UPDATE_URL || DEFAULT_MANIFEST_URL;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new CliError(`Not a URL: ${url}`, ExitCode.usage); }
  if (parsed.protocol !== "https:" && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(parsed.href)) throw new CliError("The release manifest must be served over https.", ExitCode.usage);
  return parsed.href;
};

const asRoot = (command: string) => {
  if (process.getuid?.() !== 0) throw new CliError(`Run ${command} as root (sudo local-cognitive-server ${command} …): it installs releases and restarts the service.`, ExitCode.config);
};

const confirm = async (question: string, yes: boolean) => {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new CliError("Add --yes to update without a question.", ExitCode.usage);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim()); } finally { prompt.close(); }
};

const fail = (error: unknown): never => {
  if (error instanceof UpdateError || error instanceof ManifestError) throw new CliError(error.message, error.code === "busy" ? ExitCode.unavailable : ExitCode.failure);
  throw error;
};

/** update, rollback and adopt: releases side by side under <prefix>/releases, `current` the running one. */
export const updateCommand = async (args: ServerArgs): Promise<number> => {
  const options = args.update!;
  const log = (line: string) => process.stdout.write(`${line}\n`);
  if (args.command === "update" && options.check) {
    const manifest = await checkForUpdate({ manifestUrl: manifestUrlOf(options.manifestUrl), keys: RELEASE_KEYS, currentVersion: appVersion() }).catch(fail);
    if (args.json) log(JSON.stringify(manifest ? { current: appVersion(), available: manifest.version, notes: manifest.notes } : { current: appVersion(), available: null }));
    else log(manifest ? `Release ${manifest.version} is available (this server runs ${appVersion()}).${manifest.notes ? `\n\n${manifest.notes}` : ""}\n\nInstall it with: sudo local-cognitive-server update --data-dir ${args.dataDir}` : `This server runs ${appVersion()}, the newest release.`);
    return ExitCode.ok;
  }
  asRoot(args.command);
  const dataDir = path.resolve(args.dataDir!);
  checkDataRoot(dataDir);
  const prefix = path.resolve(options.prefix);

  if (args.command === "adopt") {
    const fromApp = path.resolve(options.fromApp ?? path.join(prefix, "app")), fromNode = path.resolve(options.fromNode ?? path.join(prefix, "node"));
    const version = (JSON.parse(fs.readFileSync(path.join(fromApp, "package.json"), "utf8")) as { version?: string }).version;
    if (!version) throw new CliError(`${fromApp} has no package.json version.`, ExitCode.config);
    if (linkedRelease(prefix, "current")) throw new CliError(`${prefix}/current already points to a release: nothing to adopt.`, ExitCode.config);
    const target = path.join(releasesDir(prefix), version);
    if (fs.existsSync(target)) throw new CliError(`${target} exists already.`, ExitCode.config);
    fs.mkdirSync(releasesDir(prefix), { recursive: true, mode: 0o755 });
    execFileSync("cp", ["-a", fromApp, target]);
    execFileSync("cp", ["-a", fromNode, path.join(target, "node")]);
    pointLink(prefix, "current", version);
    log(`${fromApp} is now ${target}, and ${prefix}/current points to it. The old folders are untouched.`);
    log(`Next, point the unit at it and restart:\n  ExecStart=${prefix}/current/node/bin/node ${prefix}/current/dist/src/server/cli.js start --data-dir ${dataDir} --inference auto\n  systemctl daemon-reload && systemctl restart ${options.unit}`);
    return ExitCode.ok;
  }

  const runner = releaseRunner(serviceUser(options.user));
  const service = systemdService({ unit: options.unit, prefix, dataDir, runner });
  if (args.command === "rollback") {
    let journal: { from?: string; to?: string; backup?: string; state?: string };
    try { journal = JSON.parse(fs.readFileSync(journalFile(prefix), "utf8")); } catch { throw new CliError("No update to roll back.", ExitCode.config); }
    if (!journal.from || !journal.to || !journal.backup) throw new CliError("The last update recorded nothing to roll back to.", ExitCode.config);
    if (!await confirm(`Go back to ${journal.from} and the data from before updating to ${journal.to}? Changes made since are kept aside, not lost.`, args.yes)) return ExitCode.failure;
    await rollback({ prefix, dataDir, service, runner, log }, { from: journal.from, to: journal.to, backup: journal.backup }).catch(fail);
    log(`${journal.from} runs again with the data from before the update.`);
    return ExitCode.ok;
  }

  const manifestUrl = manifestUrlOf(options.manifestUrl);
  const available = await checkForUpdate({ manifestUrl, keys: RELEASE_KEYS, currentVersion: appVersion() }).catch(fail);
  if (!available) { log(`This server runs ${appVersion()}, the newest release.`); return ExitCode.ok; }
  if (!await confirm(`Update ${appVersion()} → ${available.version}? The server stops for the update; its data is backed up first.`, args.yes)) return ExitCode.failure;
  await updateServer({ prefix, dataDir, manifestUrl, keys: RELEASE_KEYS, currentVersion: appVersion(), service, runner, wait: options.wait, log }).catch(fail);
  return ExitCode.ok;
};
