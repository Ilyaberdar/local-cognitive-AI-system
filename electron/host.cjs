const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveAccountConfig } = require("../dist/src/account/accountConfig.js");
const { createHostOperations, startHostAgent } = require("../dist/src/remote/host/hostRuntime.js");
const { RemoteHostStore } = require("../dist/src/remote/host/RemoteHostStore.js");
const { deviceApprovalRefusal } = require("../dist/src/remote/host/deviceApprovals.js");
const { setHostPlace } = require("../dist/src/runtime/hostPlace.js");
const { addAdminFolder, listAdminFolders, MANAGED_ROOT_ID, removeAdminFolder, setAdminFolderOptions } = require("../dist/src/runtime/hostFolders.js");
const { connectionKeyQr, PHONE_APP_SHIPPED, qrSvg } = require("../dist/src/remote/qr/connectionKeyQr.js");
const { publicError } = require("../dist/src/runtime/publicError.js");
const { appVersion } = require("../dist/src/utils/appVersion.js");
const { Logger } = require("../dist/src/utils/Logger.js");
const { readSettings, SWITCHES, writeSettings } = require("./host-settings.cjs");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = value => { if (typeof value !== "string" || !UUID.test(value)) throw Object.assign(new Error("Invalid id."), { code: "invalid_request" }); return value; };
const failure = (message, code) => Object.assign(new Error(message), { code });
const KEY_TTL_MS = 10 * 60_000;
const busyStates = ["starting", "registering", "connecting"];

// This computer as a Remote host: paired devices reach it through Local Cognitive Cloud while the
// app runs and hosting is on. It belongs to the account signed in here: another account's key is
// refused, and signing out pauses it. The host key and grants live in the app's vault and host.db;
// the renderer gets statuses, the connection key it shows, and device names, never a path or token.
function registerHost({ app, ipcMain, dialog, shell, vault, accountService, backend, dataRoot, assertSender, getWindow, powerSaveBlocker, showQr = PHONE_APP_SHIPPED,
  powerMonitor, Tray, Menu, nativeImage, Notification, openWindow = () => undefined, platform = process.platform,
  cloudUrl = resolveAccountConfig({ env: process.env, packaged: app.isPackaged }).cloudUrl, logger = new Logger(),
  hostName = os.hostname().replace(/\.local$/, "").slice(0, 120) || "Computer" }) {
  // What devices are told names this computer, not "the server".
  setHostPlace(hostName);
  const file = path.join(dataRoot, "remote-host.json");
  let settings = readSettings(file);
  const store = backend.host ? new RemoteHostStore(backend.host.database) : undefined;
  let agent, composition, blocker, paused, startError, disposed = false;
  let queue = Promise.resolve();
  const serial = task => (queue = queue.then(task, task));
  const signedIn = () => { const status = accountService.status(); return status.state === "signed-in" ? status.profile.accountId : undefined; };

  const status = () => {
    const agentStatus = agent?.status();
    const connected = new Set((agent?.connectedDevices() ?? []).map(device => device.deviceId));
    const { backgroundNoticeShown: _note, ...switches } = settings;
    return {
      available: Boolean(store && cloudUrl), ...switches, hostName, openAtLoginAvailable: loginItemAvailable(),
      ...(loginItemNeedsApproval() ? { openAtLoginNeedsApproval: true } : {}),
      state: agentStatus?.state ?? (settings.enabled ? "paused" : "off"),
      ...(!agent && settings.enabled && paused ? { reason: paused } : {}),
      ...(agentStatus?.lastError || startError ? { lastError: agentStatus?.lastError ?? startError } : {}),
      devices: (store?.grants() ?? []).filter(grant => grant.status === "active").map(grant => ({ deviceId: grant.deviceId, name: grant.deviceName ?? "Device",
        grantedAt: grant.grantedAt, ...(grant.lastConnectedAt ? { lastConnectedAt: grant.lastConnectedAt } : {}), connected: connected.has(grant.deviceId) }))
    };
  };
  const emit = () => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send("remote-host:changed", status());
    syncTray();
  };

  // Open at login, only for the installed app (a development run would register Electron itself).
  // Windows starts it with --background; macOS tells it by wasOpenedAtLogin. Either way no window.
  const loginItemAvailable = () => Boolean(app.isPackaged && typeof app.setLoginItemSettings === "function" && (platform === "darwin" || platform === "win32"));
  const loginItemNeedsApproval = () => {
    if (!loginItemAvailable() || platform !== "darwin" || !settings.openAtLogin) return false;
    try { return app.getLoginItemSettings({ type: "mainAppService" }).status === "requires-approval"; } catch { return false; }
  };
  const applyLoginItem = () => {
    if (!loginItemAvailable()) return;
    const openAtLogin = settings.enabled && settings.openAtLogin;
    try { app.setLoginItemSettings(platform === "darwin" ? { openAtLogin, type: "mainAppService" } : { openAtLogin, args: ["--background"] }); }
    catch (error) { logger.warn("Open at login could not be changed", { message: error instanceof Error ? error.message : String(error) }); }
  };

  // While hosting is on: the menu bar (macOS) or the tray (Windows), which is how the app is reached
  // with no window open, and how it is quit on Windows then.
  let tray;
  const trayLine = () => {
    const { state, reason, devices } = status();
    if (state === "online") return `Remote: online · ${devices.length} device${devices.length === 1 ? "" : "s"}${devices.some(device => device.connected) ? `, ${devices.filter(device => device.connected).length} connected` : ""}`;
    if (busyStates.includes(state)) return "Remote: connecting…";
    if (state === "offline") return "Remote: offline, retrying";
    return reason === "signed_out" ? "Remote: paused, signed out" : reason === "other_account" ? "Remote: paused, another account" : "Remote: not connected";
  };
  const syncTray = () => {
    if (!Tray || !Menu) return;
    if (!settings.enabled || disposed) { tray?.destroy(); tray = undefined; return; }
    if (!tray) {
      const file = path.join(__dirname, "tray", platform === "darwin" ? "trayTemplate.png" : "tray-windows.png");
      tray = new Tray(nativeImage ? nativeImage.createFromPath(file) : file);
      tray.setToolTip("Local Cognitive");
      if (platform !== "darwin") tray.on("click", () => openWindow());
    }
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: trayLine(), enabled: false },
      { type: "separator" },
      { label: "Open Local Cognitive", click: () => openWindow() },
      { label: "Connect a device…", enabled: agent?.status().state === "online", click: () => openWindow("remote-host") },
      // The icon goes with them: on Windows, with no window open, the app would run on unseen.
      { label: "Turn off remote connections", click: () => { void setSwitches({ enabled: false }).then(() => { if (platform !== "darwin" && !getWindow()) openWindow(); }); } },
      { type: "separator" },
      { label: "Quit Local Cognitive", click: () => app.quit() }
    ]));
  };
  // What a device's status line shows: no update notice yet, nor anything a server's admin runs. The
  // backend the models run on (metal, cuda, cpu) without a preference: a desktop has no --inference.
  const hostStatus = () => {
    const { phase, activeWork, scheduler, telegram } = backend.status();
    let runtime = {};
    try { runtime = backend.runtimeManager.getRuntime().localModelService.snapshot().runtime; } catch { /* Runtime not built. */ }
    const inference = runtime.backend ? { inference: { backend: runtime.backend, ...(runtime.fallbackReason ? { fallbackReason: publicError(runtime.fallbackReason) } : {}) } } : {};
    return { kind: "desktop", version: appVersion(), phase, activeWork, scheduler, telegram, loadedModels: runtime.loadedModelIds ?? [], ...inference };
  };
  const keepAwake = on => {
    if (on && blocker === undefined) blocker = powerSaveBlocker.start("prevent-app-suspension");
    if (!on && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
  };
  const launch = expectedOwner => {
    // Commands and files outside a chat's folder are approved here, unless devices were allowed to.
    composition ??= createHostOperations({ backend, dataRoot, deviceFilesOnly: true,
      approvalPolicy: operation => settings.allowDeviceCommands ? undefined : deviceApprovalRefusal(operation, hostName) });
    // With the account's token, a computer no device has paired with yet is listed under the account.
    return startHostAgent({ host: backend.host, vault, cloudUrl, hostName, kind: "desktop", logger, status: hostStatus, operations: composition.operations, expectedOwner,
      accountToken: () => accountService.getAccessToken().catch(() => undefined) });
  };

  const start = () => serial(async () => {
    if (agent || !settings.enabled || disposed) return;
    const accountId = signedIn(), owner = store?.owner();
    paused = !store || !cloudUrl ? "unavailable" : !accountId ? "signed_out" : owner && owner !== accountId ? "other_account" : undefined;
    if (paused) { emit(); return; }
    try {
      agent = await launch(signedIn);
      startError = undefined;
      agent.on("state", emit);
      keepAwake(settings.keepAwake);
    } catch (error) { startError = error instanceof Error ? error.message : String(error); }
    emit();
  });
  const stop = () => serial(async () => {
    agent?.stop();
    agent = undefined;
    keepAwake(false);
    emit();
  });
  const online = (target, timeoutMs) => new Promise((resolve, reject) => {
    if (target.status().state === "online") { resolve(); return; }
    const timer = setTimeout(() => { target.off("state", changed); reject(failure("This computer could not reach Local Cognitive Cloud. Check the internet connection and try again.", "offline")); }, timeoutMs);
    const changed = state => { if (state === "online") { clearTimeout(timer); target.off("state", changed); resolve(); } };
    target.on("state", changed);
  });

  // Asleep, the Cloud connection may have died: check it on waking instead of after a minute.
  powerMonitor?.on("resume", () => agent?.reconnectNow());

  // Signing out pauses hosting; signing in again, or with an account that may host here, resumes it.
  accountService.on("change", () => {
    const accountId = signedIn(), owner = store?.owner();
    if (agent && (!accountId || (owner && owner !== accountId))) void stop().then(start);
    else void start();
  });

  const handle = (name, action) => ipcMain.handle(`remote-host:${name}`, async (event, ...args) => {
    assertSender(event);
    try { return { ok: true, value: await action(...args) }; }
    catch (error) { return { ok: false, error: { code: error.code || "error", message: error.message || "Hosting failed." } }; }
  });
  handle("status", () => status());
  const setSwitches = async patch => {
    if (!patch || typeof patch !== "object") throw failure("Invalid request.", "invalid_request");
    const next = { ...settings };
    for (const key of SWITCHES) if (typeof patch[key] === "boolean") next[key] = patch[key];
    // Asked here, not only in the window: anything a device writes is shown in that window.
    if (next.allowDeviceCommands && !settings.allowDeviceCommands) {
      const window = getWindow();
      const { response } = await dialog.showMessageBox(window && !window.isDestroyed() ? window : undefined, { type: "warning", buttons: ["Allow", "Cancel"], defaultId: 1, cancelId: 1,
        message: "Let your devices approve commands and files on this computer?",
        detail: "A paired device could then run any command and change any file here, as you can. Turn this on only if you trust every device paired with this computer." });
      if (response !== 0) next.allowDeviceCommands = false;
    }
    if (next.enabled && !store) throw failure("Hosting is unavailable on this computer: its database could not be opened.", "unavailable");
    writeSettings(file, next);
    settings = next;
    applyLoginItem();
    if (!settings.enabled) await stop(); else { if (agent) keepAwake(settings.keepAwake); await start(); }
    emit();
    return status();
  };
  handle("set", setSwitches);
  handle("connect-key", () => {
    if (!agent) throw failure("Turn on remote connections first.", "off");
    const { key, invitationId, expiresAt } = agent.connectKey(KEY_TTL_MS);
    // For the phone app to scan; drawn here from the key alone.
    return { key, invitationId, expiresAt, ...(showQr ? { qrSvg: qrSvg(connectionKeyQr(key)) } : {}) };
  });
  handle("invitation", raw => {
    const invitationId = id(raw);
    return agent ? agent.invitation(invitationId) : store?.invitation(invitationId) ?? { consumed: false };
  });
  // Revoked here at once, without the Cloud; the Cloud hears of it when hosting is next online.
  handle("revoke-device", raw => {
    const deviceId = id(raw);
    const revoked = agent ? agent.revokeDevice(deviceId) : Boolean(store?.revoke(deviceId, "host", new Date()));
    emit();
    return { revoked };
  });
  // Unlinks this computer from the account it belonged to, so the one signed in now can host. The
  // Cloud must hear of it, so it happens online; meanwhile no device may pair or connect.
  handle("unlink", () => serial(async () => {
    if (!store || !cloudUrl) throw failure("Hosting is unavailable on this computer.", "unavailable");
    const temporary = agent ? undefined : await launch(() => undefined);
    const target = agent ?? temporary;
    try {
      await online(target, 15_000);
      target.resetOwner();
    } finally { temporary?.stop(); }
  }).then(() => { paused = undefined; return start(); }).then(status));

  // Folders devices may use: the app's own Projects folder, and folders its owner shares here. A path
  // only ever comes from the system's folder dialog, opened by this process; the window sends ids.
  const home = os.homedir();
  const shown = location => location === home || location.startsWith(home + path.sep) ? `~${location.slice(home.length)}` : location;
  const folders = () => [
    { id: MANAGED_ROOT_ID, label: "Projects", managed: true, allowCreate: true, location: shown(path.join(dataRoot, MANAGED_ROOT_ID)) },
    ...listAdminFolders(dataRoot).map(folder => ({ id: folder.id, label: folder.label ?? path.basename(folder.path), managed: false, allowCreate: Boolean(folder.allowCreate), location: shown(folder.path) }))
  ];
  const folderPath = folderId => folderId === MANAGED_ROOT_ID ? path.join(dataRoot, MANAGED_ROOT_ID) : listAdminFolders(dataRoot).find(folder => folder.id === id(folderId))?.path;
  handle("folders", () => folders());
  handle("add-folder", async () => {
    const window = getWindow();
    const result = await dialog.showOpenDialog(window && !window.isDestroyed() ? window : undefined,
      { title: "Share a folder with your devices", buttonLabel: "Share", properties: ["openDirectory", "createDirectory"] });
    const chosen = result.canceled ? undefined : result.filePaths[0];
    if (!chosen) return folders();
    // macOS asks for access to Documents, Desktop or Downloads on the first read: now, while the owner is here.
    try { fs.readdirSync(chosen); } catch { /* Refused or unreadable: addAdminFolder says what it can. */ }
    addAdminFolder(dataRoot, chosen);
    return folders();
  });
  handle("set-folder", (folderId, options) => {
    if (typeof options?.allowCreate !== "boolean" || !setAdminFolderOptions(dataRoot, id(folderId), { allowCreate: options.allowCreate })) throw failure("This folder is not shared.", "not_found");
    return folders();
  });
  // Devices lose it at once: shared folders are read at every use.
  handle("remove-folder", folderId => { removeAdminFolder(dataRoot, id(folderId)); return folders(); });
  handle("open-folder", async folderId => {
    const location = folderPath(folderId);
    if (!location) throw failure("This folder is not shared.", "not_found");
    if (folderId === MANAGED_ROOT_ID) fs.mkdirSync(location, { recursive: true, mode: 0o700 });
    const error = await shell.openPath(location);
    if (error) throw failure(error, "error");
  });

  return {
    init: () => { syncTray(); return start(); },
    /** Whether closing the last window should leave the app running (hosting is on). */
    keepsRunning: () => settings.enabled && !disposed,
    /** Says once, the first time the window closes on Windows, that the app is still in the tray. */
    noteBackground: () => {
      if (settings.backgroundNoticeShown || !Notification?.isSupported?.()) return;
      settings = { ...settings, backgroundNoticeShown: true };
      writeSettings(file, settings);
      new Notification({ title: "Local Cognitive is still running", body: "Your devices can connect while it runs. Open it or quit it from the icon in the taskbar's corner." }).show();
    },
    /** What quitting would interrupt: devices connected now and their answers in progress. */
    busy: () => ({ connected: agent?.connectedDevices().length ?? 0, turns: backend.host?.runService.activeCount() ?? 0 }),
    status,
    /** This computer's id as a host, once it has registered with the Cloud. */
    hostId: () => store?.hostId(),
    agent: () => agent,
    dispose: () => {
      disposed = true;
      agent?.stop();
      agent = undefined;
      keepAwake(false);
      composition?.stop();
      tray?.destroy();
      tray = undefined;
    }
  };
}

module.exports = { registerHost };
