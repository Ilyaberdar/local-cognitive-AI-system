import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CredentialVault, PluginError } from "./contracts";
import { isMissingFile, withFileLock } from "../utils/fileStore";

/** Electron supplies safeStorage: on macOS its encryption key lives in Keychain.
 * No plaintext fallback, environment dump, or renderer token retrieval exists. */
export class EncryptedCredentialVault implements CredentialVault {
  constructor(private readonly directory: string, private readonly cipher: {
    available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string;
  }) {}
  available() { return this.cipher.available(); }
  private file(key: string) { return path.join(this.directory, `${createHash("sha256").update(key).digest("hex")}.enc`); }
  async read(key: string) {
    if (!this.available()) throw new PluginError("Unlock protected storage to connect accounts.", 503);
    try { return this.cipher.decrypt(await fs.readFile(this.file(key))); }
    catch (error) { if (isMissingFile(error)) return undefined; throw new PluginError("Protected credentials could not be read. Reconnect this account.", 503); }
  }
  async write(key: string, value: string) {
    if (!this.available()) throw new PluginError("Protected storage is unavailable. Credentials were not saved.", 503);
    const encrypted = this.cipher.encrypt(value), file = this.file(key);
    await withFileLock(file, async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, file);
      } finally { await fs.unlink(temporary).catch(error => { if (!isMissingFile(error)) throw error; }); }
    });
  }
  async remove(key: string) { await withFileLock(this.file(key), () => fs.unlink(this.file(key)).catch(error => { if (!isMissingFile(error)) throw error; })); }
}
