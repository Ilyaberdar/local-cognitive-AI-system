import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApp } from "../src/app.js";
import { PROFILE_CLAIM_NAMESPACE as ns } from "../src/auth/profileClaims.js";
import { migrate } from "../src/db/migrate.js";
import { MIGRATIONS_DIR } from "../src/paths.js";
import { SIGNATURE_CONTEXT } from "../src/remote/signatures.js";
import { createTestDatabase, databaseSkip } from "./helpers/testDatabase.js";

const issuer = "https://tenant.example.auth0.com/", audience = "https://api.test";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
const token = (subject: string) => new SignJWT({ [`${ns}email`]: `${subject}@example.test`, [`${ns}email_verified`]: true })
  .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(privateKey);
const signFor = (key: KeyObject, context: string, message: Buffer) => sign(null, Buffer.concat([Buffer.from(context), Buffer.from([0]), message]), key);

async function cloud(t: TestContext) {
  const pool = await createTestDatabase(t);
  await migrate(pool, MIGRATIONS_DIR);
  const server = http.createServer(createApp({ pool, auth: { issuer, audience, keys } }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const api = async (method: string, url: string, body?: unknown, bearer?: string) => {
    const response = await fetch(`${origin}${url}`, { method, headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const user = async (subject: string) => {
    const bearer = await token(subject);
    return { bearer, accountId: (await api("GET", "/v1/me", undefined, bearer)).body.accountId as string };
  };
  /** A registered server, owned by an account when given. */
  const host = async (ownerAccountId?: string) => {
    const signing = generateKeyPairSync("ed25519");
    const key = Buffer.from(signing.publicKey.export({ format: "jwk" }).x!, "base64url");
    const { rows } = await pool.query<{ id: string }>(`INSERT INTO hosts (signing_public_key, tls_spki_sha256, name, app_version, protocol_version, owner_account_id)
      VALUES ($1, $2, 'fedora', '0.1.0', 1, $3) RETURNING id`, [key, randomBytes(32), ownerAccountId ?? null]);
    const send = (events: unknown[], options: { issuedAt?: string; key?: KeyObject } = {}) => {
      const payload = Buffer.from(JSON.stringify({ hostId: rows[0]!.id, batchId: randomUUID(), issuedAt: options.issuedAt ?? new Date().toISOString(), events }));
      return api("POST", "/v1/usage/events:batch", { payload: payload.toString("base64url"),
        signature: signFor(options.key ?? signing.privateKey, SIGNATURE_CONTEXT.usageBatch, payload).toString("base64url") });
    };
    return { hostId: rows[0]!.id, send };
  };
  return { pool, api, user, host };
}

const event = (accountId: string, patch: Record<string, unknown> = {}) => ({
  eventId: randomUUID(), accountId, callId: randomUUID(), attempt: 1, provider: "anthropic", model: "claude",
  startedAt: "2026-03-08T06:59:00.000Z", occurredAt: "2026-03-08T07:00:00.000Z", outcome: "completed", httpStatus: 200, usageSource: "reported",
  inputTokens: 100, outputTokens: 20, totalTokens: 120, ...patch
});

test("a server sends its owner's usage signed; a resend is acknowledged once, another account's is refused", { skip: databaseSkip }, async (t) => {
  const c = await cloud(t);
  const owner = await c.user("auth0|owner"), other = await c.user("auth0|other");
  const server = await c.host(owner.accountId);
  const first = event(owner.accountId), foreign = event(other.accountId);
  const sent = await server.send([first, foreign, { eventId: "x", bogus: true }]);
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body.acked.map((item: any) => item.eventId), [first.eventId]);
  assert.deepEqual(sent.body.rejected.map((item: any) => item.code).sort(), ["invalid", "owner_mismatch"]);
  // The ACK was lost: the same event again keeps its first receipt time.
  const again = await server.send([first]);
  assert.deepEqual(again.body.acked, sent.body.acked);
  assert.equal((await c.pool.query("SELECT count(*)::int AS n FROM usage_events")).rows[0].n, 1);
  // Signatures: another key, another purpose's context, an old batch, an unknown host.
  assert.equal((await server.send([event(owner.accountId)], { key: generateKeyPairSync("ed25519").privateKey })).status, 401);
  assert.equal((await server.send([event(owner.accountId)], { issuedAt: new Date(Date.now() - 10 * 60_000).toISOString() })).body.error, "batch_stale");
  const unclaimed = await c.host();
  assert.equal((await unclaimed.send([event(owner.accountId)])).body.rejected[0].code, "owner_mismatch", "a server nobody owns sends for no one");
  assert.equal((await server.send([event(owner.accountId, { occurredAt: new Date(Date.now() + 3_600_000).toISOString() })])).body.rejected[0].code, "invalid");
});

test("a computer sends with the account's token, never under a server's id or for another account", { skip: databaseSkip }, async (t) => {
  const c = await cloud(t);
  const me = await c.user("auth0|me"), other = await c.user("auth0|other2");
  const runtimeId = randomUUID();
  const mine = event(me.accountId, { inputTokens: null, outputTokens: 7, totalTokens: null, usageSource: "reported" });
  const sent = await c.api("POST", "/v1/usage/events:batch", { runtimeId, events: [mine, event(other.accountId)] }, me.bearer);
  assert.equal(sent.status, 200);
  assert.deepEqual([sent.body.acked.length, sent.body.rejected[0].code], [1, "owner_mismatch"]);
  // The same ids from another account are a conflict, not a merge.
  const theirs = await c.api("POST", "/v1/usage/events:batch", { runtimeId, events: [{ ...mine, accountId: other.accountId }] }, other.bearer);
  assert.equal(theirs.body.rejected[0].code, "conflict");
  const server = await c.host(me.accountId);
  const posing = await c.api("POST", "/v1/usage/events:batch", { runtimeId: server.hostId, events: [event(me.accountId)] }, me.bearer);
  assert.equal(posing.body.rejected[0].code, "host_id_reserved");
  assert.equal((await c.api("POST", "/v1/usage/events:batch", { runtimeId, events: [event(me.accountId)] })).status, 400, "no token, no signature");
  const row = (await c.pool.query("SELECT source, input_tokens, output_tokens, total_tokens FROM usage_events WHERE event_id = $1", [mine.eventId])).rows[0];
  assert.deepEqual(row, { source: "local", input_tokens: null, output_tokens: "7", total_tokens: null }, "unknown stays NULL");
});

test("totals: lifetime, a period, by runtime; days and Monday weeks in the viewer's zone; a cumulative baseline", { skip: databaseSkip }, async (t) => {
  const c = await cloud(t);
  const me = await c.user("auth0|stats");
  const server = await c.host(me.accountId);
  // 2026-03-08 07:00Z is 02:00 in New York on the day DST starts (still Mar 8), and 12:30 in Kolkata.
  // 2026-03-09 03:30Z is 23:30 of Mar 8 in New York (EDT), and 09:00 of Mar 9 in Kolkata.
  await server.send([
    event(me.accountId, { occurredAt: "2026-03-01T12:00:00.000Z", startedAt: "2026-03-01T12:00:00.000Z", totalTokens: 1000, inputTokens: 900, outputTokens: 100 }),
    event(me.accountId, { occurredAt: "2026-03-08T07:00:00.000Z", totalTokens: 120 }),
    event(me.accountId, { occurredAt: "2026-03-09T03:30:00.000Z", startedAt: "2026-03-09T03:29:00.000Z", totalTokens: 30, inputTokens: 20, outputTokens: 10, cachedInputTokens: 15 }),
    event(me.accountId, { occurredAt: "2026-03-09T04:00:00.000Z", startedAt: "2026-03-09T03:59:00.000Z", totalTokens: null, inputTokens: null, outputTokens: null, usageSource: "unknown" }),
    event(me.accountId, { occurredAt: "2026-03-09T05:00:00.000Z", startedAt: "2026-03-09T04:59:00.000Z", outcome: "rejected", httpStatus: 529, totalTokens: null, inputTokens: null, outputTokens: null, usageSource: "unknown" })
  ]);
  const summary = await c.api("GET", "/v1/usage/summary?from=2026-03-05T00:00:00.000Z&to=2026-03-10T00:00:00.000Z", undefined, me.bearer);
  assert.equal(summary.status, 200);
  assert.deepEqual([summary.body.lifetime.totalTokens, summary.body.lifetime.requests, summary.body.lifetime.requestsWithoutUsage, summary.body.lifetime.firstEventAt],
    [1150, 5, 1, "2026-03-01T12:00:00.000Z"], "a refused request is not a missing report");
  assert.deepEqual([summary.body.period.totalTokens, summary.body.period.inputTokens, summary.body.period.cachedInputTokens], [150, 120, 15]);
  assert.deepEqual(summary.body.sources.map((source: any) => [source.executionHostId, source.source, source.name, source.totalTokens]), [[server.hostId, "host", "fedora", 1150]]);
  // Nothing received after the cut-off counts.
  const before = await c.api("GET", `/v1/usage/summary?from=2026-03-05T00:00:00.000Z&to=2026-03-10T00:00:00.000Z&asOf=${encodeURIComponent("2020-01-01T00:00:00.000Z")}`, undefined, me.bearer);
  assert.equal(before.body.lifetime.totalTokens, 0);

  // The app sends its zone as offsets from instants (it computes them; the database needs no zone names).
  const zones = {
    york: { zone: "2026-03-02T05:00:00.000Z~-300,2026-03-08T07:00:00.000Z~-240", end: "2026-03-16T04:00:00.000Z" },
    kolkata: { zone: "2026-03-01T18:30:00.000Z~330", end: "2026-03-15T18:30:00.000Z" }
  };
  const days = async (which: keyof typeof zones, granularity = "day") =>
    (await c.api("GET", `/v1/usage/activity?zone=${encodeURIComponent(zones[which].zone)}&end=${encodeURIComponent(zones[which].end)}&granularity=${granularity}`, undefined, me.bearer)).body;
  const york = await days("york");
  assert.deepEqual(york.buckets.map((bucket: any) => [bucket.start, bucket.totalTokens]), [["2026-03-08", 150], ["2026-03-09", 0]]);
  assert.equal(york.before.totalTokens, 1000, "the cumulative line starts with what came before");
  const kolkata = await days("kolkata");
  assert.deepEqual(kolkata.buckets.map((bucket: any) => [bucket.start, bucket.totalTokens]), [["2026-03-08", 120], ["2026-03-09", 30]]);
  const weeks = await days("kolkata", "week");
  assert.deepEqual(weeks.buckets.map((bucket: any) => [bucket.start, bucket.totalTokens]), [["2026-03-02", 120], ["2026-03-09", 30]], "weeks start on Monday");
  const bad = async (zone: string, end = "2026-03-15T18:30:00.000Z") =>
    (await c.api("GET", `/v1/usage/activity?zone=${encodeURIComponent(zone)}&end=${encodeURIComponent(end)}`, undefined, me.bearer)).status;
  assert.equal(await bad("2026-03-01T18:30:00.000Z~2000"), 400, "an offset no zone has");
  assert.equal(await bad("2026-03-05T00:00:00.000Z~0,2026-03-01T00:00:00.000Z~60"), 400, "segments out of order");
  assert.equal(await bad("2020-01-01T00:00:00.000Z~0"), 400, "a bounded range");
  // Another account sees none of it.
  const stranger = await c.user("auth0|stranger");
  assert.equal((await c.api("GET", "/v1/usage/summary?from=2026-03-05T00:00:00.000Z&to=2026-03-10T00:00:00.000Z", undefined, stranger.bearer)).body.lifetime.requests, 0);
});
