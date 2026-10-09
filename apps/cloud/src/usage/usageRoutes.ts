import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AccountRepository } from "../accounts/accountRepository.js";
import { requireAccount } from "../accounts/requireAccount.js";
import { requireAuth, type AuthOptions } from "../auth/verifyAccessToken.js";
import type { Logger } from "../log.js";
import { createRateLimiter } from "../remote/rateLimit.js";
import type { RemoteRepository } from "../remote/remoteRepository.js";
import { SIGNATURE_CONTEXT, verifyHostSignature } from "../remote/signatures.js";
import { MAX_BATCH_EVENTS, MAX_CLOCK_SKEW_MS, usageEvent, type UsageEvent } from "./usageEvent.js";
import type { UsageIngestResult, UsageRepository } from "./usageRepository.js";

const base64url = z.string().max(65536).regex(/^[A-Za-z0-9_-]+$/).transform(value => Buffer.from(value, "base64url"));
const events = z.array(z.unknown()).min(1).max(MAX_BATCH_EVENTS);
const hostBatch = z.object({ payload: base64url, signature: base64url });
const hostPayload = z.object({ hostId: z.uuid(), batchId: z.uuid(), issuedAt: z.iso.datetime({ offset: true }), events });
const localBatch = z.object({ runtimeId: z.uuid(), events });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
const instant = z.iso.datetime({ offset: true }).transform(value => new Date(value));
const summaryQuery = z.object({ from: instant, to: instant, asOf: instant.optional() });
const activityQuery = z.object({ tz: z.string().min(1).max(64), from: day, to: day, granularity: z.enum(["day", "week"]).default("day"), asOf: instant.optional() });
const DAY_MS = 86_400_000;
const MAX_DAYS = { day: 400, week: 3 * 366 } as const;

/** The path the spec names (§13); Express would read `:batch` as a parameter. */
const BATCH_PATH = /^\/v1\/usage\/events:batch$/;

export interface UsageRouteDependencies { repo: UsageRepository; hosts: Pick<RemoteRepository, "host">; auth: AuthOptions; accounts: AccountRepository; logger?: Logger;
  limits?: { batchesPerMinute?: number; readsPerMinute?: number } }

/** Usage statistics (spec §10): runtimes send what they ran, the account's apps read the totals. A
 * server sends with its signing key and only for its owner; a computer sends with the account's
 * token, under its own runtime id, never a registered server's. */
export const createUsageRouter = (deps: UsageRouteDependencies) => {
  const router = express.Router();
  const batches = createRateLimiter(deps.limits?.batchesPerMinute ?? 120, 60_000);
  const reads = createRateLimiter(deps.limits?.readsPerMinute ?? 120, 60_000);
  const authed = [requireAuth(deps.auth), requireAccount(deps.accounts, deps.logger)];
  const handle = (body: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { body(req, res).catch(next); };
  const invalid = (res: Response) => { res.status(400).json({ error: "invalid_request" }); };

  /** Each event on its own: one malformed or foreign event does not hold back the rest. */
  const accept = async (raw: unknown[], accountId: string | null, store: (valid: UsageEvent[]) => Promise<UsageIngestResult>): Promise<UsageIngestResult> => {
    const rejected: UsageIngestResult["rejected"] = [], valid: UsageEvent[] = [];
    const latest = Date.now() + MAX_CLOCK_SKEW_MS;
    for (const item of raw) {
      const parsed = usageEvent.safeParse(item);
      const eventId = typeof (item as { eventId?: unknown })?.eventId === "string" ? String((item as { eventId: string }).eventId).slice(0, 64) : "";
      if (!parsed.success || Date.parse(parsed.data.occurredAt) > latest || Date.parse(parsed.data.startedAt) > Date.parse(parsed.data.occurredAt)) {
        rejected.push({ eventId, code: "invalid" }); continue;
      }
      if (parsed.data.accountId !== accountId) { rejected.push({ eventId, code: "owner_mismatch" }); continue; }
      valid.push(parsed.data);
    }
    const stored = valid.length ? await store(valid) : { acked: [], rejected: [] };
    return { acked: stored.acked, rejected: [...rejected, ...stored.rejected] };
  };

  // A computer: the signed-in account's token.
  router.post(BATCH_PATH, (req, _res, next) => { next(req.headers.authorization ? undefined : "route"); }, ...authed, handle(async (req, res) => {
    if (!batches.take(`account:${req.account!.id}`)) { res.status(429).json({ error: "rate_limited" }); return; }
    const body = localBatch.safeParse(req.body);
    if (!body.success) { invalid(res); return; }
    if (await deps.repo.isRegisteredHost(body.data.runtimeId)) {
      res.json({ acked: [], rejected: body.data.events.map(item => ({ eventId: String((item as { eventId?: unknown })?.eventId ?? "").slice(0, 64), code: "host_id_reserved" })) });
      return;
    }
    res.set("Cache-Control", "no-store").json(await accept(body.data.events, req.account!.id, valid => deps.repo.ingest(body.data.runtimeId, "local", valid)));
  }));

  // A server: its signing key over the exact payload bytes, recent, for its current owner only.
  router.post(BATCH_PATH, handle(async (req, res) => {
    if (!batches.take(`ip:${req.ip ?? "unknown"}`)) { res.status(429).json({ error: "rate_limited" }); return; }
    const body = hostBatch.safeParse(req.body);
    if (!body.success) { invalid(res); return; }
    let payload: unknown;
    try { payload = JSON.parse(body.data.payload.toString("utf8")); } catch { invalid(res); return; }
    const batch = hostPayload.safeParse(payload);
    if (!batch.success) { invalid(res); return; }
    const host = await deps.hosts.host(batch.data.hostId);
    if (!host || host.blocked) { res.status(404).json({ error: "host_unknown" }); return; }
    if (!verifyHostSignature(host.signingPublicKey, SIGNATURE_CONTEXT.usageBatch, body.data.payload, body.data.signature)) {
      res.status(401).json({ error: "signature_invalid" }); return;
    }
    // A captured batch can be replayed only briefly, and a replay only repeats acknowledgements.
    if (Math.abs(Date.now() - Date.parse(batch.data.issuedAt)) > MAX_CLOCK_SKEW_MS) { res.status(401).json({ error: "batch_stale" }); return; }
    res.set("Cache-Control", "no-store").json(await accept(batch.data.events, host.ownerAccountId, valid => deps.repo.ingest(host.id, "host", valid)));
  }));

  router.get("/v1/usage/summary", ...authed, handle(async (req, res) => {
    if (!reads.take(req.account!.id)) { res.status(429).json({ error: "rate_limited" }); return; }
    const query = summaryQuery.safeParse(req.query);
    if (!query.success || query.data.from >= query.data.to || query.data.to.getTime() - query.data.from.getTime() > MAX_DAYS.day * DAY_MS) { invalid(res); return; }
    const asOf = query.data.asOf ?? await deps.repo.now();
    const summary = await deps.repo.summary(req.account!.id, query.data.from, query.data.to, asOf);
    res.set("Cache-Control", "no-store").json({ asOf: asOf.toISOString(), ...summary });
  }));

  router.get("/v1/usage/activity", ...authed, handle(async (req, res) => {
    if (!reads.take(req.account!.id)) { res.status(429).json({ error: "rate_limited" }); return; }
    const query = activityQuery.safeParse(req.query);
    if (!query.success) { invalid(res); return; }
    const { tz, from, to, granularity } = query.data;
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
    if (days < 0 || days > MAX_DAYS[granularity]) { invalid(res); return; }
    if (!await deps.repo.validTimeZone(tz)) { res.status(400).json({ error: "unknown_time_zone" }); return; }
    const asOf = query.data.asOf ?? await deps.repo.now();
    const activity = await deps.repo.activity(req.account!.id, tz, from, to, granularity, asOf);
    res.set("Cache-Control", "no-store").json({ asOf: asOf.toISOString(), timeZone: tz, granularity, ...activity });
  }));

  return router;
};
