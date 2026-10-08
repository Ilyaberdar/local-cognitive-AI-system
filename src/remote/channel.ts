import crypto from "crypto";
import { EventEmitter } from "events";
import type { Duplex } from "stream";
import tls, { TLSSocket } from "tls";
import { peerSpkiSha256, type TlsIdentity } from "./identity";

/** End-to-end channel between a device and a host (spec §6.3): TLS 1.3 with mutual
 * authentication over any byte stream, normally a WebSocket through the relay. The host is
 * the TLS server. Both sides pin SHA-256(SPKI); certificate fields are never trusted. */
export const PROTOCOL_VERSION = 1;
export const EXPORTER_LABEL = "EXPORTER-local-cognitive-remote-v1";
export const MAX_FRAME_BYTES = 1024 * 1024;
const TLS_VERSION = { minVersion: "TLSv1.3", maxVersion: "TLSv1.3" } as const;

export class ChannelError extends Error { constructor(message: string, readonly code: string) { super(message); } }

/** SHA-256 over length-prefixed fields: no two field lists share an encoding. */
export const contextHash = (...fields: Array<string | Buffer>): Buffer => {
  const hash = crypto.createHash("sha256");
  for (const field of fields) {
    const bytes = typeof field === "string" ? Buffer.from(field, "utf8") : field;
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    hash.update(size).update(bytes);
  }
  return hash.digest();
};
/** Keying material unique to this TLS session and the given context (RFC 8446 §7.5). */
export const channelExporter = (socket: TLSSocket, ...context: Array<string | Buffer>): Buffer =>
  socket.exportKeyingMaterial(32, EXPORTER_LABEL, contextHash(...context));
/** Proof that the device holds the invitation secret, bound to this session: a proof seen by
 * the relay cannot be replayed into another session. */
export const pairingProof = (secret: Buffer, exporter: Buffer): Buffer =>
  crypto.createHmac("sha256", secret).update("lc-pair-proof/v1").update(exporter).digest();

export interface PairingContext { hostId: string; invitationId: string; ticketId: string; accountId: string; deviceId: string; deviceSpkiSha256: Buffer; hostSpkiSha256: Buffer }
/** The exporter a pairing proof is bound to: this session, the Cloud ticket, account, device key and host key. */
export const pairingExporter = (socket: TLSSocket, context: PairingContext): Buffer =>
  channelExporter(socket, "pair", context.hostId, context.invitationId, context.ticketId, context.accountId, context.deviceId, context.deviceSpkiSha256, context.hostSpkiSha256);

const withTimeout = <T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { onTimeout(); reject(new ChannelError("The secure connection timed out.", "timeout")); }, ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

/** Device side: the host's key must match the pin before anything is sent. Chain validation is
 * off on purpose — both certificates are self-signed and carry no authority; the SPKI pin
 * checked below (and on the host, against the device's grant) replaces it. */
export const connectTls = (transport: Duplex, identity: TlsIdentity, expectedHostSpki: Buffer, timeoutMs = 15_000): Promise<TLSSocket> => {
  const socket = tls.connect({ socket: transport, key: identity.keyPem, cert: identity.certPem, rejectUnauthorized: false, ...TLS_VERSION,
    checkServerIdentity: () => undefined });
  const ready = new Promise<TLSSocket>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("close", () => reject(new ChannelError("The host closed the connection.", "closed")));
    socket.once("secureConnect", () => {
      const pin = peerSpkiSha256(socket);
      if (!pin || pin.length !== expectedHostSpki.length || !crypto.timingSafeEqual(pin, expectedHostSpki)) {
        reject(new ChannelError("The server's identity does not match. It may have been reinstalled, or the connection is being intercepted.", "host_identity_mismatch"));
        return;
      }
      socket.removeListener("error", reject);
      resolve(socket);
    });
  });
  return withTimeout(ready, timeoutMs, () => socket.destroy()).catch(error => { socket.destroy(); transport.destroy(); throw error; });
};

/** Host side: requires a client certificate and a fresh (never resumed) session. */
export const acceptTls = (transport: Duplex, identity: TlsIdentity, timeoutMs = 15_000): Promise<{ socket: TLSSocket; deviceSpkiSha256: Buffer }> => {
  const socket = new tls.TLSSocket(transport, { isServer: true, requestCert: true, rejectUnauthorized: false,
    secureContext: tls.createSecureContext({ key: identity.keyPem, cert: identity.certPem, ...TLS_VERSION }) });
  const ready = new Promise<{ socket: TLSSocket; deviceSpkiSha256: Buffer }>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("close", () => reject(new ChannelError("The device closed the connection.", "closed")));
    socket.once("secure", () => {
      const device = peerSpkiSha256(socket);
      if (!device) { reject(new ChannelError("The device presented no certificate.", "device_certificate_missing")); return; }
      if (socket.isSessionReused()) { reject(new ChannelError("Resumed sessions are not accepted.", "session_resumed")); return; }
      socket.removeListener("error", reject);
      resolve({ socket, deviceSpkiSha256: device });
    });
  });
  return withTimeout(ready, timeoutMs, () => socket.destroy()).catch(error => { socket.destroy(); transport.destroy(); throw error; });
};

/** Length-prefixed JSON messages over a TLS socket. Oversized or malformed input closes it. */
export class FramedChannel extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;

  constructor(readonly socket: TLSSocket) {
    super();
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    // A TLS socket over a JavaScript stream ends without closing: finish it here.
    socket.on("end", () => socket.destroy());
    socket.on("error", error => this.emit("failure", error));
    socket.on("close", () => { this.closed = true; this.emit("close"); });
  }

  get isOpen(): boolean { return !this.closed && !this.socket.destroyed; }

  send(message: object): boolean {
    if (!this.isOpen) return false;
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (body.length > MAX_FRAME_BYTES) throw new ChannelError("The message is too large.", "frame_too_large");
    const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
    return this.socket.write(Buffer.concat([size, body]));
  }

  close(): void { if (this.isOpen) this.socket.end(); }
  destroy(): void { this.socket.destroy(); }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0);
      if (size > MAX_FRAME_BYTES) { this.fail("frame_too_large"); return; }
      if (this.buffer.length < 4 + size) return;
      const body = this.buffer.subarray(4, 4 + size);
      this.buffer = this.buffer.subarray(4 + size);
      let message: unknown;
      try { message = JSON.parse(body.toString("utf8")); } catch { this.fail("invalid_frame"); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { this.fail("invalid_frame"); return; }
      this.emit("message", message);
      if (!this.isOpen) return;
    }
  }

  private fail(code: string): void {
    this.emit("failure", new ChannelError("The peer sent an invalid message.", code));
    this.socket.destroy();
  }
}
