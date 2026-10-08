import crypto from "crypto";
import type { TLSSocket } from "tls";

/** A TLS identity: an ECDSA P-256 key in a minimal self-signed certificate. Trust never rests
 * on certificate fields: peers pin SHA-256 of the SubjectPublicKeyInfo, and TLS 1.3
 * CertificateVerify proves possession of the key. */
export interface TlsIdentity { keyPem: string; certPem: string; spkiSha256: Buffer }

const length = (size: number) => size < 0x80 ? Buffer.from([size]) : size < 0x100 ? Buffer.from([0x81, size]) : Buffer.from([0x82, size >> 8, size & 0xff]);
const tlv = (tag: number, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), length(body.length), body]); };
const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const oid = (hex: string) => tlv(0x06, Buffer.from(hex, "hex"));
const ECDSA_WITH_SHA256 = sequence(oid("2a8648ce3d040302"));
const commonName = (name: string) => sequence(tlv(0x31, sequence(oid("550403"), tlv(0x0c, Buffer.from(name, "utf8")))));
const generalizedTime = (date: Date) => tlv(0x18, Buffer.from(`${date.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`));

export const spkiSha256 = (key: crypto.KeyObject): Buffer => crypto.createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest();

export const createTlsIdentity = (name: string): TlsIdentity => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const tbs = sequence(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, serial), ECDSA_WITH_SHA256, commonName(name),
    sequence(generalizedTime(new Date(Date.UTC(2025, 0, 1))), generalizedTime(new Date(Date.UTC(2099, 11, 31)))), commonName(name),
    publicKey.export({ type: "spki", format: "der" }));
  const signature = crypto.sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const der = sequence(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.from([0]), signature));
  return { keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    certPem: `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`, spkiSha256: spkiSha256(publicKey) };
};

/** Restores an identity saved as { keyPem, certPem }, checking that the two belong together. */
export const loadTlsIdentity = (saved: { keyPem: string; certPem: string }): TlsIdentity => {
  const certificate = new crypto.X509Certificate(saved.certPem);
  if (!certificate.checkPrivateKey(crypto.createPrivateKey(saved.keyPem))) throw new Error("The saved TLS key does not match its certificate.");
  return { ...saved, spkiSha256: spkiSha256(certificate.publicKey) };
};

export const peerSpkiSha256 = (socket: TLSSocket): Buffer | undefined => {
  const certificate = socket.getPeerX509Certificate();
  return certificate ? spkiSha256(certificate.publicKey) : undefined;
};

/** Ed25519 key the host signs Cloud challenges and claim receipts with (never the TLS key). */
export interface SigningIdentity { privateKeyPem: string; publicKey: Buffer }
export const createSigningIdentity = (): SigningIdentity => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: rawEd25519(publicKey) };
};
export const loadSigningIdentity = (privateKeyPem: string): SigningIdentity =>
  ({ privateKeyPem, publicKey: rawEd25519(crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem))) });
const rawEd25519 = (publicKey: crypto.KeyObject) => Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");

/** Signs `context ‖ 0x00 ‖ message`: a signature for one purpose never verifies for another. */
export const signFor = (identity: SigningIdentity, context: string, message: Buffer): Buffer =>
  crypto.sign(null, Buffer.concat([Buffer.from(context), Buffer.from([0]), message]), identity.privateKeyPem);
