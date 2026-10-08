import path from "path";
import type { AppConfig } from "../config/config";
import { EncryptedCredentialVault } from "../plugins/EncryptedCredentialVault";
import { releaseRoot } from "../utils/appVersion";
import { createAeadVaultCipher } from "./AeadVaultCipher";
import { loadVaultKey, VaultKey } from "./vaultKey";

export const VAULT_KEY_FILE_ENV = "LOCAL_COGNITIVE_VAULT_KEY_FILE";
export const VAULT_PREVIOUS_KEY_FILES_ENV = "LOCAL_COGNITIVE_VAULT_PREVIOUS_KEY_FILES";

/** Separate from the desktop vault directory: the record formats differ. */
export const headlessVaultDirectory = (appDataDir: string) => path.join(appDataDir, "integrations", "host-vault");

/** Places the key must not be: data, backups, agent-accessible folders and the release. */
export const vaultForbiddenRoots = (config: AppConfig, extra: string[] = []): string[] => [
  config.appDataDir, config.memory.baseDir, config.sessions.baseDir, config.outputDir, config.localModels?.modelsDir ?? "",
  config.plugins.dir, config.ui.publicDir, releaseRoot(), ...config.filesystem.allowedDirectories, ...extra
].filter(Boolean);

export interface HeadlessVault { vault: EncryptedCredentialVault; configured: boolean; keyIds?: string[]; error?: string }

const unavailable = (directory: string, reason: string) => new EncryptedCredentialVault(directory, {
  available: () => false, unavailableReason: () => reason,
  encrypt: () => { throw new Error(reason); }, decrypt: () => { throw new Error(reason); }
});

/** Never throws: without a usable key the vault is unavailable with a clear reason. There is
 * no plaintext fallback. */
export const resolveHeadlessVault = (config: AppConfig, env: NodeJS.ProcessEnv = process.env, extraRoots: string[] = []): HeadlessVault => {
  const directory = headlessVaultDirectory(config.appDataDir);
  const file = env[VAULT_KEY_FILE_ENV]?.trim();
  if (!file) return { vault: unavailable(directory, "Credential storage is not configured on this server. Run `local-cognitive-server init` and set LOCAL_COGNITIVE_VAULT_KEY_FILE."), configured: false };
  try {
    const roots = vaultForbiddenRoots(config, extraRoots);
    const keys: VaultKey[] = [loadVaultKey(file, { forbiddenRoots: roots })];
    for (const previous of (env[VAULT_PREVIOUS_KEY_FILES_ENV] ?? "").split(path.delimiter).map(entry => entry.trim()).filter(Boolean)) {
      const key = loadVaultKey(previous, { forbiddenRoots: roots });
      if (!keys.some(existing => existing.id === key.id)) keys.push(key);
    }
    return { vault: new EncryptedCredentialVault(directory, createAeadVaultCipher(keys)), configured: true, keyIds: keys.map(key => key.id) };
  } catch (error) {
    const message = `Credential storage key could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
    return { vault: unavailable(directory, message), configured: true, error: message };
  }
};
