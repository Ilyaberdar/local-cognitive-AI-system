import fs from "fs";
import path from "path";
import { createHash, createSecretKey, KeyObject, randomBytes } from "crypto";

export class VaultKeyError extends Error { constructor(message: string) { super(message); this.name = "VaultKeyError"; } }
export interface VaultKey { id: string; key: KeyObject }
export interface KeyLocationOptions { forbiddenRoots: string[]; platform?: NodeJS.Platform; euid?: number }

/** A short id stored in each record, so the right key is chosen without trial decryption. */
export const keyIdOf = (raw: Buffer): string =>
  createHash("sha256").update("local-cognitive/vault-key-id/v1\0").update(raw).digest().subarray(0, 8).toString("hex");

/** 32 raw bytes, or one canonical base64 line (the output of `openssl rand -base64 32`). */
export const parseVaultKey = (content: Buffer): Buffer => {
  if (content.length === 32) return Buffer.from(content);
  const text = content.toString("utf8").replace(/\r?\n$/, "");
  // Buffer.from(..., "base64") is lenient, so the exact form is checked first.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) throw new VaultKeyError("The vault key must be 32 random bytes, base64-encoded on one line.");
  return Buffer.from(text, "base64");
};

const isInside = (child: string, parent: string) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

// The key must not live with the data it protects: backups would then contain both.
const checkLocation = (file: string, real: string, roots: string[]) => {
  for (const root of roots) {
    const resolved = path.resolve(root);
    if (path.parse(resolved).root === resolved) continue;
    let realRoot = resolved;
    try { realRoot = fs.realpathSync(resolved); } catch { /* A missing root cannot contain the key. */ }
    if (isInside(path.resolve(file), resolved) || isInside(real, realRoot)) throw new VaultKeyError(`The vault key ${file} must be stored outside the data directories and backups.`);
  }
};

export const loadVaultKey = (file: string, options: KeyLocationOptions): VaultKey => {
  if (!path.isAbsolute(file)) throw new VaultKeyError("LOCAL_COGNITIVE_VAULT_KEY_FILE must be an absolute path.");
  let real: string;
  try { real = fs.realpathSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new VaultKeyError(`Vault key file ${file} does not exist.`);
    throw error;
  }
  checkLocation(file, real, options.forbiddenRoots);
  const descriptor = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 64) throw new VaultKeyError(`Vault key ${file} is not a key file.`);
    if ((options.platform ?? process.platform) !== "win32") {
      if (stat.mode & 0o077) throw new VaultKeyError(`Vault key ${file} is accessible to other users. Restrict it to its owner (chmod 600).`);
      const euid = options.euid ?? process.geteuid?.();
      if (euid !== undefined && stat.uid !== euid && stat.uid !== 0) throw new VaultKeyError(`Vault key ${file} is owned by another user.`);
      if (fs.statSync(path.dirname(real)).mode & 0o022) throw new VaultKeyError(`The directory of vault key ${file} is writable by other users.`);
    }
    const content = Buffer.alloc(stat.size);
    fs.readSync(descriptor, content, 0, stat.size, 0);
    const raw = parseVaultKey(content);
    content.fill(0);
    const key = { id: keyIdOf(raw), key: createSecretKey(raw) };
    raw.fill(0);
    return key;
  } finally { fs.closeSync(descriptor); }
};

/** Creates a key file once; an existing key is never overwritten. */
export const initVaultKey = (file: string, options: KeyLocationOptions): { id: string; created: boolean } => {
  if (!path.isAbsolute(file)) throw new VaultKeyError("The vault key path must be absolute.");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  checkLocation(file, path.resolve(file), options.forbiddenRoots);
  let descriptor: number;
  try { descriptor = fs.openSync(file, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { id: loadVaultKey(file, options).id, created: false };
    throw error;
  }
  const raw = randomBytes(32);
  try { fs.writeSync(descriptor, `${raw.toString("base64")}\n`); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  try { const directory = fs.openSync(path.dirname(file), "r"); fs.fsyncSync(directory); fs.closeSync(directory); } catch { /* Not supported on every platform. */ }
  const id = keyIdOf(raw);
  raw.fill(0);
  return { id, created: true };
};
