import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { withFileLock, writeJsonAtomically } from "../../utils/fileStore";

/** The port the API listens on unless its owner picks another (not Ollama's 11434 or LM Studio's 1234). */
export const DEFAULT_INFERENCE_PORT = 4141;
/** A key's prefix: says what it is when it turns up in a script or a log (keyPatterns.ts masks it). */
export const INFERENCE_KEY_PREFIX = "lcsk_";
const MAX_KEYS = 50;

/** A key as it is listed: never its value, which is shown once when it is made. */
export interface InferenceKeyInfo {
  id: string;
  name: string;
  /** Its last four characters, to tell keys apart. */
  hint: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface StoredKey extends InferenceKeyInfo {
  /** SHA-256 of the key, hex. */
  hash: string;
}

export interface InferenceApiConfig {
  enabled: boolean;
  port: number;
  /** Other devices on the network may reach it (plain HTTP); otherwise only this computer. */
  lan: boolean;
}

interface StoredFile extends InferenceApiConfig {
  version: 1;
  keys: StoredKey[];
}

export class InferenceApiError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 400) { super(message); }
}

const hashOf = (key: string): string => createHash("sha256").update(key).digest("hex");

/**
 * The OpenAI-compatible API's own settings and keys, in a file of their own beside the settings
 * (`inference-api.json`, readable only by its owner): set on this computer only, never by a paired
 * device, and never sent with the settings. Keys are kept as hashes; one only calls the models.
 */
export class InferenceApiStore {
  private cached: StoredFile | undefined;

  constructor(private readonly filePath: string) {}

  async config(): Promise<InferenceApiConfig & { keys: InferenceKeyInfo[] }> {
    const { enabled, port, lan, keys } = await this.read();
    return { enabled, port, lan, keys: keys.map(({ hash: _hash, ...key }) => key) };
  }

  async setConfig(patch: Partial<InferenceApiConfig>): Promise<InferenceApiConfig> {
    if (patch.port !== undefined && (!Number.isInteger(patch.port) || patch.port < 1024 || patch.port > 65535)) {
      throw new InferenceApiError("The port must be a whole number from 1024 to 65535.", "invalid_port");
    }
    return this.change((file) => {
      if (patch.enabled !== undefined) file.enabled = Boolean(patch.enabled);
      if (patch.port !== undefined) file.port = patch.port;
      if (patch.lan !== undefined) file.lan = Boolean(patch.lan);
      return { enabled: file.enabled, port: file.port, lan: file.lan };
    });
  }

  /** A new key: its value is returned here and never again. */
  async createKey(name: string): Promise<InferenceKeyInfo & { key: string }> {
    const label = name.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!label) throw new InferenceApiError("Give the key a name, such as the program that uses it.", "invalid_name");
    const key = `${INFERENCE_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    const record: StoredKey = { id: randomUUID(), name: label, hint: key.slice(-4), createdAt: new Date().toISOString(), hash: hashOf(key) };
    await this.change((file) => {
      if (file.keys.length >= MAX_KEYS) throw new InferenceApiError(`There are already ${MAX_KEYS} keys: revoke one first.`, "too_many_keys");
      file.keys.push(record);
    });
    const { hash: _hash, ...info } = record;
    return { ...info, key };
  }

  async revokeKey(id: string): Promise<boolean> {
    return this.change((file) => {
      const before = file.keys.length;
      file.keys = file.keys.filter((key) => key.id !== id);
      return file.keys.length !== before;
    });
  }

  /** The key a request carries, if it is one of these: compared in constant time; its use is noted at most once a minute. */
  async verify(presented: string | undefined): Promise<InferenceKeyInfo | null> {
    if (!presented || !presented.startsWith(INFERENCE_KEY_PREFIX) || presented.length > 200) return null;
    const presentedHash = Buffer.from(hashOf(presented), "hex");
    const found = (await this.read()).keys.find((key) => timingSafeEqual(Buffer.from(key.hash, "hex"), presentedHash));
    if (!found) return null;
    const now = Date.now();
    if (!found.lastUsedAt || now - Date.parse(found.lastUsedAt) > 60_000) {
      void this.change((file) => {
        const key = file.keys.find((item) => item.id === found.id);
        if (key) key.lastUsedAt = new Date(now).toISOString();
      }).catch(() => undefined);
    }
    const { hash: _hash, ...info } = found;
    return info;
  }

  private async read(): Promise<StoredFile> {
    if (this.cached) return this.cached;
    let parsed: Partial<StoredFile> = {};
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<StoredFile>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not read ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const keys = Array.isArray(parsed.keys) ? parsed.keys.filter((key): key is StoredKey =>
      Boolean(key) && typeof key.id === "string" && typeof key.hash === "string" && /^[0-9a-f]{64}$/.test(key.hash) && typeof key.name === "string") : [];
    this.cached = {
      version: 1,
      enabled: parsed.enabled === true,
      port: Number.isInteger(parsed.port) && parsed.port! >= 1024 && parsed.port! <= 65535 ? parsed.port! : DEFAULT_INFERENCE_PORT,
      lan: parsed.lan === true,
      keys
    };
    return this.cached;
  }

  private change<T>(edit: (file: StoredFile) => T): Promise<T> {
    return withFileLock(this.filePath, async () => {
      this.cached = undefined;
      const file = structuredClone(await this.read());
      const result = edit(file);
      await writeJsonAtomically(this.filePath, file, { mode: 0o600 });
      this.cached = file;
      return result;
    });
  }
}
