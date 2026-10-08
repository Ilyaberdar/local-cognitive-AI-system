import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import type { Logger } from "../log.js";
import type { ClaimReceipt, ConsumedTicket, RemoteRepository, Revocation } from "./remoteRepository.js";
import { relayAuthMessage, SIGNATURE_CONTEXT, verifyHostSignature } from "./signatures.js";

/** Close codes seen by hosts and devices. */
export const CLOSE = { auth: 4401, revoked: 4403, hostOffline: 4404, authTimeout: 4408, replaced: 4409, authExpired: 4410, limit: 4429 } as const;
export const RELAY_PATHS = { host: "/v1/relay/host", client: "/v1/relay/client", hostStream: "/v1/relay/host/stream" } as const;

export interface RelayLimits { sessionsPerAccount: number; sessionsPerHost: number; sessionsPerUnclaimedHost: number; authTimeoutMs: number;
  attachTimeoutMs: number; heartbeatMs: number; highWaterBytes: number; lowWaterBytes: number }
export const defaultRelayLimits: RelayLimits = { sessionsPerAccount: 8, sessionsPerHost: 16, sessionsPerUnclaimedHost: 2, authTimeoutMs: 10_000,
  attachTimeoutMs: 10_000, heartbeatMs: 25_000, highWaterBytes: 1024 * 1024, lowWaterBytes: 256 * 1024 };
const MAX_MESSAGE_BYTES = 64 * 1024;
const AUTH_GRACE_MS = 30_000;

const uuid = z.uuid();
const b64 = (bytes: number) => z.string().regex(/^[A-Za-z0-9_-]+$/).transform(value => Buffer.from(value, "base64url")).refine(value => value.length === bytes);
const hostHello = z.object({ type: z.literal("hello"), hostId: uuid, protocol: z.literal(1), lastRevocationSeq: z.number().int().nonnegative() });
const hostAuth = z.object({ type: z.literal("auth"), signature: b64(64) });
const signed = z.object({ payload: z.string().max(8192).regex(/^[A-Za-z0-9_-]+$/), signature: b64(64) });
const hostMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("invitation.announce"), invitationId: uuid, expiresAt: z.number().int().positive() }),
  signed.extend({ type: z.literal("claim.confirm") }),
  signed.extend({ type: z.literal("grant.revoke") })
]);
const receiptSchema = z.object({ receiptId: uuid, hostId: uuid, invitationId: uuid, ticketId: uuid, accountId: uuid, deviceId: uuid,
  deviceSpkiSha256: z.string().regex(/^[0-9a-f]{64}$/), grantedAt: z.iso.datetime() });
const revokeSchema = z.object({ hostId: uuid, kind: z.enum(["device", "host"]), deviceId: uuid.optional(), at: z.iso.datetime() });
const clientAuth = z.object({ type: z.literal("auth"), ticket: b64(32) });
const attach = z.object({ type: z.literal("attach"), streamId: uuid, streamToken: b64(32) });

interface HostConnection { hostId: string; socket: WebSocket; ownerAccountId: string | null }
interface PendingStream { client: WebSocket; ticket: ConsumedTicket; tokenHash: Buffer; timer: NodeJS.Timeout }
interface ActiveStream { client: WebSocket; host: WebSocket; ticket: ConsumedTicket; timer: NodeJS.Timeout }

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest();
const text = (data: RawData): string => Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8");
const send = (socket: WebSocket, message: object) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
/** A paused socket could not read the peer's close frame and would wait out the close timeout. */
const close = (socket: WebSocket, code: number, reason: string) => {
  if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) return;
  if (socket.isPaused) socket.resume();
  socket.close(code, reason);
};

/** The first text message, parsed; binary data or silence closes the socket. */
const firstMessage = <T>(socket: WebSocket, schema: z.ZodType<T>, timeoutMs: number): Promise<T | undefined> => new Promise(resolve => {
  const timer = setTimeout(() => { done(undefined); close(socket, CLOSE.authTimeout, "auth_timeout"); }, timeoutMs);
  const onMessage = (data: RawData, binary: boolean) => {
    let parsed: unknown;
    try { parsed = binary ? undefined : JSON.parse(text(data)); } catch { parsed = undefined; }
    const result = schema.safeParse(parsed);
    done(result.success ? result.data : undefined);
    if (!result.success) close(socket, CLOSE.auth, "invalid");
  };
  const onClose = () => done(undefined);
  const done = (value: T | undefined) => { clearTimeout(timer); socket.off("message", onMessage); socket.off("close", onClose); resolve(value); };
  socket.once("message", onMessage);
  socket.once("close", onClose);
});

/** Routes device connections to hosts. It authenticates hosts and consumes tickets, then only
 * moves bytes: the TLS session inside is end-to-end between device and host. One replica. */
export class Relay {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false, clientTracking: false });
  private readonly hosts = new Map<string, HostConnection>();
  private readonly pending = new Map<string, PendingStream>();
  private readonly streams = new Map<string, ActiveStream>();
  private readonly alive = new Map<WebSocket, boolean>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly limits: RelayLimits;

  constructor(private readonly deps: { repo: RemoteRepository; origin: string; logger?: Logger; limits?: Partial<RelayLimits> }) {
    this.limits = { ...defaultRelayLimits, ...deps.limits };
    this.heartbeat = setInterval(() => {
      for (const [socket, alive] of this.alive) {
        if (!alive) { socket.terminate(); continue; }
        this.alive.set(socket, false);
        socket.ping();
      }
    }, this.limits.heartbeatMs);
    this.heartbeat.unref();
  }

  isOnline(hostId: string): boolean { return this.hosts.has(hostId); }

  /** For http.Server "upgrade": anything but the three relay paths is refused. */
  readonly handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const pathname = new URL(request.url ?? "/", "http://relay").pathname;
    if (!(Object.values(RELAY_PATHS) as string[]).includes(pathname)) { socket.destroy(); return; }
    this.server.handleUpgrade(request, socket, head, ws => {
      this.alive.set(ws, true);
      ws.on("pong", () => this.alive.set(ws, true));
      ws.on("close", () => this.alive.delete(ws));
      ws.on("error", () => ws.terminate());
      const accept = pathname === RELAY_PATHS.host ? this.acceptHost(ws) : pathname === RELAY_PATHS.client ? this.acceptClient(ws) : this.acceptHostStream(ws);
      accept.catch(error => { this.deps.logger?.error("Relay connection failed", { error: error instanceof Error ? error.message : String(error) }); close(ws, 1011, "error"); });
    });
  };

  pushRevocation(hostId: string, revocation: Revocation): void {
    const host = this.hosts.get(hostId);
    if (host) send(host.socket, { type: "revocation", ...revocation });
  }
  disconnectDevice(hostId: string, deviceId: string): void {
    for (const [streamId, stream] of this.streams) if (stream.ticket.hostId === hostId && stream.ticket.deviceId === deviceId) this.endStream(streamId, CLOSE.revoked, "revoked");
  }
  disconnectHost(hostId: string): void {
    for (const [streamId, stream] of this.streams) if (stream.ticket.hostId === hostId) this.endStream(streamId, CLOSE.revoked, "revoked");
    const host = this.hosts.get(hostId);
    if (host) host.ownerAccountId = null;
  }

  /** Tells every peer to reconnect later; sockets that do not finish closing are cut shortly after. */
  close(): void {
    clearInterval(this.heartbeat);
    for (const socket of this.alive.keys()) {
      close(socket, 1001, "shutdown");
      setTimeout(() => socket.terminate(), 500).unref();
    }
    this.server.close();
  }

  private async acceptHost(socket: WebSocket): Promise<void> {
    const hello = await firstMessage(socket, hostHello, this.limits.authTimeoutMs);
    if (!hello) return;
    const host = await this.deps.repo.host(hello.hostId);
    if (!host || host.blocked) { close(socket, CLOSE.auth, "unknown_host"); return; }
    const nonce = randomBytes(32).toString("base64url");
    send(socket, { type: "challenge", nonce });
    const auth = await firstMessage(socket, hostAuth, this.limits.authTimeoutMs);
    if (!auth) return;
    if (!verifyHostSignature(host.signingPublicKey, SIGNATURE_CONTEXT.relayAuth, relayAuthMessage(host.id, nonce, this.deps.origin), auth.signature)) {
      close(socket, CLOSE.auth, "signature"); return;
    }
    const previous = this.hosts.get(host.id);
    if (previous) close(previous.socket, CLOSE.replaced, "replaced");
    const connection: HostConnection = { hostId: host.id, socket, ownerAccountId: host.ownerAccountId };
    this.hosts.set(host.id, connection);
    socket.on("close", () => { if (this.hosts.get(host.id) === connection) this.hosts.delete(host.id); });
    await this.deps.repo.touchHost(host.id);
    send(socket, { type: "ready", ownerAccountId: host.ownerAccountId, revocations: await this.deps.repo.revocationsAfter(host.id, hello.lastRevocationSeq) });
    socket.on("message", (data, binary) => {
      if (binary) { close(socket, CLOSE.auth, "binary"); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(text(data)); } catch { parsed = undefined; }
      const message = hostMessage.safeParse(parsed);
      if (!message.success) { this.deps.logger?.warn("Relay ignored a host message", { hostId: host.id }); return; }
      void this.onHostMessage(connection, host.signingPublicKey, message.data).catch(error =>
        this.deps.logger?.error("Relay host message failed", { hostId: host.id, error: error instanceof Error ? error.message : String(error) }));
    });
  }

  private async onHostMessage(connection: HostConnection, signingKey: Buffer, message: z.infer<typeof hostMessage>): Promise<void> {
    const { hostId, socket } = connection;
    if (message.type === "invitation.announce") {
      // A key lives at most an hour; longer announcements are capped.
      await this.deps.repo.announceInvitation(hostId, message.invitationId, new Date(Math.min(message.expiresAt, Date.now() + 3_600_000)));
      return;
    }
    const payload = Buffer.from(message.payload, "base64url");
    const context = message.type === "claim.confirm" ? SIGNATURE_CONTEXT.claim : SIGNATURE_CONTEXT.revoke;
    let body: unknown;
    try { body = verifyHostSignature(signingKey, context, payload, message.signature) ? JSON.parse(payload.toString("utf8")) : undefined; } catch { body = undefined; }
    if (message.type === "claim.confirm") {
      const receipt = receiptSchema.safeParse(body);
      if (!receipt.success || receipt.data.hostId !== hostId) { send(socket, { type: "claim.reject", code: "invalid_receipt", ...(receipt.success ? { receiptId: receipt.data.receiptId } : {}) }); return; }
      const result = await this.deps.repo.recordClaim(receipt.data as ClaimReceipt, payload, message.signature);
      if (result === "recorded" || result === "duplicate") {
        connection.ownerAccountId = receipt.data.accountId;
        send(socket, { type: "claim.ack", receiptId: receipt.data.receiptId });
      } else send(socket, { type: "claim.reject", receiptId: receipt.data.receiptId, code: result });
      return;
    }
    const revoke = revokeSchema.safeParse(body);
    if (!revoke.success || revoke.data.hostId !== hostId || (revoke.data.kind === "device" && !revoke.data.deviceId)) return;
    const revocation = revoke.data.kind === "device"
      ? await this.deps.repo.revokeDevice(hostId, revoke.data.deviceId!, null, "host")
      : await this.deps.repo.unlinkHost(hostId, null, "host");
    if (revoke.data.kind === "device") this.disconnectDevice(hostId, revoke.data.deviceId!); else this.disconnectHost(hostId);
    if (revocation) send(socket, { type: "revocation", ...revocation });
  }

  private async acceptClient(socket: WebSocket): Promise<void> {
    const auth = await firstMessage(socket, clientAuth, this.limits.authTimeoutMs);
    if (!auth) return;
    // Nothing the device sends before the host attaches may reach it.
    socket.pause();
    const ticket = await this.deps.repo.consumeTicket(auth.ticket);
    if (!ticket) { close(socket, CLOSE.auth, "ticket"); return; }
    const host = this.hosts.get(ticket.hostId);
    if (!host) { close(socket, CLOSE.hostOffline, "host_offline"); return; }
    const sessions = [...this.streams.values(), ...this.pending.values()];
    const onHost = sessions.filter(stream => stream.ticket.hostId === ticket.hostId).length;
    if (sessions.filter(stream => stream.ticket.accountId === ticket.accountId).length >= this.limits.sessionsPerAccount
      || onHost >= (host.ownerAccountId ? this.limits.sessionsPerHost : this.limits.sessionsPerUnclaimedHost)
      || (!host.ownerAccountId && ticket.purpose !== "pair")) {
      close(socket, CLOSE.limit, "too_many_sessions"); return;
    }
    const streamId = randomUUID(), token = randomBytes(32);
    const timer = setTimeout(() => { this.pending.delete(streamId); close(socket, CLOSE.hostOffline, "host_unavailable"); }, this.limits.attachTimeoutMs);
    this.pending.set(streamId, { client: socket, ticket, tokenHash: sha256(token), timer });
    socket.once("close", () => { const pending = this.pending.get(streamId); if (pending) { clearTimeout(pending.timer); this.pending.delete(streamId); } });
    send(host.socket, { type: "stream.open", streamId, streamToken: token.toString("base64url"), purpose: ticket.purpose, ticketId: ticket.ticketId,
      accountId: ticket.accountId, deviceId: ticket.deviceId, deviceSpkiSha256: ticket.deviceSpkiSha256.toString("hex"), deviceName: ticket.deviceName,
      ...(ticket.invitationId ? { invitationId: ticket.invitationId } : {}), authExpiresAt: ticket.authExpiresAt.getTime() });
  }

  private async acceptHostStream(socket: WebSocket): Promise<void> {
    const message = await firstMessage(socket, attach, this.limits.authTimeoutMs);
    if (!message) return;
    const pending = this.pending.get(message.streamId);
    if (!pending || !timingSafeEqual(sha256(message.streamToken), pending.tokenHash)) { close(socket, CLOSE.auth, "stream"); return; }
    this.pending.delete(message.streamId);
    clearTimeout(pending.timer);
    const { client, ticket } = pending;
    if (client.readyState !== WebSocket.OPEN) { close(socket, 1001, "gone"); return; }
    const timer = setTimeout(() => this.endStream(message.streamId, CLOSE.authExpired, "auth_expired"), Math.max(0, ticket.authExpiresAt.getTime() + AUTH_GRACE_MS - Date.now()));
    this.streams.set(message.streamId, { client, host: socket, ticket, timer });
    this.pipe(client, socket);
    this.pipe(socket, client);
    const finish = (code: number, reason: Buffer) => {
      const stream = this.streams.get(message.streamId);
      if (!stream) return;
      clearTimeout(stream.timer);
      this.streams.delete(message.streamId);
      // Either side leaving ends the stream; relay close codes pass through to the peer.
      for (const side of [client, socket]) close(side, code >= 4000 && code < 5000 ? code : 1000, reason.toString() || "closed");
    };
    client.once("close", finish);
    socket.once("close", finish);
    send(client, { type: "connected" });
    client.resume();
  }

  /** Binary messages only, with backpressure: a slow reader pauses the sender. */
  private pipe(from: WebSocket, to: WebSocket): void {
    let paused = false;
    from.on("message", (data, binary) => {
      if (!binary || to.readyState !== WebSocket.OPEN) return;
      to.send(data, { binary: true }, () => {
        if (paused && to.bufferedAmount < this.limits.lowWaterBytes) { paused = false; from.resume(); }
      });
      if (!paused && to.bufferedAmount > this.limits.highWaterBytes) { paused = true; from.pause(); }
    });
  }

  private endStream(streamId: string, code: number, reason: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    clearTimeout(stream.timer);
    this.streams.delete(streamId);
    close(stream.client, code, reason);
    close(stream.host, code, reason);
  }
}
