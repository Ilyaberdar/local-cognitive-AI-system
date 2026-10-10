import fs from "fs";
import os from "os";
import path from "path";
import { EncryptedCredentialVault, type VaultCipher } from "../plugins/EncryptedCredentialVault";
import { createAeadVaultCipher } from "./AeadVaultCipher";
import { initVaultKey, loadVaultKey } from "./vaultKey";

/** A development build (an unsigned Electron from npm) keeps its secrets out of the macOS Keychain:
 * for such a binary macOS asks for the login password again and again, and the app looks signed
 * out whenever the prompt is not answered. Its key is a file outside the data folder (backups never
 * hold both), its records the server's format. A signed release uses the Keychain as before. */
/** Only a development run on macOS (`electron .`, an unsigned binary); never a packaged app,
 * which keeps its secrets in the Keychain. LOCAL_COGNITIVE_DEV_KEYCHAIN=1 keeps the Keychain. */
export const usesDevVault = (input: { isPackaged: boolean; platform: NodeJS.Platform; env: NodeJS.ProcessEnv }): boolean =>
  !input.isPackaged && input.platform === "darwin" && input.env.LOCAL_COGNITIVE_DEV_KEYCHAIN !== "1";

export const devVaultKeyFile = (home = os.homedir()) => path.join(home, ".config", "local-cognitive", "dev-vault.key");
export const devVaultDirectory = (appDataDir: string) => path.join(appDataDir, "integrations", "dev-vault");

export const openDevVault = (appDataDir: string, dataRoot: string, keyFile = devVaultKeyFile()): EncryptedCredentialVault => {
  const roots = [dataRoot, appDataDir];
  initVaultKey(keyFile, { forbiddenRoots: roots });
  return new EncryptedCredentialVault(devVaultDirectory(appDataDir), createAeadVaultCipher([loadVaultKey(keyFile, { forbiddenRoots: roots })]));
};

/** Copies every record of the Keychain vault into the development vault, encrypted with its key.
 * Records already there are kept; unreadable ones are counted, never deleted. */
export const migrateVaultRecords = (from: string, to: string, decrypt: (blob: Buffer) => string, cipher: VaultCipher): { copied: number; kept: number; unreadable: number } => {
  const result = { copied: 0, kept: 0, unreadable: 0 };
  let names: string[] = [];
  try { names = fs.readdirSync(from).filter(name => /^[0-9a-f]{64}\.enc$/.test(name)); } catch { return result; }
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of names) {
    const target = path.join(to, name);
    if (fs.existsSync(target)) { result.kept++; continue; }
    let value: string;
    try { value = decrypt(fs.readFileSync(path.join(from, name))); } catch { result.unreadable++; continue; }
    fs.writeFileSync(target, cipher.encrypt(value, { digest: name.slice(0, 64) }), { mode: 0o600 });
    result.copied++;
  }
  return result;
};
