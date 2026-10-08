import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import type { VaultCipher, VaultRecordContext } from "../plugins/EncryptedCredentialVault";
import type { VaultKey } from "./vaultKey";

// Record: "LCV1" | alg 0x01 (AES-256-GCM) | key id (8) | nonce (12) | ciphertext | tag (16).
const MAGIC = Buffer.from("LCV1");
const ALGORITHM = 0x01;
const HEADER = 13, NONCE = 12, TAG = 16;

// The header and the record's key-name digest are authenticated: a file moved to another
// name, or a changed key id, fails decryption.
const aad = (header: Buffer, context: VaultRecordContext) => Buffer.concat([header, Buffer.from(context.digest, "hex")]);

/** AES-256-GCM with a random nonce per write. keys[0] encrypts; any listed key decrypts. */
export const createAeadVaultCipher = (keys: VaultKey[]): VaultCipher => {
  const current = keys[0];
  const byId = new Map(keys.map(key => [key.id, key]));
  return {
    available: () => Boolean(current),
    encrypt(value, context) {
      if (!current) throw new Error("No vault key is configured.");
      const header = Buffer.concat([MAGIC, Buffer.from([ALGORITHM]), Buffer.from(current.id, "hex")]);
      const nonce = randomBytes(NONCE);
      // authTagLength is explicit: without it Node accepts truncated tags on decryption.
      const cipher = createCipheriv("aes-256-gcm", current.key, nonce, { authTagLength: TAG });
      cipher.setAAD(aad(header, context));
      const plaintext = Buffer.from(value, "utf8");
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      plaintext.fill(0);
      return Buffer.concat([header, nonce, body, cipher.getAuthTag()]);
    },
    decrypt(blob, context) {
      if (blob.length < HEADER + NONCE + TAG || !blob.subarray(0, 4).equals(MAGIC) || blob[4] !== ALGORITHM) throw new Error("Unsupported vault record.");
      const id = blob.subarray(5, HEADER).toString("hex"), key = byId.get(id);
      if (!key) throw new Error(`Vault record uses key ${id}, which is not configured.`);
      const decipher = createDecipheriv("aes-256-gcm", key.key, blob.subarray(HEADER, HEADER + NONCE), { authTagLength: TAG });
      decipher.setAAD(aad(blob.subarray(0, HEADER), context));
      decipher.setAuthTag(blob.subarray(blob.length - TAG));
      const plaintext = Buffer.concat([decipher.update(blob.subarray(HEADER + NONCE, blob.length - TAG)), decipher.final()]);
      const text = plaintext.toString("utf8");
      plaintext.fill(0);
      return text;
    },
    needsRekey: blob => blob.length >= HEADER && current !== undefined && blob.subarray(5, HEADER).toString("hex") !== current.id,
    recordKeyId: blob => blob.length >= HEADER && blob.subarray(0, 4).equals(MAGIC) ? blob.subarray(5, HEADER).toString("hex") : undefined
  };
};
