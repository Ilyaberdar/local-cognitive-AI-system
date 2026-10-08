import { EventEmitter } from "events";
import type { Duplex } from "stream";
import { ChannelError, connectTls, FramedChannel, pairingExporter, pairingProof, PROTOCOL_VERSION } from "../channel";
import type { TlsIdentity } from "../identity";
import { closingMessage, deniedMessage, errorMessage, MAX_REQUESTS_IN_FLIGHT, responseMessage, welcomeMessage, type WelcomeMessage } from "../messages";

export class RemoteRequestError extends Error { constructor(message: string, readonly code: string) { super(message); } }

export interface SessionStart {
  identity: TlsIdentity;
  /** Pinned host key: from the connection key when pairing, from the saved profile afterwards. */
  hostSpkiSha256: Buffer;
  purpose: "pair" | "connect";
  hostId: string;
  ticketId: string;
  accountId: string;
  deviceId: string;
  deviceName?: string;
  /** Pairing only. */
  invitationId?: string;
  secret?: Buffer;
  timeoutMs?: number;
}

/** The device end of a Remote session: authenticates, then sends requests to the host. */
export class RemoteSession extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  closeReason?: string;

  private constructor(private readonly channel: FramedChannel, readonly welcome: WelcomeMessage) {
    super();
    channel.on("message", (message: unknown) => this.receive(message));
    channel.once("close", () => {
      for (const [, request] of this.pending) { clearTimeout(request.timer); request.reject(new RemoteRequestError("The connection to the server was lost.", "disconnected")); }
      this.pending.clear();
      this.emit("close", this.closeReason);
    });
  }

  static async open(transport: Duplex, start: SessionStart): Promise<RemoteSession> {
    const socket = await connectTls(transport, start.identity, start.hostSpkiSha256, start.timeoutMs);
    const channel = new FramedChannel(socket);
    const proof = start.purpose === "pair" && start.secret && start.invitationId
      ? pairingProof(start.secret, pairingExporter(socket, { hostId: start.hostId, invitationId: start.invitationId, ticketId: start.ticketId,
        accountId: start.accountId, deviceId: start.deviceId, deviceSpkiSha256: start.identity.spkiSha256, hostSpkiSha256: start.hostSpkiSha256 })).toString("base64url")
      : undefined;
    channel.send({ type: "hello", protocol: PROTOCOL_VERSION, purpose: start.purpose, accountId: start.accountId, deviceId: start.deviceId,
      ...(start.deviceName ? { deviceName: start.deviceName } : {}), ...(start.invitationId ? { invitationId: start.invitationId } : {}), ...(proof ? { proof } : {}) });
    const first = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { channel.destroy(); reject(new ChannelError("The server did not answer.", "timeout")); }, start.timeoutMs ?? 15_000);
      channel.once("message", message => { clearTimeout(timer); resolve(message); });
      channel.once("close", () => { clearTimeout(timer); reject(new ChannelError("The server closed the connection.", "closed")); });
    });
    const denied = deniedMessage.safeParse(first);
    if (denied.success) { channel.destroy(); throw new RemoteRequestError(denied.data.message, denied.data.code); }
    const welcome = welcomeMessage.safeParse(first);
    if (!welcome.success || welcome.data.hostId !== start.hostId) { channel.destroy(); throw new ChannelError("The server sent an unexpected answer.", "protocol"); }
    return new RemoteSession(channel, welcome.data);
  }

  get isOpen(): boolean { return this.channel.isOpen; }

  request<T = unknown>(op: string, payload?: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.channel.isOpen) return Promise.reject(new RemoteRequestError("The connection to the server was lost.", "disconnected"));
    if (this.pending.size >= MAX_REQUESTS_IN_FLIGHT) return Promise.reject(new RemoteRequestError("Too many requests at once.", "too_many_requests"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RemoteRequestError("The server did not answer in time.", "timeout")); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.channel.send({ type: "request", id, op, ...(payload === undefined ? {} : { payload }) });
    });
  }

  close(): void { this.channel.close(); }

  private receive(message: unknown): void {
    const closing = closingMessage.safeParse(message);
    if (closing.success) { this.closeReason = closing.data.reason; return; }
    const response = responseMessage.safeParse(message), failure = errorMessage.safeParse(message);
    const id = response.success ? response.data.id : failure.success ? failure.data.id : undefined;
    const request = id === undefined ? undefined : this.pending.get(id);
    if (!request) { this.channel.destroy(); return; }
    this.pending.delete(id!); clearTimeout(request.timer);
    if (response.success) request.resolve(response.data.result);
    else request.reject(new RemoteRequestError(failure.data!.message, failure.data!.code));
  }
}
