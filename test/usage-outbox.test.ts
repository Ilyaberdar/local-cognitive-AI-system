import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { HostDatabase } from "../src/runtime/db/HostDatabase";
import { hostMigrations } from "../src/runtime/db/hostSchema";
import { SIGNATURE_CONTEXT } from "../src/remote/messages";
import { UsageAttemptRecord } from "../src/usage/UsageCall";
import { UsageAttribution, UsageLedger } from "../src/usage/UsageLedger";
import { accountUsageSender, hostUsageSender, UsageOutbox } from "../src/usage/UsageOutbox";
import { remoteStackSkip, startCloud } from "./fixtures/remoteStack";

const ledgerFor = (t: TestContext, who: () => UsageAttribution) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-outbox-"));
  const host = HostDatabase.open(path.join(directory, "host.db"), hostMigrations);
  t.after(() => { host.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { host, ledger: new UsageLedger(host, who) };
};
const attempt = (total: number): UsageAttemptRecord => ({ eventId: randomUUID(), callId: randomUUID(), attempt: 1, provider: "ollama", model: "gemma3:1b",
  scope: { origin: "chat", purpose: "answer", sessionId: "s" }, startedAt: new Date(Date.now() - 1000).toISOString(), occurredAt: new Date().toISOString(),
  outcome: "completed", httpStatus: 200, usageSource: "reported", usage: { inputTokens: total - 1, outputTokens: 1, totalTokens: total } });
const states = (host: HostDatabase) => Object.fromEntries((host.db.prepare("SELECT sync_state, count(*) AS n FROM usage_events GROUP BY sync_state").all() as Array<{ sync_state: string; n: number }>)
  .map(row => [row.sync_state, Number(row.n)]));

test("a computer sends its signed-in account's events once, even when an acknowledgement is lost", { skip: remoteStackSkip }, async (t) => {
  const cloud = await startCloud(t);
  const a = await cloud.account("auth0|usage-a"), b = await cloud.account("auth0|usage-b");
  let current: typeof a | undefined = a;
  const { host, ledger } = ledgerFor(t, () => ({ accountId: current?.accountId }));
  ledger.record([attempt(10), attempt(20), attempt(30)]);
  current = b; ledger.record([attempt(5)]);
  current = undefined; ledger.record([attempt(7)]);
  current = a;
  let loseAnswer = false, badToken = false;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const response = await fetch(url, init);
    if (loseAnswer) { await response.body?.cancel(); throw new TypeError("connection reset after the Cloud stored the batch"); }
    return response;
  }) as typeof fetch;
  const outbox = new UsageOutbox(ledger, undefined, { delayMs: 60_000, intervalMs: 3_600_000 });
  t.after(() => outbox.stop());
  outbox.setSender(accountUsageSender({ cloudUrl: cloud.origin, runtimeId: ledger.runtimeId, account: () => current?.accountId,
    token: async () => badToken ? "not-a-token" : current!.accessToken, fetchImpl }));

  loseAnswer = true;
  const lost = await outbox.flush();
  assert.match(lost.error ?? "", /connection reset/);
  assert.deepEqual(states(host), { pending: 4, local_only: 1 }, "not acknowledged: waiting again");
  loseAnswer = false;
  assert.deepEqual(await outbox.flush(), { sent: 0, acked: 0, rejected: 0 }, "a failure waits before the next attempt");
  const sent = await outbox.flush(30_000, true);
  assert.deepEqual([sent.sent, sent.acked, sent.rejected], [3, 3, 0]);
  const stored = await cloud.pool.query("SELECT account_id, source, total_tokens FROM usage_events ORDER BY total_tokens");
  assert.deepEqual(stored.rows.map((row: any) => [row.account_id, row.source, Number(row.total_tokens)]), [[a.accountId, "local", 10], [a.accountId, "local", 20], [a.accountId, "local", 30]],
    "the resend was a duplicate, not a second row");
  assert.equal(host.db.prepare("SELECT count(*) AS n FROM usage_events WHERE sync_state = 'acked' AND cloud_received_at IS NOT NULL").get()?.n, 3);

  // Another account signs in: its own events go, with its own token; the first account's never.
  current = b; badToken = true;
  assert.match((await outbox.flush(30_000, true)).error ?? "", /HTTP 401/);
  badToken = false;
  assert.equal((await outbox.flush(30_000, true)).acked, 1);
  assert.equal(ledger.pendingCount(b.accountId), 0);
  assert.deepEqual(states(host), { acked: 4, local_only: 1 }, "what ran signed out stays on this computer");
  assert.equal((await cloud.pool.query("SELECT count(*)::int AS n FROM usage_events")).rows[0].n, 4);

  // A send cut by a restart is sent again by the next outbox.
  current = a; ledger.record([attempt(3)]);
  ledger.claim(a.accountId, ledger.runtimeId, 50);
  const next = new UsageOutbox(ledger, undefined, { delayMs: 60_000, intervalMs: 3_600_000 });
  t.after(() => next.stop());
  assert.equal(ledger.pendingCount(a.accountId), 1);
  assert.equal(states(host).sent, undefined);
});

test("a server sends its owner's events signed; the Cloud refusing another owner's keeps them here", { skip: remoteStackSkip }, async (t) => {
  const cloud = await startCloud(t);
  const owner = await cloud.account("auth0|usage-owner"), next = await cloud.account("auth0|usage-next");
  const signing = generateKeyPairSync("ed25519");
  const key = Buffer.from(signing.publicKey.export({ format: "jwk" }).x!, "base64url");
  const { rows } = await cloud.pool.query(`INSERT INTO hosts (signing_public_key, tls_spki_sha256, name, app_version, protocol_version, owner_account_id)
    VALUES ($1, $2, 'fedora', '0.1.0', 1, $3) RETURNING id`, [key, randomBytes(32), owner.accountId]);
  const hostId = rows[0].id as string;
  let localOwner = owner.accountId;
  const { host, ledger } = ledgerFor(t, () => ({ accountId: localOwner, hostId }));
  ledger.record([attempt(100), attempt(200)]);
  const outbox = new UsageOutbox(ledger, undefined, { delayMs: 60_000, intervalMs: 3_600_000 });
  t.after(() => outbox.stop());
  outbox.setSender(hostUsageSender({ cloudUrl: cloud.origin, hostId: () => hostId, owner: () => localOwner,
    sign: payload => sign(null, Buffer.concat([Buffer.from(SIGNATURE_CONTEXT.usageBatch), Buffer.from([0]), payload]), signing.privateKey) }));
  assert.equal((await outbox.flush()).acked, 2);
  assert.deepEqual((await cloud.pool.query("SELECT source, execution_host_id FROM usage_events")).rows.map((row: any) => [row.source, row.execution_host_id]),
    [["host", hostId], ["host", hostId]]);
  // The Cloud already knows another owner; this server has not heard yet.
  await cloud.pool.query("UPDATE hosts SET owner_account_id = $1 WHERE id = $2", [next.accountId, hostId]);
  ledger.record([attempt(300)]);
  const refused = await outbox.flush();
  assert.deepEqual([refused.acked, refused.rejected], [0, 1]);
  assert.equal(host.db.prepare("SELECT sync_error FROM usage_events WHERE total_tokens = 300").get()?.sync_error, "owner_mismatch");
});
