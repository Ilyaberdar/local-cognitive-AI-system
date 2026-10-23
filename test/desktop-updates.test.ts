import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildSync } from "esbuild";

const { registerUpdates, errorCode } = require(path.resolve("electron/updates.cjs"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");

type State = { phase: string; current: string; blocker?: string; error?: { stage: string; code: string }; available?: { version: string; size: number | null; notes: Array<{ version: string; html: string }> }; progress?: { percent: number } };

class FakeToken { cancelled = false; cancel() { this.cancelled = true; } }

// Resources folders with the updater's feed: a signed Windows build names its publisher there.
const feedFolder = (text: string) => { const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lc-feed-")); fs.writeFileSync(path.join(folder, "app-update.yml"), text); return folder; };
const signedFeed = feedFolder("owner: Ilyaberdar\nrepo: local-cognitive-AI-system\nprovider: github\npublisherName:\n  - Local Cognitive\n");
const unsignedFeed = feedFolder("owner: Ilyaberdar\nrepo: local-cognitive-AI-system\nprovider: github\n");

/** electron-updater as the main process sees it, scripted per test. */
const fakeUpdater = (script: { check?: () => Promise<unknown>; download?: (updater: EventEmitter, token: FakeToken) => Promise<unknown> } = {}) => {
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: true, fullChangelog: false, disableWebInstaller: false, logger: console as unknown,
    forceDevUpdateConfig: false, installs: [] as unknown[][], feed: undefined as unknown,
    getOrCreateStagingUserId: async () => "kept-in-userData",
    setFeedURL(options: unknown) { this.feed = options; },
    checkForUpdates: () => script.check ? script.check() : Promise.resolve({ isUpdateAvailable: false, updateInfo: { version: "0.1.0" } }),
    downloadUpdate(token: FakeToken) { return script.download ? script.download(updater, token) : Promise.resolve([]); },
    quitAndInstall(...args: unknown[]) { this.installs.push(args); }
  });
  return updater;
};

/** Electron's Notification as the updater sees it: the ones shown, and whether the system has any. */
const fakeNotifications = (supported = true) => {
  const shown: Array<EventEmitter & { options: { title: string; body: string } }> = [];
  class FakeNotification extends EventEmitter {
    static isSupported() { return supported; }
    constructor(readonly options: { title: string; body: string }) { super(); }
    show() { shown.push(this); }
  }
  return { Notification: FakeNotification, shown };
};

type SetupOptions = { packaged?: boolean; platform?: string; arch?: string; work?: { total: number; chatRuns?: number }; env?: Record<string, string>; updater?: ReturnType<typeof fakeUpdater>;
  resourcesPath?: string; appPath?: string; inApplications?: boolean; dataDir?: string; notifications?: ReturnType<typeof fakeNotifications>; powerMonitor?: EventEmitter;
  now?: () => number; random?: () => number; firstDelayMs?: number; intervalMs?: number };

const setup = (options: SetupOptions = {}) => {
  const handlers = new Map<string, (event: unknown, value?: unknown) => unknown>();
  const sent: State[] = [], recorded: Array<[string, unknown]> = [], order: string[] = [];
  const updater = options.updater ?? fakeUpdater();
  const notifications = options.notifications ?? fakeNotifications();
  let opened = 0;
  const app = { isPackaged: options.packaged ?? true, getVersion: () => "0.1.0", getAppPath: () => options.appPath ?? "/Applications/Local Cognitive.app/Contents/Resources/app",
    isInApplicationsFolder: () => options.inApplications ?? true };
  const registered = registerUpdates({
    app, ipcMain: { handle: (name: string, handler: (event: unknown, value?: unknown) => unknown) => handlers.set(name, handler) }, assertSender: () => undefined,
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: (_channel: string, state: State) => sent.push(state) } }),
    getBackend: () => ({ activeWork: () => options.work ?? { total: 0 } }),
    prepareForExit: async () => { order.push("prepare"); }, record: (event: string, fields: unknown) => recorded.push([event, fields]),
    platform: options.platform ?? "darwin", arch: options.arch ?? "arm64", env: options.env ?? {}, resourcesPath: options.resourcesPath ?? signedFeed,
    loadUpdater: () => ({ autoUpdater: updater, CancellationToken: FakeToken }),
    openUpdates: () => { opened++; }, Notification: notifications.Notification, powerMonitor: options.powerMonitor, dataDir: options.dataDir,
    ...(options.now ? { now: options.now } : {}), ...(options.random ? { random: options.random } : {}),
    ...(options.firstDelayMs !== undefined ? { firstDelayMs: options.firstDelayMs } : {}), ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {})
  });
  const call = (name: string, value?: unknown) => handlers.get(`updates:${name}`)!({}, value) as Promise<State & { started?: boolean; work?: unknown; state?: State }>;
  return { registered, updater, call, sent, recorded, order, shown: notifications.shown, opened: () => opened };
};

const release = { isUpdateAvailable: true, updateInfo: { version: "0.2.0", releaseDate: "2026-11-01T00:00:00Z",
  files: [{ url: "Local-Cognitive-0.2.0-mac.zip", size: 120 * 1024 ** 2 }, { url: "Local-Cognitive-0.2.0-arm64-mac.zip", size: 110 * 1024 ** 2 }, { url: "Local-Cognitive-0.2.0-arm64.dmg", size: 115 * 1024 ** 2 }],
  releaseNotes: [{ version: "0.2.0", note: "<p>Faster models</p>" }, { version: "0.1.1", note: "" }] } };

test("nothing is published yet: the app is up to date, not failing", async () => {
  const { call, recorded } = setup({ updater: fakeUpdater({ check: () => Promise.reject(Object.assign(new Error("No published versions"), { code: "ERR_XML_MISSED_ELEMENT" })) }) });
  const state = await call("check");
  assert.equal(state.phase, "up-to-date");
  assert.equal(state.error, undefined);
  assert.deepEqual(recorded, []);

  // Only prereleases of other things (the server's CUDA runtime): GitHub has no latest release, and
  // /releases/latest redirects to /releases, which answers JSON with 406. electron-updater wraps that
  // as an unreadable feed; built here with its own error helpers. Any other unreadable feed is still an error.
  const { createHttpError, newError } = require("builder-util-runtime");
  const feedError = (status: number, statusMessage: string) => {
    const answer = createHttpError({ statusCode: status, statusMessage, headers: { "content-type": "text/html" } }, "method: GET url: https://github.com/o/r/releases");
    const latest = newError(`Unable to find latest version on GitHub (https://github.com/o/r/releases/latest), please ensure a production release exists: ${answer.stack}`, "ERR_UPDATER_LATEST_VERSION_NOT_FOUND");
    return newError(`Cannot parse releases feed: ${latest.stack},\nXML:\n<feed/>`, "ERR_UPDATER_INVALID_RELEASE_FEED");
  };
  for (const [status, statusMessage] of [[406, "Not Acceptable"], [404, "Not Found"]] as const) {
    const runtimeOnly = setup({ updater: fakeUpdater({ check: () => Promise.reject(feedError(status, statusMessage)) }) });
    assert.equal((await runtimeOnly.call("check")).phase, "up-to-date", `HTTP ${status}`);
    assert.deepEqual(runtimeOnly.recorded, []);
  }
  for (const error of [feedError(500, "Internal Server Error"), feedError(403, "Forbidden"), Object.assign(new Error("Cannot parse releases feed: unexpected token"), { code: "ERR_UPDATER_INVALID_RELEASE_FEED" })]) {
    const broken = setup({ updater: fakeUpdater({ check: () => Promise.reject(error) }) });
    assert.deepEqual((await broken.call("check")).error, { stage: "check", code: "err_updater_invalid_release_feed" });
  }
});

test("check, download with progress, then the update is ready; nothing happens on its own", async () => {
  const updater = fakeUpdater({ check: () => Promise.resolve(release), download: async emitter => {
    for (const percent of [10, 55, 100]) { emitter.emit("download-progress", { percent, transferred: percent, total: 100, bytesPerSecond: 5 }); await delay(5); }
    return [];
  } });
  const { call, sent } = setup({ updater });
  const available = await call("check");
  assert.deepEqual([updater.autoDownload, updater.autoInstallOnAppQuit, updater.logger, updater.fullChangelog], [false, false, null, true], "the user drives it; no logs with URLs or paths");
  assert.equal(available.phase, "available");
  assert.deepEqual(available.available, { version: "0.2.0", date: "2026-11-01T00:00:00Z", size: 110 * 1024 ** 2, notes: [{ version: "0.2.0", html: "<p>Faster models</p>" }] },
    "this Mac's architecture's zip; empty notes left out");
  const ready = await call("download");
  assert.equal(ready.phase, "ready");
  assert.equal(ready.progress, undefined);
  assert.ok(sent.some(state => state.phase === "downloading" && state.progress), "progress reached the window");
  assert.deepEqual(updater.installs, [], "nothing installs before the user asks");
});

test("a download can be cancelled; a failed one says why, as a code", async () => {
  let release_: () => void = () => undefined;
  const cancellable = fakeUpdater({ check: () => Promise.resolve(release), download: (_emitter, token) => new Promise((_resolve, reject) => {
    release_ = () => reject(Object.assign(new Error("cancelled"), { name: "Error" }));
    void token;
  }) });
  const first = setup({ updater: cancellable });
  await first.call("check");
  const downloading = first.call("download");
  await delay(5);
  await first.call("cancel");
  release_();
  assert.equal((await downloading).phase, "available");
  assert.equal((await downloading).error, undefined, "a cancel is not an error");

  const broken = setup({ updater: fakeUpdater({ check: () => Promise.resolve(release),
    download: () => Promise.reject(Object.assign(new Error("sha512 checksum mismatch, expected abc for /Users/someone/Library/Caches/x.zip"), { code: "ERR_CHECKSUM_MISMATCH" })) }) });
  await broken.call("check");
  const failed = await broken.call("download");
  assert.deepEqual([failed.phase, failed.error], ["available", { stage: "download", code: "err_checksum_mismatch" }]);
  assert.deepEqual(broken.recorded, [["app.update_failed", { stage: "download", code: "err_checksum_mismatch", trigger: "user" }]]);
  assert.equal(JSON.stringify(failed).includes("/Users/"), false, "no path reaches the window");
});

test("restart and update asks first when local work runs; Windows shuts the backend down before the installer", async () => {
  const mac = setup({ updater: fakeUpdater({ check: () => Promise.resolve(release) }), work: { total: 2, chatRuns: 2 } });
  await mac.call("check"); await mac.call("download");
  const asked = await mac.call("install", false);
  assert.deepEqual([asked.started, asked.work], [false, { total: 2, chatRuns: 2 }]);
  assert.deepEqual(mac.updater.installs, []);
  const started = await mac.call("install", true);
  assert.equal(started.started, true);
  assert.deepEqual(mac.updater.installs, [[]], "macOS: Squirrel checks the signature, then quits");
  assert.deepEqual(mac.order, [], "macOS shuts down in before-quit");

  const windows = setup({ platform: "win32", updater: fakeUpdater({ check: () => Promise.resolve(release) }) });
  windows.updater.quitAndInstall = function (...args: unknown[]) { windows.order.push("installer"); this.installs.push(args); };
  await windows.call("check"); await windows.call("download");
  await windows.call("install", false);
  assert.deepEqual(windows.order, ["prepare", "installer"]);
  assert.deepEqual(windows.updater.installs, [[true, true]], "silent, then the new version starts");
});

test("Windows never installs an update whose signer it cannot check: until builds are signed, the new version is only shown", async () => {
  const unsigned = setup({ platform: "win32", resourcesPath: unsignedFeed, updater: fakeUpdater({ check: () => Promise.resolve(release) }) });
  assert.equal((await unsigned.call("state")).blocker, "windows-unsigned");
  assert.equal((await unsigned.call("check")).phase, "available", "the new version is still shown");
  assert.equal((await unsigned.call("download")).phase, "available", "but not downloaded");
  assert.deepEqual(unsigned.updater.installs, []);
  const signed = setup({ platform: "win32", resourcesPath: signedFeed, updater: fakeUpdater({ check: () => Promise.resolve(release) }) });
  assert.equal((await signed.call("state")).blocker, undefined, "signed builds name their publisher: the updater checks the installer");
});

test("a refused install on macOS (not our signature) keeps the app running and says so", async () => {
  const { call, updater } = setup({ updater: fakeUpdater({ check: () => Promise.resolve(release) }) });
  await call("check"); await call("download"); await call("install", true);
  updater.emit("error", new Error("Code signature at URL file:///Users/someone/Library/Caches/x/ShipIt/Local%20Cognitive.app/ did not pass validation"));
  const state = await call("state");
  assert.deepEqual([state.phase, state.error], ["idle", { stage: "install", code: "mac_signature" }]);
});

test("a development run has no updates unless pointed at a local feed, which never installs", async () => {
  const plain = setup({ packaged: false });
  const state = await plain.call("check");
  assert.deepEqual([state.phase, state.blocker], ["idle", "development"]);
  const feed = setup({ packaged: false, env: { LOCAL_COGNITIVE_UPDATE_FEED: "http://127.0.0.1:8765/" }, updater: fakeUpdater({ check: () => Promise.resolve(release) }) });
  assert.equal((await feed.call("check")).phase, "available");
  assert.deepEqual(feed.updater.feed, { provider: "generic", url: "http://127.0.0.1:8765/" });
  assert.equal(feed.updater.forceDevUpdateConfig, true);
  await feed.call("download");
  assert.equal((await feed.call("install", true)).started, false, "never installs over the development copy");
});

test("no lasting id goes to GitHub, and errors become codes without URLs or paths", async () => {
  const { updater, call } = setup();
  await call("check");
  const first = await updater.getOrCreateStagingUserId(), second = await updater.getOrCreateStagingUserId();
  assert.notEqual(first, "kept-in-userData");
  assert.notEqual(first, second, "a new random id each time, none kept");
  assert.equal(errorCode(new Error("net::ERR_INTERNET_DISCONNECTED at https://github.com/x")), "net_err_internet_disconnected");
  assert.equal(errorCode(Object.assign(new Error("HttpError: 404 /Users/x"), { code: "HTTP_ERROR_404" })), "http_error_404");
  assert.equal(errorCode(new Error("Cannot update while running on a read-only volume")), "mac_read_only_volume");
  assert.equal(errorCode(new Error("something at /Users/someone/secret")), "unknown");
});

test("the update panel: phases, what's new made harmless, progress in place, a confirmation before stopping work", async () => {
  const bundle = buildSync({ entryPoints: ["public/assets/updates-ui.js"], bundle: true, write: false, format: "iife", globalName: "UpdatesUi" }).outputFiles[0]!.text;
  const dom = new JSDOM('<div id="panel"></div>', { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(`${bundle}\nwindow.UpdatesUi = UpdatesUi;`);
  const ui = dom.window.UpdatesUi;
  const notes = [{ version: "0.2.0", html: '<p>Faster <a href="https://example.test/x" onclick="steal()">models</a></p><script>steal()</script><img src="https://tracker.test/p.gif"><a href="javascript:steal()">bad</a><div data-hovercard-url="x">kept text</div>' }];
  const available = { phase: "available", current: "0.1.0", available: { version: "0.2.0", date: null, size: 110 * 1024 ** 2, notes } };
  const html: string = ui.updatesHtml(available);
  assert.match(html, /Version 0\.2\.0 is available/);
  assert.match(html, /Download: 110\.0 MB\./);
  assert.doesNotMatch(html, /<script|onclick|<img|javascript:|data-hovercard/i, "no scripts, handlers, images or data attributes");
  assert.match(html, /<a href="https:\/\/example\.test\/x" target="_blank" rel="noopener noreferrer">models<\/a>/);
  assert.match(html, /kept text/);
  assert.match(ui.updatesHtml({ phase: "idle", current: "0.1.0", blocker: "development" }), /development run/);
  assert.match(ui.updatesHtml({ phase: "idle", current: "0.1.0", error: { stage: "install", code: "mac_signature" } }), /not signed by the developer/);
  assert.match(ui.updatesHtml({ phase: "up-to-date", current: "0.1.0", checkedAt: Date.now() }), /is up to date/);

  // Mounted: progress moves in place; restart asks while work runs.
  let listener: (state: unknown) => void = () => undefined;
  const installs: boolean[] = [];
  const bridge = {
    state: async () => available, check: async () => available, cancel: async () => available,
    download: async () => ({ ...available, phase: "downloading", progress: { percent: 5 } }),
    install: async (confirmed: boolean) => { installs.push(confirmed); return confirmed ? { started: true, state: { ...available, phase: "installing" } } : { started: false, work: { total: 2, chatRuns: 1, workflowRuns: 1 } }; },
    onChange: (callback: (state: unknown) => void) => { listener = callback; return () => undefined; }
  };
  const panel = dom.window.document.getElementById("panel");
  ui.mountUpdatesPanel(panel, { bridge });
  await delay(10);
  (panel.querySelector('[data-update-action="download"]') as HTMLButtonElement).click();
  await delay(10);
  const notesElement = panel.querySelector(".updates-notes");
  listener({ ...available, phase: "downloading", progress: { percent: 42, transferred: 42 * 1024 ** 2, total: 100 * 1024 ** 2, bytesPerSecond: 1024 ** 2 } });
  assert.equal((panel.querySelector("[data-update-progress]") as HTMLProgressElement).value, 42);
  assert.match(panel.querySelector("[data-update-progress-text]")!.textContent!, /^42\.0 MB of 100\.0 MB · 1\.0 MB\/s · 58 s left$/);
  assert.equal(panel.querySelector("[data-update-progress-percent]")!.textContent, "42%");
  assert.ok(panel.querySelector(".settings-row [data-update-progress]"), "the bar is in the card with what it says");
  assert.equal(panel.querySelector(".updates-notes"), notesElement, "what's new was not redrawn");
  listener({ ...available, phase: "ready" });
  (panel.querySelector('[data-update-action="install"]') as HTMLButtonElement).click();
  await delay(10);
  assert.match(panel.textContent!, /Running on this computer: 1 chat, 1 workflow\. Restarting stops it/);
  (panel.querySelector('[data-update-action="install-anyway"]') as HTMLButtonElement).click();
  await delay(10);
  assert.deepEqual(installs, [false, true]);
  assert.match(panel.textContent!, /Preparing the update/);
});

// Background checks and the notice. Tests shorten the schedule to milliseconds.
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "lc-updates-"));
const releaseOf = (version: string) => ({ ...release, updateInfo: { ...release.updateInfo, version } });
/** An updater whose checks are counted; each answers with what `answer` gives at that moment. */
const countingUpdater = (answer: () => Promise<unknown>) => {
  const counter = { checks: 0, stagingIds: [] as unknown[] };
  const updater: ReturnType<typeof fakeUpdater> = fakeUpdater({ check: () => {
    counter.checks++;
    counter.stagingIds.push((updater as unknown as { requestHeaders?: Record<string, string> }).requestHeaders?.["x-user-staging-id"]);
    return answer();
  } });
  return { counter, updater };
};
const upToDate = { isUpdateAvailable: false, updateInfo: { version: "0.1.0" } };

test("an installed app looks for a new version by itself and announces each version once, across restarts", async () => {
  const dataDir = tempDir();
  let offered: unknown = release;
  const { updater, counter } = countingUpdater(async () => offered);
  const first = setup({ updater, dataDir, firstDelayMs: 0, intervalMs: 40 });
  first.registered.start();
  await delay(20);
  assert.equal(first.sent.at(-1)?.phase, "available");
  assert.equal(first.sent.at(-1)?.available?.version, "0.2.0");
  assert.equal(first.shown.length, 1);
  assert.deepEqual(first.shown[0]!.options, { title: "Local Cognitive", body: "Version 0.2.0 is available. Click to see what's new." });
  first.shown[0]!.emit("click");
  assert.equal(first.opened(), 1, "a click opens Settings → About");
  await delay(100);
  assert.ok(counter.checks >= 2, "it keeps looking every interval");
  assert.ok(counter.stagingIds.every(id => typeof id === "string") && new Set(counter.stagingIds).size === counter.stagingIds.length, "each check carries a new random id");
  assert.equal(first.shown.length, 1, "the same version is announced once");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "update-notice.json"), "utf8")).version, "0.2.0");
  first.registered.dispose();
  const checks = counter.checks;
  await delay(100);
  assert.equal(counter.checks, checks, "no more checks after dispose");

  // After a restart the version is still shown in the window, but the system does not say it again.
  const second = setup({ updater: countingUpdater(async () => offered).updater, dataDir, firstDelayMs: 0, intervalMs: 40 });
  second.registered.start();
  await delay(20);
  assert.equal(second.sent.at(-1)?.available?.version, "0.2.0");
  assert.equal(second.shown.length, 0);
  offered = releaseOf("0.3.0");
  await delay(100);
  assert.equal(second.shown.length, 1, "a newer version is announced");
  assert.match(second.shown[0]!.options.body, /^Version 0\.3\.0 is available\./);
  second.registered.dispose();
});

test("background checks stay quiet: up to date, nothing published or a failure changes nothing in the window", async () => {
  for (const answer of [async () => upToDate, () => Promise.reject(Object.assign(new Error("No published versions"), { code: "ERR_XML_MISSED_ELEMENT" }))]) {
    const quiet = setup({ updater: fakeUpdater({ check: answer }) });
    await quiet.registered.backgroundCheck();
    assert.deepEqual(quiet.sent, [], "the window was told nothing");
    assert.deepEqual(quiet.recorded, []);
    assert.equal(quiet.shown.length, 0);
  }
  const offline = setup({ updater: fakeUpdater({ check: () => Promise.reject(new Error("net::ERR_INTERNET_DISCONNECTED")) }) });
  await offline.registered.backgroundCheck();
  assert.deepEqual(offline.sent, []);
  assert.deepEqual(offline.recorded, [["app.update_failed", { stage: "check", code: "net_err_internet_disconnected", trigger: "background" }]], "only the technical log knows");
  assert.equal((await offline.call("state")).error, undefined);
});

test("a check the user starts during a background one asks once and shows the user its result", async () => {
  let fail!: (error: Error) => void;
  const { updater, counter } = countingUpdater(() => new Promise((_resolve, reject) => { fail = reject; }));
  const { registered, call, recorded } = setup({ updater });
  const background = registered.backgroundCheck();
  const user = call("check");
  await delay(5);
  fail(new Error("net::ERR_TIMED_OUT"));
  await background;
  const state = await user;
  assert.equal(counter.checks, 1, "one request to GitHub");
  assert.deepEqual(state.error, { stage: "check", code: "net_err_timed_out" });
  assert.deepEqual(recorded, [["app.update_failed", { stage: "check", code: "net_err_timed_out", trigger: "user" }]], "reported once, by the user's check");
});

test("no background check while downloading or ready to install; a download waits for a check still running", async () => {
  let finishDownload!: () => void;
  const { updater, counter } = countingUpdater(async () => release);
  updater.downloadUpdate = () => new Promise(resolve => { finishDownload = () => resolve([]); });
  const busy = setup({ updater });
  await busy.call("check");
  const downloading = busy.call("download");
  await delay(5);
  await busy.registered.backgroundCheck();
  assert.equal(counter.checks, 1, "not while downloading");
  finishDownload();
  assert.equal((await downloading).phase, "ready");
  await busy.registered.backgroundCheck();
  assert.equal(counter.checks, 1, "not while an update waits to install");

  let answer!: (value: unknown) => void, calls = 0, downloadStarted = false;
  const later = fakeUpdater({ check: () => ++calls === 1 ? Promise.resolve(release) : new Promise(resolve => { answer = resolve; }) });
  later.downloadUpdate = async () => { downloadStarted = true; return []; };
  const waiting = setup({ updater: later });
  await waiting.call("check");
  const background = waiting.registered.backgroundCheck();
  const download = waiting.call("download");
  await delay(10);
  assert.equal(downloadStarted, false, "the download waits for the check's answer");
  answer(releaseOf("0.2.1"));
  await background;
  assert.equal((await download).phase, "ready");
  assert.ok(downloadStarted);
});

test("a development run never looks by itself, and LOCAL_COGNITIVE_UPDATE_CHECK=off turns the schedule off", async () => {
  for (const options of [{ packaged: false }, { env: { LOCAL_COGNITIVE_UPDATE_CHECK: "off" } }]) {
    const { updater, counter } = countingUpdater(async () => release);
    const { registered } = setup({ ...options, updater, firstDelayMs: 0, intervalMs: 20 });
    registered.start();
    await delay(60);
    assert.equal(counter.checks, 0);
    registered.dispose();
  }
  // Pointed at a local feed, a development run does look: that is how the schedule is tried out.
  const { updater, counter } = countingUpdater(async () => release);
  const feed = setup({ packaged: false, env: { LOCAL_COGNITIVE_UPDATE_FEED: "http://127.0.0.1:8765/" }, updater, firstDelayMs: 0, intervalMs: 1000 });
  feed.registered.start();
  await delay(20);
  assert.equal(counter.checks, 1);
  feed.registered.dispose();
});

test("the notice says what to do when the app cannot install an update itself; a version found by Check is not announced", async () => {
  const windows = setup({ platform: "win32", resourcesPath: unsignedFeed, updater: fakeUpdater({ check: async () => release }) });
  await windows.registered.backgroundCheck();
  assert.equal(windows.shown[0]!.options.body, "Version 0.2.0 is available. Click to see how to get it.");
  const fromDiskImage = setup({ appPath: "/Volumes/Local Cognitive/Local Cognitive.app/Contents/Resources/app", inApplications: false, updater: fakeUpdater({ check: async () => release }) });
  await fromDiskImage.registered.backgroundCheck();
  assert.equal(fromDiskImage.shown[0]!.options.body, "Version 0.2.0 is available. Move Local Cognitive to Applications to install it.");
  const unsupported = setup({ notifications: fakeNotifications(false), updater: fakeUpdater({ check: async () => release }) });
  await unsupported.registered.backgroundCheck();
  assert.equal(unsupported.sent.at(-1)?.phase, "available", "the window shows it without system notifications");
  assert.equal(unsupported.shown.length, 0);

  const dataDir = tempDir();
  const seen = setup({ dataDir, updater: fakeUpdater({ check: async () => release }) });
  await seen.call("check");
  await seen.registered.backgroundCheck();
  assert.equal(seen.shown.length, 0, "the user saw it already");
  const restarted = setup({ dataDir, updater: fakeUpdater({ check: async () => release }) });
  await restarted.registered.backgroundCheck();
  assert.equal(restarted.shown.length, 0);
});

test("after the computer wakes, a check that came due runs soon", async () => {
  const power = new EventEmitter();
  let clock = 1_000_000;
  const { updater, counter } = countingUpdater(async () => upToDate);
  const { registered } = setup({ updater, powerMonitor: power, now: () => clock, firstDelayMs: 60_000, intervalMs: 30 });
  registered.start();
  await delay(10);
  assert.equal(counter.checks, 0, "the first check is still a minute away");
  clock += 31;   // asleep for longer than an interval: timers did not run meanwhile
  power.emit("resume");
  await delay(50);
  assert.ok(counter.checks >= 1);
  registered.dispose();
  assert.equal(power.listenerCount("resume"), 0);
});

test("the top bar's update button: only when there is something to do, progress in place, said once to a screen reader", async () => {
  const bundle = buildSync({ entryPoints: ["public/assets/updates-ui.js"], bundle: true, write: false, format: "iife", globalName: "UpdatesUi" }).outputFiles[0]!.text;
  const dom = new JSDOM("<header><span data-update-pill></span></header>", { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(`${bundle}\nwindow.UpdatesUi = UpdatesUi;`);
  const ui = dom.window.UpdatesUi;
  const available = { phase: "available", current: "0.1.0", available: { version: "0.2.0", notes: [] } };
  assert.equal(ui.updatePillText(available), "Update to 0.2.0");
  for (const phase of ["idle", "checking", "up-to-date", "installing"]) assert.equal(ui.updatePillText({ ...available, phase }), null, phase);
  assert.equal(ui.updatePillText({ ...available, blocker: "development" }), null);
  assert.equal(ui.updatePillText({ ...available, blocker: "windows-unsigned" }), "Version 0.2.0 available");
  assert.equal(ui.updatePillText({ ...available, phase: "downloading", progress: { percent: 41.6 } }), "Downloading 42%");
  assert.equal(ui.updatePillText({ ...available, phase: "ready" }), "Restart to update");
  assert.doesNotMatch(ui.updatePillHtml({ ...available, available: { version: '<img src=x onerror="steal()">' } }), /<img/);
  assert.match(ui.updatePillHtml(available), /<a id="update-pill" class="update-pill" href="#\/settings\/about"/);

  let listener: (state: unknown) => void = () => undefined, open: () => void = () => undefined;
  const opened: string[] = [];
  const pill = ui.createUpdatePill({ doc: dom.window.document, onOpen: () => opened.push("about"), bridge: {
    state: async () => ({ phase: "idle", current: "0.1.0" }), onChange: (callback: typeof listener) => { listener = callback; }, onOpen: (callback: () => void) => { open = callback; } } });
  await delay(5);
  const slot = dom.window.document.querySelector("[data-update-pill]")!;
  const status = dom.window.document.querySelector('[role="status"]')!;
  assert.equal(slot.textContent, "");
  assert.equal(pill.html(), "");
  listener(available);
  assert.equal(slot.textContent, "Update to 0.2.0");
  assert.equal(status.textContent, "Version 0.2.0 is available.");
  listener({ ...available, phase: "downloading", progress: { percent: 10 } });
  const link = slot.querySelector("#update-pill");
  listener({ ...available, phase: "downloading", progress: { percent: 42 } });
  assert.equal(slot.textContent, "Downloading 42%");
  assert.equal(slot.querySelector("#update-pill"), link, "progress changes the words, not the button");
  assert.equal(status.textContent, "Version 0.2.0 is available.", "progress is not read out");
  listener({ ...available, phase: "ready" });
  assert.equal(slot.textContent, "Restart to update");
  assert.equal(status.textContent, "Version 0.2.0 is ready to install.");
  assert.match(pill.html(), /Restart to update/);
  open();
  assert.deepEqual(opened, ["about"], "the notification's click opens Settings → About");
});

