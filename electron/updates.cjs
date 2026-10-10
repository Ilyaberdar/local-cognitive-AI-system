const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");

// Desktop updates (Settings → About, and a button in the top bar while one waits). An installed app
// looks for a new version shortly after launch and every 6 hours, and announces each new version
// once with a system notification; downloading and installing happen only when the user presses
// the buttons. Releases come from the public GitHub repository without a token (github.com's feed
// and assets, never api.github.com). macOS installs only an update signed with the same Developer ID
// (Squirrel checks it); Windows checks the signer once the builds are signed (publisherName in
// app-update.yml).

/** Errors that mean no app release is published yet: the app is as new as it gets. Releases of other
 * things only (the server's CUDA runtime is a prerelease) leave GitHub without a latest release:
 * /releases/latest then redirects to /releases, which answers the updater's JSON request with 406, and
 * the updater reports its feed as unreadable with that answer inside. */
const NO_RELEASE = new Set(["ERR_XML_MISSED_ELEMENT", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND"]);
const LATEST_MISSING = /Unable to find latest version on GitHub \([^)]*\), please ensure a production release exists: HttpError: 40[46]\b/;
const noRelease = error => NO_RELEASE.has(error?.code)
  || (error?.code === "ERR_UPDATER_INVALID_RELEASE_FEED" && LATEST_MISSING.test(String(error?.message)));
const NOTES_LIMIT = 64 * 1024;
const HOUR = 60 * 60 * 1000;
/** Phases in which a background check may look: nothing the user started is under way. */
const QUIET = new Set(["idle", "up-to-date", "available"]);
/** The version announced last, in the app's data folder: once per version, across restarts. */
const NOTICE_FILE = "update-notice.json";

/** A code for the window and the technical log: never a message, a URL or a path. */
const errorCode = error => {
  const code = String(error?.code ?? ""), message = String(error?.message ?? "");
  if (/^(ERR_[A-Z0-9_]+|HTTP_ERROR_\d{3})$/.test(code)) return code.toLowerCase();
  if (/did not pass validation|Could not get code signature/.test(message)) return "mac_signature";
  if (/read-only volume/.test(message)) return "mac_read_only_volume";
  const network = /net::(ERR_[A-Z_]+)/.exec(message);
  return network ? `net_${network[1].toLowerCase()}` : "unknown";
};

/** What's new, newest first: at most ten versions, each bounded (the window sanitizes the HTML). */
const releaseNotes = info => (Array.isArray(info.releaseNotes) ? info.releaseNotes : [{ version: info.version, note: info.releaseNotes }])
  .filter(entry => typeof entry?.note === "string" && entry.note.trim())
  .slice(0, 10)
  .map(entry => ({ version: String(entry.version ?? info.version), html: entry.note.slice(0, NOTES_LIMIT) }));

/** The download size for this computer: the zip of its architecture on macOS, the installer on Windows. */
const downloadSize = (info, platform, arch) => {
  const files = Array.isArray(info.files) ? info.files : [];
  const file = platform === "darwin"
    ? files.find(entry => entry.url?.endsWith(".zip") && entry.url.includes("arm64") === (arch === "arm64")) ?? files.find(entry => entry.url?.endsWith(".zip"))
    : files.find(entry => entry.url?.endsWith(".exe"));
  return typeof file?.size === "number" ? file.size : null;
};

/** Whether this build's update feed names the Windows publisher: only then does the updater check the
 * installer's Authenticode signature before running it (electron-builder writes it once builds are signed). */
const feedNamesPublisher = resourcesPath => {
  try { return /^\s*publisherName\s*:/m.test(fs.readFileSync(path.join(resourcesPath, "app-update.yml"), "utf8")); } catch { return false; }
};

/** What the system notification says about a new version. */
const noticeText = (version, blocker) => blocker === "windows-unsigned" ? `Version ${version} is available. Click to see how to get it.`
  : blocker === "move-to-applications" ? `Version ${version} is available. Move Local Cognitive to Applications to install it.`
  : `Version ${version} is available. Click to see what's new.`;

function registerUpdates({ app, ipcMain, assertSender, getWindow, getBackend, prepareForExit, record, openUpdates, Notification, powerMonitor, dataDir,
  platform = process.platform, arch = process.arch, env = process.env, resourcesPath = process.resourcesPath, loadUpdater = () => require("electron-updater"),
  now = Date.now, random = Math.random, firstDelayMs, intervalMs = 6 * HOUR }) {
  const development = !app.isPackaged;
  // A development run checks against a local feed only (and never installs); otherwise it has no updates.
  const developmentFeed = development ? env.LOCAL_COGNITIVE_UPDATE_FEED : undefined;
  const appPath = app.getAppPath();
  // Windows: until the builds are signed, nothing would check who made a downloaded installer, so a
  // changed one would run. The new version is shown, and comes from the website instead.
  const blocker = development && !developmentFeed ? "development"
    : platform === "win32" && !development && !feedNamesPublisher(resourcesPath) ? "windows-unsigned"
    : platform === "darwin" && !development && !app.isInApplicationsFolder?.() && /\/AppTranslocation\/|^\/Volumes\//.test(appPath) ? "move-to-applications" : undefined;
  // idle | checking | up-to-date | available | downloading | ready | installing, with `error` beside any.
  let state = { phase: "idle", current: app.getVersion(), ...(blocker ? { blocker } : {}) };
  let updater, token, sentAt = 0, inflight, timer, lastCheckAt = 0, started = false, notification;
  const noticeFile = dataDir ? path.join(dataDir, NOTICE_FILE) : undefined;
  let announced = (() => { try { return noticeFile && JSON.parse(fs.readFileSync(noticeFile, "utf8")).version; } catch { return undefined; } })();

  const send = () => { const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send("updates:changed", state); };
  const set = (patch, throttle = false) => {
    state = { ...state, ...patch };
    for (const key of Object.keys(patch)) if (patch[key] === undefined) delete state[key];
    if (throttle && now() - sentAt < 250) return;
    sentAt = now();
    send();
  };
  const fail = (stage, error, phase) => {
    const code = errorCode(error);
    record?.("app.update_failed", { stage, code, trigger: "user" });
    set({ phase, error: { stage, code }, progress: undefined });
  };

  const load = () => {
    if (updater) return updater;
    updater = loadUpdater().autoUpdater;
    updater.autoDownload = false;          // the user presses Download
    updater.autoInstallOnAppQuit = false;  // macOS: otherwise Squirrel installs on any quit
    updater.allowDowngrade = false;
    updater.fullChangelog = true;          // what's new in every version since this one
    updater.disableWebInstaller = true;
    updater.logger = null;                 // its lines carry URLs and paths
    // No lasting id for GitHub: staged rollouts are not used, so each run sends a new random one
    // instead of the id the updater would keep in userData/.updaterId (and each check another, see query).
    updater.getOrCreateStagingUserId = async () => randomUUID();
    if (developmentFeed) { updater.forceDevUpdateConfig = true; updater.setFeedURL({ provider: "generic", url: developmentFeed }); }
    updater.on("download-progress", progress => set({ progress: { percent: progress.percent, transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond } }, true));
    // Pending calls handle their own errors. Squirrel's (macOS: the new version's signature, a read-only
    // volume) arrive only here, after the download: the app keeps running and says so.
    updater.on("error", error => { if (state.phase === "installing" || state.phase === "ready") fail("install", error, "idle"); });
    return updater;
  };

  // One request at a time: a check the user starts during a background one shares its answer. Each
  // carries a new random staging id, so GitHub cannot link the checks of one run either.
  const query = () => inflight ??= (async () => {
    const instance = load();
    instance.requestHeaders = { ...instance.requestHeaders, "x-user-staging-id": randomUUID() };
    lastCheckAt = now();
    return instance.checkForUpdates();
  })().finally(() => { inflight = undefined; });

  const availableFrom = info => ({ version: String(info.version), date: info.releaseDate ?? null, size: downloadSize(info, platform, arch), notes: releaseNotes(info) });

  /** Notes a version as announced: written whole and renamed; if that fails, this run still remembers. */
  const remember = version => {
    announced = version;
    if (!noticeFile) return;
    const temporary = `${noticeFile}.${process.pid}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify({ version, at: new Date(now()).toISOString() }), { mode: 0o600 }); fs.renameSync(temporary, noticeFile); }
    catch { try { fs.rmSync(temporary, { force: true }); } catch { /* nothing to clean up */ } }
  };
  /** A new version, said once: a system notification that opens Settings → About when clicked. */
  const announce = version => {
    if (announced === version) return;
    remember(version);
    try {
      if (!Notification?.isSupported?.()) return;
      // Kept for the whole run: a notification that is collected disappears from Notification Center.
      notification = new Notification({ title: "Local Cognitive", body: noticeText(version, state.blocker) });
      notification.on("click", () => openUpdates?.());
      notification.show();
    } catch { /* A courtesy: the button in the window still says it. */ }
  };

  async function check() {
    if (state.blocker === "development" || ["checking", "downloading", "ready", "installing"].includes(state.phase)) return state;
    set({ phase: "checking", error: undefined });
    try {
      const result = await query();
      const info = result?.updateInfo;
      if (!result?.isUpdateAvailable || !info) set({ phase: "up-to-date", checkedAt: now(), available: undefined });
      else {
        set({ phase: "available", checkedAt: now(), available: availableFrom(info) });
        // The user is looking at it already: no notification for this version later.
        if (announced !== state.available.version) remember(state.available.version);
      }
    } catch (error) {
      if (noRelease(error)) set({ phase: "up-to-date", checkedAt: now(), available: undefined });
      else fail("check", error, "idle");
    }
    return state;
  }

  /** A check nobody asked for: the window changes only for a new version, which the system then
   * announces. Its failures go to the technical log, never to the window. */
  async function backgroundCheck() {
    if (!QUIET.has(state.phase)) return;
    try {
      const result = await query();
      const info = result?.updateInfo;
      // Up to date, or the user started something meanwhile: the window stays as it is.
      if (!result?.isUpdateAvailable || !info || !QUIET.has(state.phase)) return;
      if (state.phase !== "available" || state.available?.version !== String(info.version)) {
        set({ phase: "available", checkedAt: now(), available: availableFrom(info), ...(state.error?.stage === "check" ? { error: undefined } : {}) });
      }
      announce(state.available.version);
    } catch (error) {
      // A check the user started meanwhile shares this answer and reports it itself.
      if (!noRelease(error) && QUIET.has(state.phase)) record?.("app.update_failed", { stage: "check", code: errorCode(error), trigger: "background" });
    }
  }

  async function download() {
    // The download uses the release found by the last check: one still running finishes first.
    if (inflight) await inflight.catch(() => undefined);
    if (state.phase !== "available" || state.blocker) return state;
    token = new (loadUpdater().CancellationToken)();
    set({ phase: "downloading", error: undefined, progress: { percent: 0 } });
    try {
      // The sha512 from the release is checked; a download kept from before is reused.
      await load().downloadUpdate(token);
      set({ phase: "ready", progress: undefined });
    } catch (error) {
      if (token.cancelled) set({ phase: "available", progress: undefined });
      else fail("download", error, "available");
    } finally { token = undefined; }
    return state;
  }

  async function install(confirmed) {
    if (state.phase !== "ready" || development || state.blocker) return { started: false, state };
    // Work running on this computer stops with a restart: the window asks first. Runs on a server go on.
    const work = getBackend()?.activeWork?.();
    if (work?.total > 0 && !confirmed) return { started: false, work, state };
    set({ phase: "installing", error: undefined });
    if (platform === "win32") {
      // The installer closes the app about a second after it starts and kills it shortly after:
      // the backend is shut down first.
      await prepareForExit();
      load().quitAndInstall(true, true);   // silent, then the new version starts
    } else {
      // macOS: Squirrel unpacks the update and checks its Developer ID signature first (seconds); only
      // then are the windows closed and the app quit. before-quit shuts the backend down; ShipIt waits.
      load().quitAndInstall();
    }
    return { started: true, state };
  }

  // Shortly after launch (spread over 10–30 s), then every 6 hours give or take a few minutes.
  const schedule = delay => {
    clearTimeout(timer);
    timer = setTimeout(() => void backgroundCheck().finally(() => { if (started) schedule(intervalMs * (0.96 + random() * 0.08)); }), delay);
    timer.unref?.();
  };
  // Timers count only time awake: after a sleep, a check that came due runs a minute after waking.
  const resumed = () => { if (started && (now() - lastCheckAt >= intervalMs || now() < lastCheckAt)) schedule(Math.min(60_000, intervalMs)); };

  /** Background checks: an installed app, or a development run pointed at a local feed. */
  function start() {
    if (started || state.blocker === "development" || env.LOCAL_COGNITIVE_UPDATE_CHECK === "off") return;
    started = true;
    schedule(firstDelayMs ?? 10_000 + random() * 20_000);
    powerMonitor?.on?.("resume", resumed);
  }
  function dispose() {
    started = false;
    clearTimeout(timer);
    powerMonitor?.removeListener?.("resume", resumed);
  }

  const handle = (name, action) => ipcMain.handle(`updates:${name}`, (event, value) => { assertSender(event); return action(value); });
  handle("state", () => state);
  handle("check", check);
  handle("download", download);
  handle("cancel", () => { token?.cancel(); return state; });
  handle("install", value => install(value === true));
  return { state: () => state, check, backgroundCheck, download, install, start, dispose };
}

module.exports = { registerUpdates, errorCode, releaseNotes, downloadSize, noticeText };
