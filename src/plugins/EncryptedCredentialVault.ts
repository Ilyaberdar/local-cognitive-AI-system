import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CredentialVault, PluginError } from "./contracts";
import { isMissingFile, withFileLock } from "../utils/fileStore";

/** Identifies the record being encrypted: the sha256 of its key name (also its file stem). */
export interface VaultRecordContext { digest: string }

export interface VaultCipher {
  available(): boolean;
  unavailableReason?(): string | undefined;
  encrypt(value: string, context: VaultRecordContext): Buffer;
  decrypt(value: Buffer, context: VaultRecordContext): string;
  /** True when a record was written with a key that is no longer current. */
  needsRekey?(blob: Buffer): boolean;
  recordKeyId?(blob: Buffer): string | undefined;
}

const recordFile = /^[0-9a-f]{64}\.enc$/;

/** Electron supplies safeStorage (on macOS its key lives in Keychain); a headless server
 * supplies an AEAD cipher with a key file. No plaintext fallback, environment dump, or
 * renderer token retrieval exists. */
export class EncryptedCredentialVault implements CredentialVault {
  constructor(private readonly directory: string, private readonly cipher: VaultCipher) {}
  available() { return this.cipher.available(); }
  unavailableReason() { return this.available() ? undefined : this.cipher.unavailableReason?.(); }
  private digest(key: string) { return createHash("sha256").update(key).digest("hex"); }
  private file(digest: string) { return path.join(this.directory, `${digest}.enc`); }
  async read(key: string) {
    if (!this.available()) throw new PluginError(this.unavailableReason() ?? "Unlock protected storage to connect accounts.", 503);
    const digest = this.digest(key);
    try { return this.cipher.decrypt(await fs.readFile(this.file(digest)), { digest }); }
    catch (error) { if (isMissingFile(error)) return undefined; throw new PluginError("Protected credentials could not be read. Reconnect this account.", 503); }
  }
  async write(key: string, value: string) {
    if (!this.available()) throw new PluginError(this.unavailableReason() ?? "Protected storage is unavailable. Credentials were not saved.", 503);
    const digest = this.digest(key), encrypted = this.cipher.encrypt(value, { digest }), file = this.file(digest);
    await withFileLock(file, () => this.replace(file, encrypted));
  }
  async remove(key: string) {
    const file = this.file(this.digest(key));
    await withFileLock(file, () => fs.unlink(file).catch(error => { if (!isMissingFile(error)) throw error; }));
  }

  /** Re-encrypts records written with an older key. Run while no other process uses the vault. */
  async rekey(): Promise<{ rekeyed: number; current: number; unreadable: number }> {
    const result = { rekeyed: 0, current: 0, unreadable: 0 };
    for (const name of await this.records()) {
      const file = path.join(this.directory, name), digest = name.slice(0, 64);
      await withFileLock(file, async () => {
        let blob: Buffer;
        try { blob = await fs.readFile(file); } catch (error) { if (isMissingFile(error)) return; throw error; }
        if (!this.cipher.needsRekey?.(blob)) { result.current++; return; }
        let value: string;
        try { value = this.cipher.decrypt(blob, { digest }); } catch { result.unreadable++; return; }
        await this.replace(file, this.cipher.encrypt(value, { digest }));
        result.rekeyed++;
      });
    }
    return result;
  }

  /** Number of records per key id ("unreadable" for records no configured key can name). */
  async recordStatus(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const name of await this.records()) {
      let blob: Buffer;
      try { blob = await fs.readFile(path.join(this.directory, name)); } catch { continue; }
      const id = this.cipher.recordKeyId?.(blob) ?? "unreadable";
      counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }

  private async records(): Promise<string[]> {
    try { return (await fs.readdir(this.directory)).filter(name => recordFile.test(name)); }
    catch (error) { if (isMissingFile(error)) return []; throw error; }
  }

  private async replace(file: string, blob: Buffer): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(blob); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(error => { if (!isMissingFile(error)) throw error; }); }
  }
}
