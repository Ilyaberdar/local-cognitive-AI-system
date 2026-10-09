const { resolveAccountConfig } = require("../dist/src/account/accountConfig.js");
const { accountUsageSender } = require("../dist/src/usage/UsageOutbox.js");
const { usageOverview } = require("../dist/src/usage/UsageOverview.js");

// Usage (spec §10): the ledger goes to the Cloud with the signed-in account's token, and the Usage
// page's numbers are put together here; the token never leaves the main process.
function registerUsage({ app, ipcMain, assertSender, accountService, backend }) {
  const { cloudUrl } = resolveAccountConfig({ env: process.env, packaged: app.isPackaged });
  const accountId = () => { const status = accountService.status(); return status.state === "signed-in" ? status.profile.accountId : undefined; };
  if (cloudUrl && backend.usage && backend.usageOutbox) {
    backend.usageOutbox.setSender(accountUsageSender({ cloudUrl, runtimeId: backend.usage.runtimeId, account: accountId,
      token: () => accountService.getAccessToken() }));
  }
  ipcMain.handle("usage:overview", async (event, request) => {
    assertSender(event);
    try {
      if (!backend.usage) return { ok: false, error: { code: "unavailable", message: "Usage is not recorded on this computer: its database could not be opened." } };
      return { ok: true, value: await usageOverview({ ledger: backend.usage, outbox: backend.usageOutbox, cloudUrl, accountId: accountId(),
        token: () => accountService.getAccessToken(), timeZone: request && request.timeZone }) };
    } catch (error) {
      return { ok: false, error: { code: "error", message: error instanceof Error ? error.message : "Usage could not be loaded." } };
    }
  });
}

module.exports = { registerUsage };
