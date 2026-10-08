const path = require("path");
const { AccountService } = require("../dist/src/account/AccountService.js");
const { resolveAccountConfig } = require("../dist/src/account/accountConfig.js");
const { DEEP_LINK_SCHEME, isDeepLinkArgument, parseAuthDeepLink } = require("../dist/src/account/deepLink.js");

// Registers localcognitive:// for the "Open Local Cognitive" button on the sign-in page.
// Packaged macOS builds declare it in Info.plist (build.protocols); Windows registers in HKCU.
function registerProtocol(app) {
  if (process.env.LOCAL_COGNITIVE_TEST_DATA_DIR) return;
  if (process.defaultApp) { if (process.argv.length >= 2) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]); }
  else app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
}

function registerAccount({ app, ipcMain, shell, vault, assertSender, getWindow, focusWindow }) {
  const service = new AccountService({ config: resolveAccountConfig({ env: process.env, packaged: app.isPackaged }), vault,
    openExternal: url => shell.openExternal(url), onCompleted: focusWindow });
  service.on("change", status => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send("account:changed", status);
  });
  // Handlers resolve with an AccountStatus; they throw only for an unknown sender.
  const handle = (name, action) => ipcMain.handle(`account:${name}`, (event, ...args) => { assertSender(event); return action(...args); });
  handle("status", () => service.refreshStatus());
  handle("sign-in", method => ["google", "email", "signup"].includes(method) ? service.signIn(method) : service.status());
  handle("cancel-sign-in", () => service.cancelSignIn());
  handle("sign-out", () => service.signOut());
  return {
    init: () => service.init().catch(() => {}),
    handleDeepLink: raw => {
      focusWindow();
      const id = parseAuthDeepLink(raw);
      if (id) service.acknowledgeCompletion(id);
    },
    dispose: () => service.dispose(),
    // Remote reads the session in the main process; nothing here reaches the renderer.
    service
  };
}

module.exports = { registerProtocol, registerAccount, isDeepLinkArgument };
