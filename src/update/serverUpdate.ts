import { createHash } from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { artifactFor, isUpgrade, ManifestError, verifyManifest, type ReleaseKey, type ServerManifest } from "./manifest";

/** How the server runs, for the updater: systemd on a real host, a child process in tests. */
export interface ServiceControl {
  stop(): Promise<void>;
  start(): Promise<void>;
  /** Work the running server has accepted (runs, queued inference); undefined when it does not answer. */
  activeWork(): Promise<number | undefined>;
  /** Waits until the server runs the given version and is up, or says why not. */
  healthy(version: string, timeoutMs: number): Promise<{ ok: boolean; reason?: string }>;
}

/** Commands of a release's own CLI run as the server's user (backup, restore, version). */
export interface ReleaseRunner {
  run(releaseDir: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }>;
}

export interface UpdateOptions {
  /** The install prefix: releases/, current, previous, downloads/ and the journal live here. */
  prefix: string;
  dataDir: string;
  manifestUrl: string;
  keys: readonly ReleaseKey[];
  currentVersion: string;
  service: ServiceControl;
  runner: ReleaseRunner;
  fetchImpl?: typeof fetch;
  platform?: string;
  arch?: string;
  /** Wait for accepted work to finish instead of refusing. */
  wait?: boolean;
  healthTimeoutMs?: number;
  log?: (line: string) => void;
  now?: () => Date;
}

export class UpdateError extends Error { constructor(message: string, readonly code: string) { super(message); this.name = "UpdateError"; } }

const MAX_MANIFEST_BYTES = 256 * 1024;
const RELEASES_KEPT = 3;

export const releasesDir = (prefix: string) => path.join(prefix, "releases");
export const journalFile = (prefix: string) => path.join(prefix, "update.json");

/** The release a link points to (its version), or undefined. */
export const linkedRelease = (prefix: string, name: "current" | "previous"): string | undefined => {
  try { return path.basename(fs.readlinkSync(path.join(prefix, name))); } catch { return undefined; }
};

/** Points `name` at releases/<version>, atomically (a new link renamed over the old one). */
export const pointLink = (prefix: string, name: "current" | "previous", version: string) => {
  const link = path.join(prefix, name), temporary = `${link}.${process.pid}.new`;
  fs.rmSync(temporary, { force: true });
  fs.symlinkSync(path.join("releases", version), temporary);
  fs.renameSync(temporary, link);
};

const fetchBytes = async (fetchImpl: typeof fetch, url: string, limit: number): Promise<Buffer> => {
  const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new UpdateError(`${url} answered HTTP ${response.status}.`, "download_failed");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) throw new UpdateError(`${url} is larger than expected.`, "download_failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new UpdateError(`${url} is larger than expected.`, "download_failed");
  return bytes;
};

/** The newest release's manifest, signature checked; undefined when it is not newer than this one. */
export const checkForUpdate = async (options: Pick<UpdateOptions, "manifestUrl" | "keys" | "currentVersion" | "fetchImpl">): Promise<ServerManifest | undefined> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const [manifest, signature] = await Promise.all([fetchBytes(fetchImpl, options.manifestUrl, MAX_MANIFEST_BYTES),
    fetchBytes(fetchImpl, `${options.manifestUrl}.sig`, 4096)]);
  const verified = verifyManifest(manifest, signature.toString("utf8"), options.keys);
  return isUpgrade(verified, options.currentVersion) ? verified : undefined;
};

/** A tarball's entries are plain files and folders inside it: no links, devices, absolute paths or "..". */
export const checkArchive = (tarball: string) => {
  const listing = execFileSync("tar", ["-tvzf", tarball], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  for (const line of listing.split("\n").filter(Boolean)) {
    const type = line[0];
    // GNU tar marks links with l or h; bsdtar shows a hard link as a file "link to" another.
    if ((type !== "-" && type !== "d") || / link to | -> /.test(line)) throw new UpdateError(`The release contains a link or special file: ${line.slice(0, 200)}`, "unsafe_archive");
  }
  for (const name of execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean)) {
    const clean = name.replace(/^\.\//, "");
    if (path.isAbsolute(clean) || clean.split(/[\\/]/).includes("..")) throw new UpdateError(`The release contains an unsafe path: ${name.slice(0, 200)}`, "unsafe_archive");
  }
};

const sha256File = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const writeJournal = (prefix: string, entry: Record<string, unknown>) => {
  const file = journalFile(prefix), temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...entry, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporary, file);
};

/** Downloads, checks and unpacks a release beside the others; the running one is not touched. */
export const stageRelease = async (manifest: ServerManifest, options: UpdateOptions): Promise<string> => {
  const log = options.log ?? (() => undefined);
  const artifact = artifactFor(manifest, options.platform, options.arch);
  const downloads = path.join(options.prefix, "downloads");
  fs.mkdirSync(downloads, { recursive: true, mode: 0o755 });
  const tarball = path.join(downloads, `local-cognitive-server-${manifest.version}.tar.gz`);
  if (!fs.existsSync(tarball) || sha256File(tarball) !== artifact.sha256) {
    log(`Downloading ${manifest.version} (${Math.ceil(artifact.size / 1024 ** 2)} MB)…`);
    const bytes = await fetchBytes(options.fetchImpl ?? fetch, artifact.url, artifact.size);
    fs.writeFileSync(`${tarball}.partial`, bytes, { mode: 0o644 });
    fs.renameSync(`${tarball}.partial`, tarball);
  }
  if (fs.statSync(tarball).size !== artifact.size || sha256File(tarball) !== artifact.sha256) {
    fs.rmSync(tarball, { force: true });
    throw new UpdateError("The download does not match the signed release: it was changed or cut short.", "checksum_mismatch");
  }
  checkArchive(tarball);
  const target = path.join(releasesDir(options.prefix), manifest.version), partial = `${target}.partial`;
  if (fs.existsSync(target)) return target;
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true, mode: 0o755 });
  execFileSync("tar", ["-xzf", tarball, "-C", partial, "--no-same-owner"], { stdio: "ignore" });
  const self = await options.runner.run(partial, ["version"]);
  if (self.status !== 0 || self.stdout.trim() !== manifest.version) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw new UpdateError(`The new release did not start its own check (${self.stderr.trim().slice(0, 300) || self.stdout.trim().slice(0, 100)}).`, "self_check_failed");
  }
  // Runtimes prepared on this host (the CUDA build) come along when the new release has none.
  const current = linkedRelease(options.prefix, "current");
  const runtimes = current && path.join(releasesDir(options.prefix), current, "resources", "llama");
  if (runtimes && fs.existsSync(runtimes)) {
    for (const id of fs.readdirSync(runtimes)) {
      const into = path.join(partial, "resources", "llama", id);
      if (!fs.existsSync(into)) { fs.mkdirSync(path.dirname(into), { recursive: true }); fs.cpSync(path.join(runtimes, id), into, { recursive: true, preserveTimestamps: true }); }
    }
  }
  fs.renameSync(partial, target);
  return target;
};

const waitForIdle = async (service: ServiceControl, wait: boolean, log: (line: string) => void) => {
  for (;;) {
    const active = await service.activeWork();
    if (!active) return;
    if (!wait) throw new UpdateError(`The server is working (${active} accepted task${active === 1 ? "" : "s"}). Try later, or pass --wait.`, "busy");
    log(`Waiting for ${active} task${active === 1 ? "" : "s"} to finish…`);
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
};

/** Installs a newer release: staged beside the running one, the data backed up with the server
 * stopped, the new one started and checked, and both code and data put back if it does not come
 * up. A journal records each step, so an interrupted update can be rolled back. */
export const updateServer = async (options: UpdateOptions): Promise<{ updated: false } | { updated: true; from: string; to: string; backup: string }> => {
  const log = options.log ?? (() => undefined);
  const manifest = await checkForUpdate(options);
  if (!manifest) { log(`This server runs ${options.currentVersion}, the newest release.`); return { updated: false }; }
  log(`Release ${manifest.version} (signed). ${manifest.notes ? `Notes: ${manifest.notes.slice(0, 2000)}` : ""}`.trim());
  const from = linkedRelease(options.prefix, "current");
  if (!from) throw new UpdateError(`${options.prefix}/current is not a release link: run the one-time adopt step first.`, "not_adopted");
  await stageRelease(manifest, options);
  await waitForIdle(options.service, options.wait === true, log);

  writeJournal(options.prefix, { state: "stopping", from, to: manifest.version });
  log("Stopping the server…");
  await options.service.stop();
  // The new release's own commands (it passed its self-check): the running one may predate them.
  const target = path.join(releasesDir(options.prefix), manifest.version);
  const backup = await options.runner.run(target, ["backup", "--data-dir", options.dataDir, "--label", `before-${manifest.version}`, "--json"]);
  if (backup.status !== 0) {
    log("The backup failed; starting the current version again.");
    await options.service.start();
    writeJournal(options.prefix, { state: "aborted", from, to: manifest.version, reason: "backup_failed" });
    throw new UpdateError(`The data could not be backed up: ${backup.stderr.trim().slice(0, 300)}`, "backup_failed");
  }
  const backupDir = (JSON.parse(backup.stdout) as { directory: string }).directory;
  writeJournal(options.prefix, { state: "switching", from, to: manifest.version, backup: path.basename(backupDir) });
  pointLink(options.prefix, "previous", from);
  pointLink(options.prefix, "current", manifest.version);
  log(`Starting ${manifest.version}…`);
  await options.service.start();
  const health = await options.service.healthy(manifest.version, options.healthTimeoutMs ?? 90_000);
  if (health.ok) {
    writeJournal(options.prefix, { state: "done", from, to: manifest.version, backup: path.basename(backupDir) });
    pruneReleases(options.prefix);
    log(`Updated ${from} → ${manifest.version}. The data before the update is in ${backupDir}.`);
    return { updated: true, from, to: manifest.version, backup: backupDir };
  }
  log(`${manifest.version} did not come up (${health.reason ?? "no answer"}): going back to ${from}.`);
  await rollback(options, { from, to: manifest.version, backup: path.basename(backupDir) });
  throw new UpdateError(`${manifest.version} did not start (${health.reason ?? "no answer"}). ${from} runs again with the data from before the update.`, "rolled_back");
};

/** Back to the previous release with the data from before the update (the failed state is kept aside). */
export const rollback = async (options: Pick<UpdateOptions, "prefix" | "dataDir" | "service" | "runner" | "log" | "healthTimeoutMs">, step: { from: string; to: string; backup: string }) => {
  const log = options.log ?? (() => undefined);
  writeJournal(options.prefix, { state: "rolling_back", ...step });
  await options.service.stop();
  pointLink(options.prefix, "current", step.from);
  const restored = await options.runner.run(path.join(releasesDir(options.prefix), step.to), ["restore", step.backup, "--data-dir", options.dataDir]);
  if (restored.status !== 0) log(`The data could not be restored automatically: ${restored.stderr.trim().slice(0, 300)}`);
  await options.service.start();
  const health = await options.service.healthy(step.from, options.healthTimeoutMs ?? 90_000);
  writeJournal(options.prefix, { state: health.ok ? "rolled_back" : "rollback_failed", ...step });
  if (!health.ok) throw new UpdateError(`${step.from} did not start again either (${health.reason ?? "no answer"}). See journalctl -u local-cognitive.`, "rollback_failed");
};

/** Keeps the running, the previous and the newest few releases. */
export const pruneReleases = (prefix: string, keep = RELEASES_KEPT) => {
  const kept = new Set([linkedRelease(prefix, "current"), linkedRelease(prefix, "previous")].filter(Boolean));
  const directory = releasesDir(prefix);
  const names = fs.readdirSync(directory).filter(name => !name.endsWith(".partial")).sort((a, b) => fs.statSync(path.join(directory, b)).mtimeMs - fs.statSync(path.join(directory, a)).mtimeMs);
  for (const name of names.slice(keep)) if (!kept.has(name)) fs.rmSync(path.join(directory, name), { recursive: true, force: true });
};

export { ManifestError };
