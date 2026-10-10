import { diagnostics } from "../../diagnostics/DiagnosticLog";
import { EventEmitter } from "events";
import WebSocket from "ws";
import type { CredentialVault } from "../../plugins/contracts";
import { ConnectionKeyError, decodeConnectionKey, environmentOf } from "../connectionKey";
import { createTlsIdentity, loadTlsIdentity, type TlsIdentity } from "../identity";
import { wsDuplex } from "../wsDuplex";
import { RemoteSession } from "./RemoteSession";

/** A server this device paired with, under one account. The host key pin never changes silently. */
export interface RemoteProfile { hostId: string; hostName: string; hostSpkiSha256: string; deviceId: string; pairedAt: string }
export type RemoteState = "idle" | "connecting" | "online" | "reconnecting" | "offline" | "revoked" | "identity_changed" | "error";
export interface RemoteStatus { state: RemoteState; hostId?: string; hostName?: string; serverVersion?: string; capabilities?: string[]; error?: { code: string; message: string } }
export interface RemoteHostSummary { hostId: string; name: string; online: boolean; appVersion: string; paired: boolean; devices: Array<{ deviceId: string; name: string; platform: string; status: string; current: boolean }> }

export class RemoteError extends Error { constructor(message: string, readonly code: string) { super(message); } }

const MAX_MESSAGE_BYTES = 64 * 1024;
const RELAY_CLOSE: Record<number, [string, string]> = {
  4401: ["ticket_rejected", "The connection was not authorized. Try again."],
  4403: ["revoked", "This computer's access to the server was removed."],
  4404: ["host_offline", "The server is offline or not connected to Local Cognitive."],
  4408: ["timeout", "The connection timed out."],
  4410: ["auth_expired", "The session expired."],
  4429: ["too_many_sessions", "Too many connections to this server. Close another window and try again."]
};
const API_ERRORS: Record<string, string> = {
  email_unverified: "Verify your email address before connecting a server.",
  host_offline: "The server is offline or not connected to Local Cognitive.",
  host_owned_by_other: "This server belongs to another account.",
  invitation_unknown: "The connection key is unknown or has expired. Create a new one on the server.",
  invitation_used: "The connection key was already used. Create a new one on the server.",
  invitation_expired: "The connection key has expired. Create a new one on the server.",
  invitation_exhausted: "Too many attempts with this key. Create a new one on the server.",
  not_authorized: "This computer has no access to the server. Connect it again with a new key.",
  rate_limited: "Too many attempts. Wait a minute and try again."
};

/** The device end of Remote (spec §6): pairs with a connection key, reconnects with its
 * device key, and keeps one session to the selected server. Keys and pins are kept per account. */
export class RemoteClient extends EventEmitter {
  private session?: RemoteSession;
  private socket?: WebSocket;
  private current: RemoteStatus = { state: "idle" };
  private generation = 0;
  private attempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly origin: string;

  constructor(private readonly options: {
    cloudUrl: string; vault: CredentialVault; account: () => Promise<{ accountId: string; accessToken: string } | undefined>;
    deviceName: string; platform: "macos" | "windows" | "linux"; fetchImpl?: typeof fetch; backoff?: { baseMs: number; maxMs: number };
  }) {
    super();
    this.origin = new URL(options.cloudUrl).origin;
  }

  status(): RemoteStatus { return this.current; }

  /** Pairs with a key printed by `local-cognitive-server connect-key` and stays connected. */
  async pair(keyText: string): Promise<RemoteStatus> {
    let key;
    try { key = decodeConnectionKey(keyText, { environment: environmentOf(this.origin) }); }
    catch (error) { if (error instanceof ConnectionKeyError) throw new RemoteError(error.message, `key_${error.code}`); throw error; }
    const generation = this.reset();
    this.set({ state: "connecting", hostId: key.hostId });
    try {
      const { accountId, accessToken } = await this.requireAccount();
      const device = await this.device(accountId, accessToken);
      const ticket = await this.ticket(accessToken, { purpose: "pair", hostId: key.hostId, deviceId: device.deviceId, invitationId: key.invitationId });
      const session = await this.open(ticket.ticket, generation, { purpose: "pair", hostId: key.hostId, hostSpkiSha256: key.hostSpkiSha256, ticketId: ticket.ticketId,
        accountId, deviceId: device.deviceId, invitationId: key.invitationId, secret: key.secret, identity: device.identity });
      await this.saveProfile(accountId, { hostId: key.hostId, hostName: session.welcome.hostName, hostSpkiSha256: key.hostSpkiSha256.toString("hex"),
        deviceId: device.deviceId, pairedAt: new Date().toISOString() });
      this.online(session, generation);
      void this.options.vault.write(`remote/last-host/${accountId}`, key.hostId).catch(() => undefined);
      return this.current;
    } catch (error) { return this.failed(error, generation); }
  }

  /** Connects to a paired server with this device's key; no connection key is needed. */
  async connect(hostId: string): Promise<RemoteStatus> {
    const generation = this.reset();
    return this.connectAs(hostId, generation, "connecting");
  }

  /** Closes the session; the pairing stays, so Connect works again without a key. */
  disconnect(): RemoteStatus {
    this.reset();
    this.set({ state: "idle" });
    // Choosing this computer is remembered: the next start does not reconnect.
    void this.options.account().then(account => account && this.options.vault.remove(`remote/last-host/${account.accountId}`)).catch(() => undefined);
    return this.current;
  }

  /** At startup: reconnects to the server this computer was last connected to, if any. */
  async resume(): Promise<RemoteStatus> {
    const account = await this.options.account().catch(() => undefined);
    if (!account || this.current.state !== "idle") return this.current;
    const hostId = await this.options.vault.read(`remote/last-host/${account.accountId}`).catch(() => undefined);
    if (!hostId || !(await this.profiles(account.accountId)).some(profile => profile.hostId === hostId)) return this.current;
    return this.connect(hostId);
  }

  /** Resolves true once online, false on timeout or when the connection needs the user. */
  waitOnline(timeoutMs: number): Promise<boolean> {
    if (this.current.state === "online") return Promise.resolve(true);
    return new Promise(resolve => {
      const done = (value: boolean) => { clearTimeout(timer); this.off("change", onChange); resolve(value); };
      const onChange = (status: RemoteStatus) => {
        if (status.state === "online") done(true);
        else if (["idle", "revoked", "identity_changed", "error"].includes(status.state)) done(false);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.on("change", onChange);
    });
  }

  /** Disconnects and forgets the server on this computer (the server keeps its record until revoked). */
  async forget(hostId: string): Promise<RemoteStatus> {
    if (this.current.hostId === hostId) this.disconnect();
    const account = await this.options.account();
    if (account) {
      await this.saveProfiles(account.accountId, (await this.profiles(account.accountId)).filter(profile => profile.hostId !== hostId));
      if (await this.options.vault.read(`remote/last-host/${account.accountId}`) === hostId) await this.options.vault.remove(`remote/last-host/${account.accountId}`);
    }
    return this.current;
  }

  /** Servers of this account from the Cloud, marked with whether this computer is paired. */
  async hosts(): Promise<RemoteHostSummary[]> {
    const { accountId, accessToken } = await this.requireAccount();
    const [profiles, device] = await Promise.all([this.profiles(accountId), this.storedDevice(accountId)]);
    const body = await this.api<{ hosts: Array<{ hostId: string; name: string; online: boolean; appVersion: string; devices: Array<{ deviceId: string; name: string; platform: string; status: string }> }> }>(
      accessToken, "GET", "/v1/hosts");
    return body.hosts.map(host => ({ hostId: host.hostId, name: host.name, online: host.online, appVersion: host.appVersion,
      paired: profiles.some(profile => profile.hostId === host.hostId) && host.devices.some(entry => entry.deviceId === device?.deviceId && entry.status === "active"),
      devices: host.devices.filter(entry => entry.status === "active").map(entry => ({ ...entry, current: entry.deviceId === device?.deviceId })) }));
  }

  async revokeDevice(hostId: string, deviceId: string): Promise<void> {
    const { accessToken } = await this.requireAccount();
    await this.api(accessToken, "DELETE", `/v1/hosts/${encodeURIComponent(hostId)}/devices/${encodeURIComponent(deviceId)}`);
  }

  request<T = unknown>(op: string, payload?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.session?.isOpen) return Promise.reject(new RemoteError("Not connected to a server.", "not_connected"));
    return this.session.request<T>(op, payload, timeoutMs);
  }

  /** Ends the session without forgetting the last server (the app is closing). */
  dispose(): void {
    this.reset();
    if (this.current.state !== "idle") this.set({ state: "idle" });
  }

  private async connectAs(hostId: string, generation: number, state: "connecting" | "reconnecting"): Promise<RemoteStatus> {
    this.set({ state, hostId, ...(this.current.hostName ? { hostName: this.current.hostName } : {}) });
    try {
      const { accountId, accessToken } = await this.requireAccount();
      const profile = (await this.profiles(accountId)).find(entry => entry.hostId === hostId);
      if (!profile) throw new RemoteError("This computer is not paired with the server. Connect it with a key.", "not_paired");
      const device = await this.device(accountId, accessToken);
      if (device.deviceId !== profile.deviceId) throw new RemoteError("This computer's key changed. Connect it again with a new key.", "not_paired");
      const ticket = await this.ticket(accessToken, { purpose: "connect", hostId, deviceId: device.deviceId });
      const session = await this.open(ticket.ticket, generation, { purpose: "connect", hostId, hostSpkiSha256: Buffer.from(profile.hostSpkiSha256, "hex"),
        ticketId: ticket.ticketId, accountId, deviceId: device.deviceId, identity: device.identity });
      this.online(session, generation);
      if (state === "connecting") void this.options.vault.write(`remote/last-host/${accountId}`, hostId).catch(() => undefined);
      return this.current;
    } catch (error) { return this.failed(error, generation, true); }
  }

  private online(session: RemoteSession, generation: number): void {
    if (generation !== this.generation) { session.close(); return; }
    this.session = session;
    this.attempt = 0;
    this.set({ state: "online", hostId: session.welcome.hostId, hostName: session.welcome.hostName, serverVersion: session.welcome.serverVersion,
      capabilities: session.welcome.capabilities });
    session.once("close", (reason?: string) => {
      if (generation !== this.generation) return;
      this.session = undefined;
      if (reason === "revoked") { this.set({ ...this.current, state: "revoked", error: { code: "revoked", message: "This computer's access to the server was removed." } }); return; }
      // Expired authorization, a relay restart or a network drop: reconnect quietly.
      this.scheduleReconnect(session.welcome.hostId, generation);
    });
  }

  private failed(error: unknown, generation: number, retry = false): RemoteStatus {
    if (generation !== this.generation) return this.current;
    const code = (error as { code?: string }).code ?? "error";
    const message = error instanceof Error ? error.message : String(error);
    const state: RemoteState = code === "host_identity_mismatch" ? "identity_changed" : code === "revoked" || code === "not_authorized" ? "revoked" : "error";
    const hostId = this.current.hostId;
    // Only network-level failures are retried; a refusal needs the user.
    if (retry && hostId && ["host_offline", "network", "timeout", "closed", "ticket_rejected", "auth_expired"].includes(code)) {
      this.set({ ...this.current, state: "offline", error: { code, message } });
      this.scheduleReconnect(hostId, generation);
      return this.current;
    }
    this.set({ ...this.current, state, error: { code, message } });
    return this.current;
  }

  private scheduleReconnect(hostId: string, generation: number): void {
    clearTimeout(this.reconnectTimer);
    const { baseMs, maxMs } = this.options.backoff ?? { baseMs: 1000, maxMs: 30_000 };
    const delay = Math.min(maxMs, baseMs * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
    if (this.current.state !== "offline") this.set({ ...this.current, state: "reconnecting" });
    this.reconnectTimer = setTimeout(() => { if (generation === this.generation) void this.connectAs(hostId, generation, "reconnecting"); }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Ends any session and pending reconnect; returns the new generation. */
  private reset(): number {
    clearTimeout(this.reconnectTimer);
    this.attempt = 0;
    this.session?.close();
    this.session = undefined;
    this.socket?.terminate();
    this.socket = undefined;
    return ++this.generation;
  }

  private async open(ticket: string, generation: number, start: Parameters<typeof RemoteSession.open>[1]): Promise<RemoteSession> {
    const socket = new WebSocket(`${this.origin.replace(/^http/, "ws")}/v1/relay/client`, { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false, handshakeTimeout: 15_000 });
    if (generation === this.generation) this.socket = socket;
    const closed = new Promise<never>((_resolve, reject) => socket.once("close", code => {
      const [errorCode, message] = RELAY_CLOSE[code] ?? ["closed", "The connection to the server closed."];
      reject(new RemoteError(message, errorCode));
    }));
    closed.catch(() => undefined);
    await Promise.race([new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", error => reject(new RemoteError(error.message, "network"))); }), closed]);
    socket.send(JSON.stringify({ type: "auth", ticket }));
    await Promise.race([new Promise<void>(resolve => {
      const onMessage = (data: WebSocket.RawData, binary: boolean) => {
        if (binary) return;
        try { if ((JSON.parse(data.toString()) as { type?: string }).type === "connected") { socket.off("message", onMessage); resolve(); } } catch { /* Not JSON. */ }
      };
      socket.on("message", onMessage);
    }), closed]);
    try {
      const session = await RemoteSession.open(wsDuplex(socket), { ...start, deviceName: this.options.deviceName });
      // A relay close code (revoked, expired) explains a close better than the TLS layer can.
      socket.once("close", code => { if (code === 4403) session.closeReason ??= "revoked"; });
      return session;
    } catch (error) { socket.terminate(); throw error; }
  }

  private async requireAccount(): Promise<{ accountId: string; accessToken: string }> {
    const account = await this.options.account().catch(() => undefined);
    if (!account) throw new RemoteError("Sign in to your Local Cognitive account to use Remote.", "signed_out");
    return account;
  }

  private storedDevice = async (accountId: string): Promise<{ deviceId?: string; identity: TlsIdentity } | undefined> => {
    const saved = await this.options.vault.read(`remote/device/${accountId}`);
    if (!saved) return undefined;
    const parsed = JSON.parse(saved) as { deviceId?: string; tls: { keyPem: string; certPem: string } };
    return { ...(parsed.deviceId ? { deviceId: parsed.deviceId } : {}), identity: loadTlsIdentity(parsed.tls) };
  };

  /** This computer's key for the account, registered with the Cloud once. */
  private async device(accountId: string, accessToken: string): Promise<{ deviceId: string; identity: TlsIdentity }> {
    let stored = await this.storedDevice(accountId);
    if (!stored) {
      stored = { identity: createTlsIdentity("local-cognitive-device") };
      await this.saveDevice(accountId, stored.identity);
    }
    if (stored.deviceId) return { deviceId: stored.deviceId, identity: stored.identity };
    const { deviceId } = await this.api<{ deviceId: string }>(accessToken, "POST", "/v1/devices",
      { spkiSha256: stored.identity.spkiSha256.toString("hex"), name: this.options.deviceName.slice(0, 120) || "Computer", platform: this.options.platform });
    await this.saveDevice(accountId, stored.identity, deviceId);
    return { deviceId, identity: stored.identity };
  }

  private saveDevice(accountId: string, identity: TlsIdentity, deviceId?: string): Promise<void> {
    return this.options.vault.write(`remote/device/${accountId}`, JSON.stringify({ ...(deviceId ? { deviceId } : {}), tls: { keyPem: identity.keyPem, certPem: identity.certPem } }));
  }

  private async profiles(accountId: string): Promise<RemoteProfile[]> {
    const saved = await this.options.vault.read(`remote/profiles/${accountId}`);
    return saved ? (JSON.parse(saved) as { profiles: RemoteProfile[] }).profiles : [];
  }
  private saveProfiles(accountId: string, profiles: RemoteProfile[]): Promise<void> {
    return this.options.vault.write(`remote/profiles/${accountId}`, JSON.stringify({ profiles }));
  }
  private async saveProfile(accountId: string, profile: RemoteProfile): Promise<void> {
    await this.saveProfiles(accountId, [...(await this.profiles(accountId)).filter(entry => entry.hostId !== profile.hostId), profile]);
  }

  private async ticket(accessToken: string, body: Record<string, string>): Promise<{ ticketId: string; ticket: string }> {
    return this.api(accessToken, "POST", "/v1/connections", body);
  }

  private async api<T>(accessToken: string, method: string, pathname: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(`${this.origin}${pathname}`, { method, signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new RemoteError("Local Cognitive Cloud is unreachable. Check your connection.", "network"); }
    if (response.status === 204) return undefined as T;
    const json = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      const code = json.error ?? `http_${response.status}`;
      throw new RemoteError(API_ERRORS[code] ?? `Local Cognitive Cloud refused the request (${code}).`, code);
    }
    return json as T;
  }

  private set(status: RemoteStatus): void {
    if (status.error && status.error.code !== this.current?.error?.code) diagnostics().record("remote.client_state", { state: status.state, code: status.error.code });
    this.current = status;
    this.emit("change", status);
  }
}

export const devicePlatform = (platform: NodeJS.Platform = process.platform): "macos" | "windows" | "linux" =>
  platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
