const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveAccountConfig } = require("../dist/src/account/accountConfig.js");
const { createHostOperations, startHostAgent } = require("../dist/src/remote/host/hostRuntime.js");
const { RemoteHostStore } = require("../dist/src/remote/host/RemoteHostStore.js");
const { appVersion } = require("../dist/src/utils/appVersion.js");
const { Logger } = require("../dist/src/utils/Logger.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = value => { if (typeof value !== "string" || !UUID.test(value)) throw Object.assign(new Error("Invalid id."), { code: "invalid_request" }); return value; };
const failure = (message, code) => Object.assign(new Error(message), { code });
// Hosting's own switches. Kept apart from the app's settings, which a paired device may change.
const DEFAULTS = Object.freeze({ enabled: false, keepAwake: true, openAtLogin: false, allowDeviceCommands: false });
const KEY_TTL_MS = 10 * 60_000;

const readSettings = file => {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* None yet, or unreadable: the defaults. */ }
  return Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, typeof saved?.[key] === "boolean" ? saved[key] : value]));
};
const writeSettings = (file, settings) => {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
};

// This computer as a Remote host: paired devices reach it through Local Cognitive Cloud while the
// app runs and hosting is on. It belongs to the account signed in here: another account's key is
// refused, and signing out pauses it. The host key and grants live in the app's vault and host.db;
// the renderer gets statuses, the connection key it shows, and device names, never a path or token.
function registerHost({ app, ipcMain, vault, accountService, backend, dataRoot, assertSender, getWindow, powerSaveBlocker,
  cloudUrl = resolveAccountConfig({ env: process.env, packaged: app.isPackaged }).cloudUrl, logger = new Logger(),
  hostName = os.hostname().replace(/\.local$/, "").slice(0, 120) || "Computer" }) {
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
    return {
      available: Boolean(store && cloudUrl), ...settings, hostName,
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
  };
  // What a device's status line shows: no update notice yet, nor anything a server's admin runs.
  const hostStatus = () => {
    const { phase, activeWork, scheduler, telegram } = backend.status();
    let loadedModels = [];
    try { loadedModels = backend.runtimeManager.getRuntime().localModelService.snapshot().runtime.loadedModelIds ?? []; } catch { /* Runtime not built. */ }
    return { kind: "desktop", version: appVersion(), phase, activeWork, scheduler, telegram, loadedModels };
  };
  const keepAwake = on => {
    if (on && blocker === undefined) blocker = powerSaveBlocker.start("prevent-app-suspension");
    if (!on && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
  };
  const launch = expectedOwner => {
    composition ??= createHostOperations({ backend, dataRoot });
    return startHostAgent({ host: backend.host, vault, cloudUrl, hostName, kind: "desktop", logger, status: hostStatus, operations: composition.operations, expectedOwner });
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
  handle("set", async patch => {
    if (!patch || typeof patch !== "object") throw failure("Invalid request.", "invalid_request");
    const next = { ...settings };
    for (const key of Object.keys(DEFAULTS)) if (typeof patch[key] === "boolean") next[key] = patch[key];
    if (next.enabled && !store) throw failure("Hosting is unavailable on this computer: its database could not be opened.", "unavailable");
    writeSettings(file, next);
    settings = next;
    if (!settings.enabled) await stop(); else { if (agent) keepAwake(settings.keepAwake); await start(); }
    return status();
  });
  handle("connect-key", () => {
    if (!agent) throw failure("Turn on remote connections first.", "off");
    const { key, invitationId, expiresAt } = agent.connectKey(KEY_TTL_MS);
    return { key, invitationId, expiresAt };
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

  return {
    init: () => start(),
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
    }
  };
}

module.exports = { registerHost, readSettings };
