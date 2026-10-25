import path from "path";
import type { AppConfig } from "../config/config";
import type { EncryptedCredentialVault } from "../plugins/EncryptedCredentialVault";
import { devVaultDirectory, devVaultKeyFile, openDevVault, usesDevVault } from "./devVault";
import { headlessVaultDirectory, resolveHeadlessVault, unavailableVaultAt } from "./headlessVault";

/** Why a run from source on Windows or Linux has no vault, and how to give it one. */
export const RUN_VAULT_REASON = "Protected storage is not set up for this run. Set LOCAL_COGNITIVE_VAULT_KEY_FILE to a key file outside the data folder that only you can read: one line of 32 random bytes in base64 (`openssl rand -base64 32`; on a server, `local-cognitive-server init` creates it). A key in .env works without it.";

export interface RunVault { vault: EncryptedCredentialVault; kind: "key-file" | "development" | "none"; error?: string }

/** The vault of a run without the desktop window (`npm start`, `npm run mcp:stdio`): the key file
 * LOCAL_COGNITIVE_VAULT_KEY_FILE names, as on a server; otherwise, on a Mac, the development vault
 * the development window uses (devVault.ts), so runs on one data folder read each other's keys;
 * otherwise none, with how to set one up. Never throws: a key that cannot be loaded is `error`. */
export const resolveRunVault = (config: AppConfig, options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; devKeyFile?: string } = {}): RunVault => {
  const env = options.env ?? process.env;
  const headless = resolveHeadlessVault(config, env);
  if (headless.configured) return { vault: headless.vault, kind: "key-file", ...(headless.error ? { error: headless.error } : {}) };
  if (usesDevVault({ isPackaged: false, platform: options.platform ?? process.platform, env })) {
    try { return { vault: openDevVault(config.appDataDir, path.dirname(config.appDataDir), options.devKeyFile ?? devVaultKeyFile()), kind: "development" }; }
    catch (error) {
      const message = `The development vault could not be opened: ${error instanceof Error ? error.message : String(error)}`;
      return { vault: unavailableVaultAt(devVaultDirectory(config.appDataDir), message), kind: "development", error: message };
    }
  }
  return { vault: unavailableVaultAt(headlessVaultDirectory(config.appDataDir), RUN_VAULT_REASON), kind: "none" };
};
