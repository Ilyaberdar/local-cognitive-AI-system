import crypto from "crypto";
import { EventEmitter } from "events";
import type { Duplex } from "stream";
import { Logger } from "../../utils/Logger";
import { acceptTls, FramedChannel, MIN_PROTOCOL_VERSION, pairingExporter, pairingProof, PROTOCOL_VERSION } from "../channel";
import { encodeConnectionKey } from "../connectionKey";
import type { SigningIdentity, TlsIdentity } from "../identity";
import { helloMessage, MAX_REQUESTS_IN_FLIGHT, requestMessage, type HelloMessage } from "../messages";
import type { RemoteGrant, RemoteHostStore } from "./RemoteHostStore";

/** What the Cloud vouches for when it opens a stream: a consumed ticket for this account,
 * device (with its registered key) and purpose. */
export interface StreamOpen {
  streamId: string;
  purpose: "pair" | "connect";
  ticketId: string;
  accountId: string;
  deviceId: string;
  deviceSpkiSha256: string;
  deviceName?: string;
  invitationId?: string;
  /** Epoch ms: the session ends here and the device reconnects with a new ticket. */
  authExpiresAt: number;
}
/** Who asks, verified by the session; `signal` aborts when the device disconnects (long polls). */
export interface OperationContext { accountId: string; deviceId: string; signal: AbortSignal }
export type RemoteOperation = (payload: unknown, context: OperationContext) => unknown;
export class RemoteOperationError extends Error { constructor(message: string, readonly code: string) { super(message); } }

/** A grant that the Cloud must record: the host signs it so the Cloud can verify the claim. */
export interface ClaimReceipt { receiptId: string; hostId: string; invitationId: string; ticketId: string; accountId: string; deviceId: string; deviceSpkiSha256: string; grantedAt: string }

const HELLO_TIMEOUT_MS = 10_000;
const DENIALS: Record<string, string> = {
  device_key_mismatch: "This device's key is not the one registered for it.",
  hello_mismatch: "The connection request does not match the ticket.",
  invitation_unknown: "The connection key is unknown or has expired. Create a new one on the server.",
  invitation_used: "The connection key was already used. Create a new one on the server.",
  invitation_expired: "The connection key has expired. Create a new one on the server.",
  owner_mismatch: "This server belongs to another account.",
  proof_invalid: "The connection key is not valid for this server.",
  not_authorized: "This device has no access to this server. Connect it again with a new key.",
  protocol: "This version of Local Cognitive cannot talk to this server.",
  client_too_old: "Local Cognitive on this computer is too old for this server. Update the app on this computer.",
  server_too_old: "Local Cognitive on the server is older than this app. Update the server: sudo local-cognitive-server update --data-dir <data dir>."
};

/** The host end of Remote sessions (spec §6.2–6.3). Transport-agnostic: the agent hands it a
 * byte stream per device connection, normally a relayed WebSocket. */
export class RemoteHost extends EventEmitter {
  private readonly secrets = new Map<string, { secret: Buffer; expiresAt: number }>();
  private readonly sessions = new Map<string, Set<FramedChannel>>();

  constructor(private readonly options: {
    store: RemoteHostStore; tls: TlsIdentity; signing: SigningIdentity; hostName: string; serverVersion: string;
    environment: number; operations: Record<string, RemoteOperation>; logger?: Logger; now?: () => number;
  }) { super(); }

  get activeSessions(): number { return [...this.sessions.values()].reduce((sum, set) => sum + set.size, 0); }
  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** A one-time key for `connect-key`. The secret lives only in this process. */
  createInvitation(ttlMs = 10 * 60_000): { key: string; invitationId: string; expiresAt: number } {
    const hostId = this.options.store.hostId();
    if (!hostId) throw new RemoteOperationError("The server is not registered with Local Cognitive Cloud yet.", "not_registered");
    const invitationId = crypto.randomUUID(), secret = crypto.randomBytes(32), now = this.now();
    const expiresAt = Math.floor((now + ttlMs) / 1000) * 1000;
    this.options.store.createInvitation(invitationId, new Date(now), new Date(expiresAt));
    this.secrets.set(invitationId, { secret, expiresAt });
    for (const [id, entry] of this.secrets) if (entry.expiresAt <= now) this.secrets.delete(id);
    return { invitationId, expiresAt, key: encodeConnectionKey({ environment: this.options.environment, hostId, invitationId,
      hostSpkiSha256: this.options.tls.spkiSha256, secret, expiresAt: expiresAt / 1000 }) };
  }

  /** Serves one device connection until it closes. Never throws: failures close the stream. */
  async serve(transport: Duplex, open: StreamOpen): Promise<void> {
    let channel: FramedChannel | undefined;
    try {
      const { socket, deviceSpkiSha256 } = await acceptTls(transport, this.options.tls);
      channel = new FramedChannel(socket);
      channel.on("failure", (error: Error) => this.options.logger?.warn("Remote session error", { streamId: open.streamId, error: error.message }));
      const deny = (code: keyof typeof DENIALS) => {
        this.options.logger?.warn("Remote connection refused", { streamId: open.streamId, deviceId: open.deviceId, code });
        // The server's version, so the computer can say which side to update.
        channel!.send({ type: "denied", code, message: DENIALS[code], serverVersion: this.options.serverVersion.slice(0, 64) });
        channel!.close();
      };
      if (!timingSafeHexEqual(deviceSpkiSha256.toString("hex"), open.deviceSpkiSha256)) { deny("device_key_mismatch"); return; }
      // Requests before the welcome are a protocol violation, not something to queue.
      const premature = () => channel?.destroy();
      const hello = helloMessage.safeParse(await firstMessage(channel, HELLO_TIMEOUT_MS, premature));
      if (!hello.success) { deny("protocol"); return; }
      if (hello.data.protocol < MIN_PROTOCOL_VERSION) { deny("client_too_old"); return; }
      if (hello.data.protocol > PROTOCOL_VERSION) { deny("server_too_old"); return; }
      if (hello.data.purpose !== open.purpose || hello.data.accountId !== open.accountId || hello.data.deviceId !== open.deviceId
        || (open.purpose === "pair" && hello.data.invitationId !== open.invitationId)) { deny("hello_mismatch"); return; }
      const granted = open.purpose === "pair" ? this.pair(channel, open, hello.data, deviceSpkiSha256) : this.authorize(open);
      if (typeof granted === "string") { deny(granted); return; }
      this.options.store.touch(open.deviceId, new Date(this.now()));
      channel.removeListener("message", premature);
      // The computer's version within the range spoken here: the session runs at it.
      this.run(channel, open, granted, hello.data.protocol);
    } catch (error) {
      this.options.logger?.warn("Remote connection failed", { streamId: open.streamId, error: error instanceof Error ? error.message : String(error) });
      channel?.destroy(); transport.destroy();
    }
  }

  /** Closes every session of a device whose grant was revoked. */
  disconnectDevice(deviceId: string): void { for (const channel of this.sessions.get(deviceId) ?? []) shut(channel, "revoked"); }
  disconnectAll(reason: string): void { for (const set of this.sessions.values()) for (const channel of set) shut(channel, reason); }

  private pair(channel: FramedChannel, open: StreamOpen, hello: HelloMessage, deviceSpki: Buffer): RemoteGrant | keyof typeof DENIALS {
    const hostId = this.options.store.hostId();
    const invitation = this.secrets.get(open.invitationId ?? "");
    if (!hostId || !invitation || invitation.expiresAt <= this.now()) return "invitation_unknown";
    const expected = pairingProof(invitation.secret, pairingExporter(channel.socket, { hostId, invitationId: open.invitationId!, ticketId: open.ticketId,
      accountId: open.accountId, deviceId: open.deviceId, deviceSpkiSha256: deviceSpki, hostSpkiSha256: this.options.tls.spkiSha256 }));
    const proof = Buffer.from(hello.proof ?? "", "base64url");
    if (proof.length !== expected.length || !crypto.timingSafeEqual(proof, expected)) return "proof_invalid";
    const now = new Date(this.now()), receiptId = crypto.randomUUID();
    const claimed = this.options.store.claim({ invitationId: open.invitationId!, accountId: open.accountId, deviceId: open.deviceId,
      deviceSpkiSha256: deviceSpki.toString("hex"), deviceName: hello.deviceName ?? open.deviceName, receiptId, now });
    if (!claimed.ok) return claimed.code;
    this.secrets.delete(open.invitationId!);
    const receipt: ClaimReceipt = { receiptId, hostId, invitationId: open.invitationId!, ticketId: open.ticketId, accountId: open.accountId,
      deviceId: open.deviceId, deviceSpkiSha256: claimed.grant.deviceSpkiSha256, grantedAt: claimed.grant.grantedAt };
    this.options.store.saveReceipt(receiptId, receipt);
    this.options.logger?.info("Remote device paired", { deviceId: open.deviceId });
    this.emit("claimed", receipt);
    return claimed.grant;
  }

  private authorize(open: StreamOpen): RemoteGrant | keyof typeof DENIALS {
    const grant = this.options.store.activeGrant(open.deviceId);
    if (!grant || grant.accountId !== open.accountId || this.options.store.owner() !== open.accountId
      || !timingSafeHexEqual(grant.deviceSpkiSha256, open.deviceSpkiSha256)) return "not_authorized";
    return grant;
  }

  private run(channel: FramedChannel, open: StreamOpen, grant: RemoteGrant, protocol = PROTOCOL_VERSION): void {
    const hostId = this.options.store.hostId()!;
    let set = this.sessions.get(grant.deviceId);
    if (!set) this.sessions.set(grant.deviceId, set = new Set());
    set.add(channel);
    const expiry = setTimeout(() => shut(channel, "auth_expired"), Math.max(0, open.authExpiresAt - this.now()));
    expiry.unref?.();
    const closed = new AbortController();
    channel.once("close", () => { closed.abort(); clearTimeout(expiry); set!.delete(channel); if (!set!.size) this.sessions.delete(grant.deviceId); });
    channel.send({ type: "welcome", protocol, hostId, hostName: this.options.hostName, serverVersion: this.options.serverVersion,
      capabilities: Object.keys(this.options.operations), authExpiresAt: open.authExpiresAt });
    let inFlight = 0;
    const context: OperationContext = { accountId: grant.accountId, deviceId: grant.deviceId, signal: closed.signal };
    // A result that cannot be framed is an error for this request, not a crash of the host.
    const reply = (message: object, id: number) => {
      try { channel.send(message); }
      catch { channel.send({ type: "error", id, code: "response_too_large", message: "The answer is too large to send." }); }
    };
    channel.on("message", (message: unknown) => {
      const request = requestMessage.safeParse(message);
      if (!request.success) { channel.destroy(); return; }
      const { id, op, payload } = request.data;
      if (inFlight >= MAX_REQUESTS_IN_FLIGHT) { channel.send({ type: "error", id, code: "too_many_requests", message: "Too many requests at once." }); return; }
      const operation = Object.hasOwn(this.options.operations, op) ? this.options.operations[op] : undefined;
      if (!operation) { channel.send({ type: "error", id, code: "unknown_operation", message: `The server does not support ${op}.` }); return; }
      inFlight++;
      void Promise.resolve().then(() => operation(payload, context)).then(
        result => reply({ type: "response", id, result }, id),
        (error: unknown) => {
          const known = error instanceof RemoteOperationError;
          if (!known) this.options.logger?.warn("Remote operation failed", { op, error: error instanceof Error ? error.message : String(error) });
          reply({ type: "error", id, code: known ? error.code : "operation_failed", message: known ? error.message : "The operation failed on the server." }, id);
        }
      ).catch(error => this.options.logger?.warn("Remote reply failed", { op, error: error instanceof Error ? error.message : String(error) }))
        .finally(() => { inFlight--; });
    });
  }
}

/** Tells the device why, closes cleanly, and cuts the stream if the device does not finish. */
const shut = (channel: FramedChannel, reason: string) => {
  channel.send({ type: "closing", reason });
  channel.close();
  setTimeout(() => channel.destroy(), 1000).unref?.();
};

const timingSafeHexEqual = (left: string, right: string) => {
  const a = Buffer.from(left, "hex"), b = Buffer.from(right, "hex");
  return a.length === 32 && b.length === 32 && crypto.timingSafeEqual(a, b);
};

/** The first message; any message after it, until `premature` is removed, goes to `premature`. */
const firstMessage = (channel: FramedChannel, timeoutMs: number, premature: () => void): Promise<unknown> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { cleanup(); reject(new Error("No hello from the device.")); }, timeoutMs);
  const onMessage = (message: unknown) => { cleanup(); channel.on("message", premature); resolve(message); };
  const onClose = () => { cleanup(); reject(new Error("The device closed the connection.")); };
  const cleanup = () => { clearTimeout(timer); channel.removeListener("message", onMessage); channel.removeListener("close", onClose); };
  channel.once("message", onMessage);
  channel.once("close", onClose);
});
