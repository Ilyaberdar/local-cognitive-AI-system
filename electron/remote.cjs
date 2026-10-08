const os = require("os");
const { RemoteClient, devicePlatform } = require("../dist/src/remote/client/RemoteClient.js");
const { RemoteRuntime } = require("../dist/src/remote/client/RemoteRuntime.js");
const { resolveAccountConfig } = require("../dist/src/account/accountConfig.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = value => { if (typeof value !== "string" || !UUID.test(value)) throw Object.assign(new Error("Invalid id."), { code: "invalid_request" }); return value; };
// The chat screen may call exactly these server operations (R4); everything else stays local.
const RUNTIME_REQUESTS = new Set(["sessions.list", "sessions.create", "sessions.messages.list", "sessions.settings.get", "sessions.settings.update",
  "models.available", "chat.runs.get", "chat.runs.cancel", "chat.approvals.resolve", "host.info", "host.status"]);
const RUNTIME_COMMANDS = new Set(["chat.runs.start"]);
const MAX_PAYLOAD_BYTES = 256 * 1024;
const checkedPayload = payload => {
  if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) throw Object.assign(new Error("Invalid request."), { code: "invalid_request" });
  if (payload !== undefined && Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) throw Object.assign(new Error("The request is too large."), { code: "invalid_request" });
  return payload;
};
const allowed = (set, op) => { if (typeof op !== "string" || !set.has(op)) throw Object.assign(new Error("This operation is not available remotely."), { code: "unsupported" }); return op; };

// Remote (spec §6): the device key, pins and session live in the main process; the renderer
// gets statuses and host summaries, never keys, tickets or tokens.
function registerRemote({ app, ipcMain, vault, accountService, assertSender, getWindow }) {
  const config = resolveAccountConfig({ env: process.env, packaged: app.isPackaged });
  const handle = (name, action) => ipcMain.handle(`remote:${name}`, async (event, ...args) => {
    assertSender(event);
    try { return { ok: true, value: await action(...args) }; }
    catch (error) { return { ok: false, error: { code: error.code || "error", message: error.message || "Remote failed." } }; }
  });
  if (!config.cloudUrl) {
    const unavailable = () => ({ state: "unavailable" });
    for (const name of ["status", "pair", "connect", "disconnect", "forget"]) handle(name, unavailable);
    for (const name of ["hosts", "revoke-device", "host-status", "runtime-request", "runtime-send", "runtime-subscribe", "runtime-unsubscribe"]) handle(name, () => { throw Object.assign(new Error("Remote is not configured in this build."), { code: "not_configured" }); });
    return { dispose() {} };
  }
  const client = new RemoteClient({ cloudUrl: config.cloudUrl, vault, deviceName: os.hostname().replace(/\.local$/, ""), platform: devicePlatform(),
    account: async () => {
      const status = accountService.status();
      if (status.state !== "signed-in") return undefined;
      return { accountId: status.profile.accountId, accessToken: await accountService.getAccessToken() };
    } });
  client.on("change", status => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send("remote:changed", status);
  });
  // Signing out or switching accounts ends the session; pairings stay stored per account.
  let accountId = accountService.status().profile?.accountId;
  accountService.on("change", status => {
    const next = status.state === "signed-in" ? status.profile.accountId : undefined;
    if (next !== accountId) { accountId = next; client.disconnect(); }
  });
  handle("status", () => client.status());
  handle("hosts", () => client.hosts());
  handle("pair", key => typeof key === "string" && key.length <= 1000 ? client.pair(key) : client.status());
  handle("connect", hostId => client.connect(id(hostId)));
  handle("disconnect", () => client.disconnect());
  handle("forget", hostId => client.forget(id(hostId)));
  handle("revoke-device", (hostId, deviceId) => client.revokeDevice(id(hostId), id(deviceId)));
  handle("host-status", () => client.request("host.status"));
  // The chat screen's runtime on the selected server (R4).
  const runtime = new RemoteRuntime(client);
  runtime.on("update", update => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send("remote:runtime-event", update);
  });
  handle("runtime-request", (op, payload) => client.request(allowed(RUNTIME_REQUESTS, op), checkedPayload(payload)));
  handle("runtime-send", (op, payload) => runtime.send(allowed(RUNTIME_COMMANDS, op), checkedPayload(payload) ?? {}));
  handle("runtime-subscribe", cursor => {
    if (!cursor || typeof cursor.streamId !== "string" || !/^session:.{1,200}$/.test(cursor.streamId) || typeof cursor.epoch !== "string"
      || !Number.isSafeInteger(cursor.after) || cursor.after < 0) throw Object.assign(new Error("Invalid cursor."), { code: "invalid_request" });
    runtime.subscribe({ streamId: cursor.streamId, epoch: cursor.epoch, after: cursor.after });
  });
  handle("runtime-unsubscribe", streamId => { if (typeof streamId === "string") runtime.unsubscribe(streamId); });
  // Reconnect to the server this computer used last, once the account session is known.
  void client.resume().catch(() => {});
  return { dispose: () => { runtime.dispose(); client.dispose(); } };
}

module.exports = { registerRemote };
