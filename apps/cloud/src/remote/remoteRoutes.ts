import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AccountRepository } from "../accounts/accountRepository.js";
import { requireAccount } from "../accounts/requireAccount.js";
import { requireAuth, type AuthOptions } from "../auth/verifyAccessToken.js";
import type { Logger } from "../log.js";
import { createRateLimiter } from "./rateLimit.js";
import type { Relay } from "./relay.js";
import type { RemoteRepository, TicketDenial } from "./remoteRepository.js";
import { SIGNATURE_CONTEXT, verifyHostSignature } from "./signatures.js";

export const TICKET_TTL_MS = 60_000;
export const AUTH_TTL_MS = 12 * 3_600_000;
export const PROTOCOL_VERSION = 1;

const hex32 = z.string().regex(/^[0-9a-f]{64}$/).transform(value => Buffer.from(value, "hex"));
const base64url = z.string().max(8192).regex(/^[A-Za-z0-9_-]+$/).transform(value => Buffer.from(value, "base64url"));
const registration = z.object({ payload: base64url, signature: base64url });
const registrationPayload = z.object({ signingPublicKey: base64url.refine(value => value.length === 32), tlsSpkiSha256: hex32,
  name: z.string().trim().min(1).max(120), appVersion: z.string().max(64), protocol: z.literal(PROTOCOL_VERSION) });
const deviceBody = z.object({ spkiSha256: hex32, name: z.string().trim().min(1).max(120), platform: z.enum(["macos", "windows", "linux", "ios", "android"]) });
const connectionBody = z.discriminatedUnion("purpose", [
  z.object({ purpose: z.literal("pair"), hostId: z.uuid(), deviceId: z.uuid(), invitationId: z.uuid() }),
  z.object({ purpose: z.literal("connect"), hostId: z.uuid(), deviceId: z.uuid() })
]);
const ids = z.object({ hostId: z.uuid(), deviceId: z.uuid().optional() });

const TICKET_ERRORS: Record<TicketDenial, number> = { device_unknown: 404, host_unknown: 404, invitation_unknown: 404, invitation_used: 410,
  invitation_expired: 410, invitation_exhausted: 429, host_owned_by_other: 403, not_authorized: 403 };

export interface RemoteRouteDependencies { repo: RemoteRepository; relay: Relay; auth: AuthOptions; accounts: AccountRepository; logger?: Logger;
  limits?: { registrationsPerHour?: number; ticketsPerMinute?: number } }

/** Host registration, devices, connection tickets and revocation (spec §6, §13). */
export const createRemoteRouter = (deps: RemoteRouteDependencies) => {
  const router = express.Router();
  const registrations = createRateLimiter(deps.limits?.registrationsPerHour ?? 20, 3_600_000);
  const tickets = createRateLimiter(deps.limits?.ticketsPerMinute ?? 30, 60_000);
  const authed = [requireAuth(deps.auth), requireAccount(deps.accounts, deps.logger)];
  const handle = (body: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { body(req, res).catch(next); };
  const invalid = (res: Response) => { res.status(400).json({ error: "invalid_request" }); };

  // Unauthenticated: the host proves possession of its signing key over the exact payload bytes.
  router.post("/v1/hosts/register", handle(async (req, res) => {
    if (!registrations.take(req.ip ?? "unknown")) { res.status(429).json({ error: "rate_limited" }); return; }
    const body = registration.safeParse(req.body);
    if (!body.success) { invalid(res); return; }
    let payload: unknown;
    try { payload = JSON.parse(body.data.payload.toString("utf8")); } catch { invalid(res); return; }
    const host = registrationPayload.safeParse(payload);
    if (!host.success) { invalid(res); return; }
    if (!verifyHostSignature(host.data.signingPublicKey, SIGNATURE_CONTEXT.register, body.data.payload, body.data.signature)) {
      res.status(401).json({ error: "signature_invalid" }); return;
    }
    const result = await deps.repo.registerHost({ ...host.data, ip: req.ip ?? null });
    if (result.created) await deps.repo.audit("host_registered", { hostId: result.hostId });
    res.status(result.created ? 201 : 200).set("Cache-Control", "no-store").json({ hostId: result.hostId });
  }));

  router.post("/v1/devices", ...authed, handle(async (req, res) => {
    const body = deviceBody.safeParse(req.body);
    if (!body.success) { invalid(res); return; }
    const deviceId = await deps.repo.upsertDevice(req.account!.id, body.data.spkiSha256, body.data.name, body.data.platform);
    res.set("Cache-Control", "no-store").json({ deviceId });
  }));

  router.get("/v1/hosts", ...authed, handle(async (req, res) => {
    const hosts = await deps.repo.hostsFor(req.account!.id);
    res.set("Cache-Control", "no-store").json({ hosts: hosts.map(host => ({ hostId: host.id, name: host.name, appVersion: host.appVersion,
      online: deps.relay.isOnline(host.id), tlsSpkiSha256: host.tlsSpkiSha256.toString("hex"), claimedAt: host.claimedAt, lastSeenAt: host.lastSeenAt,
      devices: host.devices.map(device => ({ deviceId: device.device_id, name: device.name, platform: device.platform, status: device.status,
        grantedAt: device.granted_at, revokedAt: device.revoked_at })) })) });
  }));

  router.post("/v1/connections", ...authed, handle(async (req, res) => {
    if (!req.account!.emailVerified) { res.status(403).json({ error: "email_unverified" }); return; }
    const body = connectionBody.safeParse(req.body);
    if (!body.success) { invalid(res); return; }
    if (!tickets.take(req.account!.id)) { res.status(429).json({ error: "rate_limited" }); return; }
    // Checked first so an offline host does not use up the invitation's tickets.
    if (!deps.relay.isOnline(body.data.hostId)) { res.status(409).json({ error: "host_offline" }); return; }
    const ticket = await deps.repo.issueTicket({ accountId: req.account!.id, deviceId: body.data.deviceId, hostId: body.data.hostId, purpose: body.data.purpose,
      ...(body.data.purpose === "pair" ? { invitationId: body.data.invitationId } : {}), ttlMs: TICKET_TTL_MS, authTtlMs: AUTH_TTL_MS });
    if (!ticket.ok) { res.status(TICKET_ERRORS[ticket.code]).json({ error: ticket.code }); return; }
    res.status(201).set("Cache-Control", "no-store").json({ ticketId: ticket.ticketId, ticket: ticket.token.toString("base64url"),
      expiresAt: ticket.expiresAt.toISOString(), authExpiresAt: ticket.authExpiresAt.toISOString() });
  }));

  router.delete("/v1/hosts/:hostId/devices/:deviceId", ...authed, handle(async (req, res) => {
    const params = ids.safeParse(req.params);
    if (!params.success || !params.data.deviceId) { invalid(res); return; }
    const revocation = await deps.repo.revokeDevice(params.data.hostId, params.data.deviceId, req.account!.id, "account");
    if (!revocation) { res.status(404).json({ error: "not_found" }); return; }
    deps.relay.pushRevocation(params.data.hostId, revocation);
    deps.relay.disconnectDevice(params.data.hostId, params.data.deviceId);
    res.status(204).end();
  }));

  router.delete("/v1/hosts/:hostId", ...authed, handle(async (req, res) => {
    const params = ids.safeParse(req.params);
    if (!params.success) { invalid(res); return; }
    const revocation = await deps.repo.unlinkHost(params.data.hostId, req.account!.id, "account");
    if (!revocation) { res.status(404).json({ error: "not_found" }); return; }
    deps.relay.pushRevocation(params.data.hostId, revocation);
    deps.relay.disconnectHost(params.data.hostId);
    res.status(204).end();
  }));

  return router;
};
