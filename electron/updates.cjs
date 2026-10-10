const { randomUUID } = require("crypto");

// Desktop updates (Settings → About), driven by the user: check, read what's new, download, then
// "Restart and update". Nothing is checked, downloaded or installed on its own. Releases come from the
// public GitHub repository without a token (github.com's feed and assets, never api.github.com).
// macOS installs only an update signed with the same Developer ID (Squirrel checks it); Windows
// checks the signer once the builds are signed (publisherName in app-update.yml).

/** Errors that mean nothing is published yet: the app is as new as it gets. */
const NO_RELEASE = new Set(["ERR_XML_MISSED_ELEMENT", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND"]);
const NOTES_LIMIT = 64 * 1024;

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

function registerUpdates({ app, ipcMain, assertSender, getWindow, getBackend, prepareForExit, record,
  platform = process.platform, arch = process.arch, env = process.env, loadUpdater = () => require("electron-updater") }) {
  const development = !app.isPackaged;
  // A development run checks against a local feed only (and never installs); otherwise it has no updates.
  const developmentFeed = development ? env.LOCAL_COGNITIVE_UPDATE_FEED : undefined;
  const appPath = app.getAppPath();
  const blocker = development && !developmentFeed ? "development"
    : platform === "darwin" && !development && !app.isInApplicationsFolder?.() && /\/AppTranslocation\/|^\/Volumes\//.test(appPath) ? "move-to-applications" : undefined;
  // idle | checking | up-to-date | available | downloading | ready | installing, with `error` beside any.
  let state = { phase: "idle", current: app.getVersion(), ...(blocker ? { blocker } : {}) };
  let updater, token, sentAt = 0;

  const send = () => { const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send("updates:changed", state); };
  const set = (patch, throttle = false) => {
    state = { ...state, ...patch };
    for (const key of Object.keys(patch)) if (patch[key] === undefined) delete state[key];
    if (throttle && Date.now() - sentAt < 250) return;
    sentAt = Date.now();
    send();
  };
  const fail = (stage, error, phase) => {
    const code = errorCode(error);
    record?.("app.update_failed", { stage, code });
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
    // instead of the id the updater would keep in userData/.updaterId.
    updater.getOrCreateStagingUserId = async () => randomUUID();
    if (developmentFeed) { updater.forceDevUpdateConfig = true; updater.setFeedURL({ provider: "generic", url: developmentFeed }); }
    updater.on("download-progress", progress => set({ progress: { percent: progress.percent, transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond } }, true));
    // Pending calls handle their own errors. Squirrel's (macOS: the new version's signature, a read-only
    // volume) arrive only here, after the download: the app keeps running and says so.
    updater.on("error", error => { if (state.phase === "installing" || state.phase === "ready") fail("install", error, "idle"); });
    return updater;
  };

  async function check() {
    if (state.blocker === "development" || ["checking", "downloading", "installing"].includes(state.phase)) return state;
    set({ phase: "checking", error: undefined });
    try {
      const result = await load().checkForUpdates();
      const info = result?.updateInfo;
      if (!result?.isUpdateAvailable || !info) set({ phase: "up-to-date", checkedAt: Date.now(), available: undefined });
      else set({ phase: "available", checkedAt: Date.now(),
        available: { version: String(info.version), date: info.releaseDate ?? null, size: downloadSize(info, platform, arch), notes: releaseNotes(info) } });
    } catch (error) {
      if (NO_RELEASE.has(error?.code)) set({ phase: "up-to-date", checkedAt: Date.now(), available: undefined });
      else fail("check", error, "idle");
    }
    return state;
  }

  async function download() {
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
    if (state.phase !== "ready" || development) return { started: false, state };
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

  const handle = (name, action) => ipcMain.handle(`updates:${name}`, (event, value) => { assertSender(event); return action(value); });
  handle("state", () => state);
  handle("check", check);
  handle("download", download);
  handle("cancel", () => { token?.cancel(); return state; });
  handle("install", value => install(value === true));
  return { state: () => state, check, download, install };
}

module.exports = { registerUpdates, errorCode, releaseNotes, downloadSize };
