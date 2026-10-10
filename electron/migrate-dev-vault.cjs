const path = require("path");
const { app, safeStorage } = require("electron");

// `electron . --migrate-dev-vault`: reads the secrets a development build kept in the Keychain
// vault (the login password is asked one last time) and stores them in the development vault,
// so the app stays signed in and paired. Nothing is deleted; run it with the app closed.
function migrateDevVault() {
  // Never in a packaged app: its Keychain secrets stay in the Keychain.
  if (app.isPackaged) { console.error("[dev-vault] not available in a packaged app"); app.exit(1); return; }
  app.whenReady().then(() => {
    const { createAeadVaultCipher } = require("../dist/src/security/AeadVaultCipher.js");
    const { loadVaultKey } = require("../dist/src/security/vaultKey.js");
    const { devVaultDirectory, devVaultKeyFile, migrateVaultRecords, openDevVault } = require("../dist/src/security/devVault.js");
    const dataRoot = process.env.LOCAL_COGNITIVE_TEST_DATA_DIR || app.getPath("userData");
    const appData = path.join(dataRoot, "app");
    openDevVault(appData, dataRoot);
    const cipher = createAeadVaultCipher([loadVaultKey(devVaultKeyFile(), { forbiddenRoots: [dataRoot, appData] })]);
    const result = migrateVaultRecords(path.join(appData, "integrations", "vault"), devVaultDirectory(appData), blob => safeStorage.decryptString(blob), cipher);
    console.log(`[dev-vault] copied ${result.copied}, already there ${result.kept}, unreadable ${result.unreadable}`);
    app.exit(result.unreadable && !result.copied ? 1 : 0);
  }).catch(error => { console.error(`[dev-vault] ${error instanceof Error ? error.message : error}`); app.exit(1); });
}

module.exports = { migrateDevVault };
