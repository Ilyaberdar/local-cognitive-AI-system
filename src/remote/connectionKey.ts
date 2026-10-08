import { createHash, timingSafeEqual } from "crypto";

/** One-time connection key printed by `local-cognitive-server connect-key` (spec §6.1):
 * `LCR1-<base32(payload)>-<base32(first 4 bytes of SHA-256("lcr1" ‖ payload))>`. */
export interface ConnectionKey {
  /** 1 = production cloud, 2 = any other cloud: a key never crosses environments. */
  environment: number;
  hostId: string;
  invitationId: string;
  /** SHA-256 of the host TLS key's SubjectPublicKeyInfo. */
  hostSpkiSha256: Buffer;
  secret: Buffer;
  /** Unix seconds. */
  expiresAt: number;
}

export type ConnectionKeyErrorCode = "format" | "checksum" | "version" | "environment" | "expired";
export class ConnectionKeyError extends Error {
  constructor(readonly code: ConnectionKeyErrorCode) {
    super({ format: "This is not a Local Cognitive connection key.", checksum: "The connection key has a typo. Copy it again.",
      version: "This connection key needs a newer version of Local Cognitive.", environment: "This connection key belongs to another Local Cognitive service.",
      expired: "The connection key has expired. Create a new one on the server." }[code]);
  }
}

const VERSION = 1, PAYLOAD_BYTES = 102;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const PRODUCTION_CLOUD_ORIGIN = "https://api.local-cognitive.com";
export const environmentOf = (cloudUrl: string): number => new URL(cloudUrl).origin === PRODUCTION_CLOUD_ORIGIN ? 1 : 2;

const base32 = (bytes: Buffer): string => {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits ? out + ALPHABET[(value << (5 - bits)) & 31] : out;
};
/** Strict decoding: unused trailing bits must be zero, so every key has one spelling. */
const fromBase32 = (text: string): Buffer => {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new ConnectionKeyError("format");
    value = ((value << 5) | index) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  if (value & ((1 << bits) - 1)) throw new ConnectionKeyError("checksum");
  return Buffer.from(out);
};
const checksum = (payload: Buffer) => createHash("sha256").update("lcr1").update(payload).digest().subarray(0, 4);
const uuidBytes = (uuid: string): Buffer => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) throw new Error(`Not a UUID: ${uuid}`);
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
};
const uuidText = (bytes: Buffer): string => bytes.toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");

export const encodeConnectionKey = (key: ConnectionKey): string => {
  if (key.hostSpkiSha256.length !== 32 || key.secret.length !== 32) throw new Error("Connection key fingerprint and secret are 32 bytes.");
  const expires = Buffer.alloc(4); expires.writeUInt32BE(key.expiresAt);
  const payload = Buffer.concat([Buffer.from([VERSION, key.environment]), uuidBytes(key.hostId), uuidBytes(key.invitationId), key.hostSpkiSha256, key.secret, expires]);
  return `LCR1-${base32(payload)}-${base32(checksum(payload))}`;
};

/** Accepts any case, spaces and line breaks. Errors never include the key itself. */
export const decodeConnectionKey = (text: string, options: { environment?: number; now?: number } = {}): ConnectionKey => {
  const match = /^LCR1-([A-Z2-7]{164})-([A-Z2-7]{7})$/.exec(text.replace(/\s+/g, "").toUpperCase());
  if (!match) throw new ConnectionKeyError("format");
  const payload = fromBase32(match[1]!), sum = fromBase32(match[2]!);
  if (payload.length !== PAYLOAD_BYTES || !timingSafeEqual(sum, checksum(payload))) throw new ConnectionKeyError("checksum");
  if (payload[0] !== VERSION) throw new ConnectionKeyError("version");
  const key: ConnectionKey = { environment: payload[1]!, hostId: uuidText(payload.subarray(2, 18)), invitationId: uuidText(payload.subarray(18, 34)),
    hostSpkiSha256: Buffer.from(payload.subarray(34, 66)), secret: Buffer.from(payload.subarray(66, 98)), expiresAt: payload.readUInt32BE(98) };
  if (options.environment !== undefined && key.environment !== options.environment) throw new ConnectionKeyError("environment");
  if (key.expiresAt * 1000 <= (options.now ?? Date.now())) throw new ConnectionKeyError("expired");
  return key;
};
