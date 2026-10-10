import { diagnostics } from "../../diagnostics/DiagnosticLog";
import { errorCategory } from "../../diagnostics/errorCategory";
import { EventEmitter } from "events";
import WebSocket from "ws";
import { z } from "zod";
import type { CredentialVault } from "../../plugins/contracts";
import { Logger } from "../../utils/Logger";
import { environmentOf } from "../connectionKey";
import { createSigningIdentity, createTlsIdentity, loadSigningIdentity, loadTlsIdentity, signFor, type SigningIdentity, type TlsIdentity } from "../identity";
import { relayAuthMessage, SIGNATURE_CONTEXT } from "../messages";
import { wsDuplex } from "../wsDuplex";
import { RemoteHost, RemoteOperationError, type ClaimReceipt, type RemoteOperation } from "./RemoteHost";
import type { RemoteGrant, RemoteHostStore } from "./RemoteHostStore";

export const HOST_IDENTITY_KEY = "remote/host-identity";
const PROTOCOL = 1;
const MAX_MESSAGE_BYTES = 64 * 1024;

export type AgentState = "starting" | "registering" | "connecting" | "online" | "offline" | "stopped";
export interface AgentStatus { state: AgentState; hostId?: string; claimed: boolean; devices: number; sessions: number; cloudUrl: string; lastError?: string }

const uuid = z.uuid();
const controlMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("challenge"), nonce: z.string().min(16).max(128) }),
  z.object({ type: z.literal("ready"), ownerAccountId: uuid.nullable(), revocations: z.array(z.object({ seq: z.number().int().positive(), kind: z.enum(["device", "host"]), deviceId: uuid.nullable() })) }),
  z.object({ type: z.literal("stream.open"), streamId: uuid, streamToken: z.string().min(16).max(128), purpose: z.enum(["pair", "connect"]), ticketId: uuid,
    accountId: uuid, deviceId: uuid, deviceSpkiSha256: z.string().regex(/^[0-9a-f]{64}$/), deviceName: z.string().max(120).optional(),
    invitationId: uuid.optional(), authExpiresAt: z.number().int().positive() }),
  z.object({ type: z.literal("claim.ack"), receiptId: uuid }),
  z.object({ type: z.literal("claim.reject"), receiptId: uuid.optional(), code: z.string().max(64) }),
  z.object({ type: z.literal("revocation"), seq: z.number().int().positive(), kind: z.enum(["device", "host"]), deviceId: uuid.nullable() })
]);

/** The host's link to Local Cognitive Cloud: registers once, keeps an outbound control
 * connection, and dials a separate WebSocket for every device stream the relay announces. */
export class HostAgent extends EventEmitter {
  private state: AgentState = "starting";
  private control?: WebSocket;
  private remote?: RemoteHost;
  private identity?: { tls: TlsIdentity; signing: SigningIdentity };
  private attempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private lastError?: string;
  private stopped = false;
  private readonly origin: string;
  private readonly wsOrigin: string;

  constructor(private readonly options: {
    cloudUrl: string; store: RemoteHostStore; vault: CredentialVault; hostName: string; serverVersion: string;
    operations: Record<string, RemoteOperation>; logger: Logger; fetchImpl?: typeof fetch; backoff?: { baseMs: number; maxMs: number };
  }) {
    super();
    this.origin = new URL(options.cloudUrl).origin;
    this.wsOrigin = this.origin.replace(/^http/, "ws");
  }

  async start(): Promise<void> {
    this.identity = await this.loadIdentity();
    this.remote = new RemoteHost({ store: this.options.store, tls: this.identity.tls, signing: this.identity.signing, hostName: this.options.hostName,
      serverVersion: this.options.serverVersion, environment: environmentOf(this.origin), operations: this.options.operations, logger: this.options.logger });
    this.remote.on("claimed", (receipt: ClaimReceipt) => this.sendClaim(receipt));
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.setState("stopped");
    clearTimeout(this.reconnectTimer); clearTimeout(this.watchdog);
    this.remote?.disconnectAll("shutdown");
    this.control?.close(1001);
  }

  status(): AgentStatus {
    const grants = this.options.store.grants().filter(grant => grant.status === "active");
    return { state: this.state, hostId: this.options.store.hostId(), claimed: Boolean(this.options.store.owner()), devices: grants.length,
      sessions: this.remote?.activeSessions ?? 0, cloudUrl: this.origin, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  /** A one-time connection key. The Cloud must know the invitation, so the host must be online. */
  connectKey(ttlMs: number): { key: string; invitationId: string; expiresAt: number; hostId: string; claimed: boolean } {
    if (this.state !== "online" || !this.remote) throw new RemoteOperationError(`The server is not connected to ${this.origin}${this.lastError ? ` (${this.lastError})` : ""}. Try again shortly.`, "offline");
    const invitation = this.remote.createInvitation(ttlMs);
    this.send({ type: "invitation.announce", invitationId: invitation.invitationId, expiresAt: invitation.expiresAt });
    return { key: invitation.key, invitationId: invitation.invitationId, expiresAt: invitation.expiresAt, hostId: this.options.store.hostId()!, claimed: Boolean(this.options.store.owner()) };
  }

  devices(): RemoteGrant[] { return this.options.store.grants(); }

  /** Whether a key from connectKey was used, and by which computer. */
  invitation(invitationId: string) { return this.options.store.invitation(invitationId) ?? { consumed: false }; }

  /** The paired computers connected right now, by name (for the server's console). */
  connectedDevices(): Array<{ deviceId: string; deviceName?: string }> {
    const connected = new Set(this.remote?.connectedDeviceIds ?? []);
    return this.options.store.grants().filter(grant => connected.has(grant.deviceId)).map(({ deviceId, deviceName }) => ({ deviceId, ...(deviceName ? { deviceName } : {}) }));
  }

  /** Revokes locally at once (the host enforces it) and tells the Cloud when online. */
  revokeDevice(deviceId: string): boolean {
    const revoked = this.options.store.revoke(deviceId, "host", new Date());
    this.remote?.disconnectDevice(deviceId);
    if (revoked) this.sendRevoke("device", deviceId);
    return revoked;
  }

  /** Removes the owner and every grant; the next key can be claimed by any account. */
  resetOwner(): void {
    this.options.store.unlink("host", new Date());
    this.remote?.disconnectAll("revoked");
    this.sendRevoke("host");
  }

  private async loadIdentity(): Promise<{ tls: TlsIdentity; signing: SigningIdentity }> {
    const saved = await this.options.vault.read(HOST_IDENTITY_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as { tls: { keyPem: string; certPem: string }; signingKeyPem: string };
      return { tls: loadTlsIdentity(parsed.tls), signing: loadSigningIdentity(parsed.signingKeyPem) };
    }
    const tls = createTlsIdentity("local-cognitive-host"), signing = createSigningIdentity();
    await this.options.vault.write(HOST_IDENTITY_KEY, JSON.stringify({ tls: { keyPem: tls.keyPem, certPem: tls.certPem }, signingKeyPem: signing.privateKeyPem }));
    this.options.logger.info("Created the Remote host identity");
    return { tls, signing };
  }

  private async register(): Promise<string> {
    this.setState("registering");
    const { tls, signing } = this.identity!;
    const payload = Buffer.from(JSON.stringify({ signingPublicKey: signing.publicKey.toString("base64url"), tlsSpkiSha256: tls.spkiSha256.toString("hex"),
      name: this.options.hostName.slice(0, 120) || "Local Cognitive server", appVersion: this.options.serverVersion.slice(0, 64), protocol: PROTOCOL }));
    const response = await (this.options.fetchImpl ?? fetch)(`${this.origin}/v1/hosts/register`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: payload.toString("base64url"), signature: signFor(signing, SIGNATURE_CONTEXT.register, payload).toString("base64url") }),
      signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Registration failed: HTTP ${response.status}`);
    const { hostId } = await response.json() as { hostId: string };
    this.options.store.setHostId(uuid.parse(hostId));
    this.options.logger.info("Registered with Local Cognitive Cloud", { hostId });
    return hostId;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      // Registration is idempotent by key: it also refreshes the TLS key and version.
      const hostId = this.options.store.hostId() ?? await this.register();
      this.setState("connecting");
      const socket = new WebSocket(`${this.wsOrigin}/v1/relay/host`, { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false, handshakeTimeout: 15_000 });
      this.control = socket;
      socket.on("open", () => socket.send(JSON.stringify({ type: "hello", hostId, protocol: PROTOCOL, lastRevocationSeq: this.options.store.revocationSeq(),
        appVersion: this.options.serverVersion })));
      socket.on("ping", () => this.arm(socket));
      socket.on("message", (data, binary) => { if (!binary) this.onControl(socket, hostId, data.toString()); });
      socket.on("error", error => { this.lastError = error.message; });
      socket.on("close", (code, reason) => this.onClose(socket, code, reason.toString()));
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      diagnostics().record("remote.host_event", { event: "connect_failed", code: errorCategory(error) });
      this.schedule();
    }
  }

  private onControl(socket: WebSocket, hostId: string, text: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    const message = controlMessage.safeParse(parsed);
    if (!message.success) { this.options.logger.warn("Ignored a malformed Cloud message"); return; }
    const data = message.data;
    switch (data.type) {
      case "challenge":
        socket.send(JSON.stringify({ type: "auth", signature: signFor(this.identity!.signing, SIGNATURE_CONTEXT.relayAuth, relayAuthMessage(hostId, data.nonce, this.origin)).toString("base64url") }));
        return;
      case "ready":
        this.attempt = 0; this.lastError = undefined;
        this.setState("online");
        this.arm(socket);
        for (const revocation of data.revocations) this.applyRevocation(revocation);
        // The Cloud may have missed these while the host was offline.
        for (const grant of this.options.store.unsynced()) {
          const receipt = this.options.store.receipt(grant.receiptId) as ClaimReceipt | undefined;
          if (receipt) this.sendClaim(receipt);
        }
        for (const grant of this.options.store.unsyncedRevocations()) this.sendRevoke("device", grant.deviceId);
        return;
      case "stream.open":
        this.openStream(data);
        return;
      case "claim.ack":
        this.options.store.markSynced(data.receiptId, new Date());
        return;
      case "claim.reject": {
        // The Cloud did not accept this pairing: the host must not keep the grant either.
        const grant = data.receiptId ? this.options.store.grantByReceipt(data.receiptId) : undefined;
        this.options.logger.warn("Cloud rejected a device pairing", { code: data.code, deviceId: grant?.deviceId });
        if (grant) { this.options.store.revoke(grant.deviceId, "cloud", new Date()); this.remote?.disconnectDevice(grant.deviceId); }
        return;
      }
      case "revocation":
        this.applyRevocation(data);
    }
  }

  private applyRevocation(revocation: { seq: number; kind: "device" | "host"; deviceId: string | null }): void {
    const applied = this.options.store.applyRevocation({ seq: revocation.seq, kind: revocation.kind, ...(revocation.deviceId ? { deviceId: revocation.deviceId } : {}) }, new Date());
    if (!applied) return;
    this.options.logger.info("Applied a Remote revocation", { kind: revocation.kind, deviceId: revocation.deviceId });
    if (revocation.kind === "host") this.remote?.disconnectAll("revoked"); else if (revocation.deviceId) this.remote?.disconnectDevice(revocation.deviceId);
  }

  private openStream(open: z.infer<typeof controlMessage> & { type: "stream.open" }): void {
    const socket = new WebSocket(`${this.wsOrigin}/v1/relay/host/stream`, { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false, handshakeTimeout: 10_000 });
    socket.on("error", error => this.options.logger.warn("Remote stream failed", { streamId: open.streamId, error: error.message }));
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "attach", streamId: open.streamId, streamToken: open.streamToken }));
      void this.remote!.serve(wsDuplex(socket), { streamId: open.streamId, purpose: open.purpose, ticketId: open.ticketId, accountId: open.accountId,
        deviceId: open.deviceId, deviceSpkiSha256: open.deviceSpkiSha256, ...(open.deviceName ? { deviceName: open.deviceName } : {}),
        ...(open.invitationId ? { invitationId: open.invitationId } : {}), authExpiresAt: open.authExpiresAt });
    });
  }

  /** Signs a usage batch for the Cloud (spec §10); nothing before the identity is loaded. */
  signUsage(payload: Buffer): Buffer | undefined {
    return this.identity ? signFor(this.identity.signing, SIGNATURE_CONTEXT.usageBatch, payload) : undefined;
  }

  private sendClaim(receipt: ClaimReceipt): void {
    const payload = Buffer.from(JSON.stringify(receipt));
    this.send({ type: "claim.confirm", payload: payload.toString("base64url"), signature: signFor(this.identity!.signing, SIGNATURE_CONTEXT.claim, payload).toString("base64url") });
  }

  private sendRevoke(kind: "device" | "host", deviceId?: string): void {
    const hostId = this.options.store.hostId();
    if (!hostId) return;
    const payload = Buffer.from(JSON.stringify({ hostId, kind, ...(deviceId ? { deviceId } : {}), at: new Date().toISOString() }));
    this.send({ type: "grant.revoke", payload: payload.toString("base64url"), signature: signFor(this.identity!.signing, SIGNATURE_CONTEXT.revoke, payload).toString("base64url") });
  }

  private send(message: object): void {
    if (this.state === "online" && this.control?.readyState === WebSocket.OPEN) this.control.send(JSON.stringify(message));
  }

  /** The Cloud pings every 25 s; silence for a minute means the connection is gone. */
  private arm(socket: WebSocket): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => socket.terminate(), 60_000);
    this.watchdog.unref();
  }

  private onClose(socket: WebSocket, code: number, reason: string): void {
    if (this.control !== socket) return;
    clearTimeout(this.watchdog);
    this.control = undefined;
    if (this.stopped) return;
    if (code === 4401 && reason === "unknown_host") {
      // The Cloud no longer knows this host (for example a fresh Cloud database): register again.
      this.options.logger.warn("Cloud does not know this host; registering again");
      this.options.store.clearHostId();
    } else if (code === 4409) this.options.logger.warn("Another process connected as this host");
    this.lastError ??= `closed (${code}${reason ? ` ${reason}` : ""})`;
    diagnostics().record("remote.host_event", { event: "control_closed", code: `ws_${code}` });
    this.setState("offline");
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.setState("offline");
    const { baseMs, maxMs } = this.options.backoff ?? { baseMs: 1000, maxMs: 60_000 };
    const delay = Math.min(maxMs, baseMs * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
    this.reconnectTimer.unref();
  }

  private setState(state: AgentState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }
}
