const os = require("os");
const { RemoteClient, devicePlatform } = require("../dist/src/remote/client/RemoteClient.js");
const { resolveAccountConfig } = require("../dist/src/account/accountConfig.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = value => { if (typeof value !== "string" || !UUID.test(value)) throw Object.assign(new Error("Invalid id."), { code: "invalid_request" }); return value; };

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
    for (const name of ["hosts", "revoke-device", "host-status"]) handle(name, () => { throw Object.assign(new Error("Remote is not configured in this build."), { code: "not_configured" }); });
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
  return { dispose: () => client.dispose() };
}

module.exports = { registerRemote };
