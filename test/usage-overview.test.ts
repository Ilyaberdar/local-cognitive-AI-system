import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { HostDatabase } from "../src/runtime/db/HostDatabase";
import { hostMigrations } from "../src/runtime/db/hostSchema";
import { OPERATIONS } from "../src/runtime/operationCatalog";
import { createUsageOperations } from "../src/runtime/usageOperations";
import { UsageAttemptRecord } from "../src/usage/UsageCall";
import { UsageAttribution, UsageLedger } from "../src/usage/UsageLedger";
import { accountUsageSender, UsageOutbox } from "../src/usage/UsageOutbox";
import { usageOverview } from "../src/usage/UsageOverview";
import { daysFromQuarters, localDate, mergeDays } from "../src/usage/UsageProjection";
import { remoteStackSkip, startCloud } from "./fixtures/remoteStack";

const ledgerFor = (t: TestContext, who: () => UsageAttribution) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-overview-"));
  const host = HostDatabase.open(path.join(directory, "host.db"), hostMigrations);
  t.after(() => { host.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { host, ledger: new UsageLedger(host, who) };
};
const attempt = (total: number, occurredAt = new Date().toISOString()): UsageAttemptRecord => ({ eventId: randomUUID(), callId: randomUUID(), attempt: 1,
  provider: "ollama", model: "m", scope: {}, startedAt: occurredAt, occurredAt, outcome: "completed", httpStatus: 200, usageSource: "reported",
  usage: { inputTokens: total - 1, outputTokens: 1, totalTokens: total } });

test("days are calendar days of the viewer's zone, quarter hours keep half-hour zones exact", (t) => {
  assert.equal(localDate("2026-03-09T03:30:00Z", "America/New_York"), "2026-03-08");
  assert.equal(localDate("2026-03-09T03:30:00Z", "Asia/Kolkata"), "2026-03-09");
  const { ledger } = ledgerFor(t, () => ({}));
  // 18:29Z and 18:31Z are either side of midnight in Kolkata (+5:30).
  ledger.record([attempt(10, "2026-03-08T18:29:00.000Z"), attempt(20, "2026-03-08T18:31:00.000Z"), attempt(5, "2026-02-01T00:00:00.000Z")]);
  const { quarters } = ledger.quarters();
  assert.deepEqual(quarters.map(quarter => quarter.quarter), ["2026-02-01T00:00", "2026-03-08T18:15", "2026-03-08T18:30"]);
  const kolkata = daysFromQuarters(quarters, "Asia/Kolkata", "2026-03-01");
  assert.deepEqual(kolkata.days.map(day => [day.date, day.totalTokens]), [["2026-03-08", 10], ["2026-03-09", 20]]);
  assert.equal(kolkata.before.totalTokens, 5, "before the first day: the cumulative baseline");
  assert.deepEqual(mergeDays(kolkata.days, [{ ...kolkata.days[0]!, totalTokens: 1 }]).map(day => day.totalTokens), [11, 20]);
});

test("signed out, the page shows this computer only; a Cloud out of reach, this computer's part of the account", async (t) => {
  const account = "11111111-1111-4111-8111-111111111111";
  let who: UsageAttribution = { accountId: account };
  const { ledger } = ledgerFor(t, () => who);
  ledger.record([attempt(100)]);
  who = {}; ledger.record([attempt(7)]);
  const local = await usageOverview({ ledger, timeZone: "Europe/Moscow" });
  assert.deepEqual([local.state, local.lifetime.totalTokens, local.days.at(-1)?.totalTokens, local.sources.length], ["local", 107, 107, 1]);
  const offline = await usageOverview({ ledger, timeZone: "Bogus/Zone", accountId: account,
    cloudUrl: "https://cloud.invalid", token: async () => "t", fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
  assert.deepEqual([offline.state, offline.timeZone, offline.lifetime.totalTokens, offline.unsentHere], ["offline", "UTC", 100, 1]);
  assert.match(offline.error ?? "", /fetch failed/);
});

test("the account's totals: the Cloud's as of one moment and this computer's remainder, nothing twice", { skip: remoteStackSkip }, async (t) => {
  const cloud = await startCloud(t);
  const me = await cloud.account("auth0|overview"), other = await cloud.account("auth0|overview-other");
  let who: UsageAttribution = { accountId: me.accountId };
  const { host, ledger } = ledgerFor(t, () => who);
  const outbox = new UsageOutbox(ledger, undefined, { delayMs: 60_000, intervalMs: 3_600_000 });
  t.after(() => outbox.stop());
  let online = true;
  const fetchImpl = (async (url: string, init?: RequestInit) => { if (!online && String(url).includes("events:batch")) throw new TypeError("offline"); return fetch(url, init); }) as typeof fetch;
  outbox.setSender(accountUsageSender({ cloudUrl: cloud.origin, runtimeId: ledger.runtimeId, account: () => who.accountId, token: async () => me.accessToken, fetchImpl }));
  ledger.record([attempt(100), attempt(200)]);
  who = { accountId: other.accountId }; ledger.record([attempt(9000)]);
  who = { accountId: me.accountId };
  const overview = () => usageOverview({ ledger, outbox, cloudUrl: cloud.origin, accountId: me.accountId, token: async () => me.accessToken, timeZone: "Asia/Kolkata", fetchImpl });
  const first = await overview();
  assert.equal(first.state, "cloud");
  assert.equal(first.lifetime.totalTokens, 300, "sent first, then counted once by the Cloud");
  assert.equal(first.unsentHere, 0);
  assert.deepEqual(first.sources.map(source => [source.here, source.kind, source.totalTokens]), [[true, "local", 300]]);
  // The batch cannot be sent now: the remainder comes from here.
  online = false;
  ledger.record([attempt(50)]);
  const second = await overview();
  assert.deepEqual([second.state, second.lifetime.totalTokens, second.unsentHere, second.days.at(-1)?.totalTokens], ["cloud", 350, 1, 350]);
  // Received by the Cloud after the cut-off: still counted from here, exactly once.
  host.db.prepare("UPDATE usage_events SET sync_state = 'acked', cloud_received_at = ? WHERE total_tokens = 50").run(new Date(Date.now() + 60_000).toISOString());
  assert.equal((await overview()).lifetime.totalTokens, 350);
});

test("a server tells only its owner's devices what it has not sent yet", async (t) => {
  const owner = "22222222-2222-4222-8222-222222222222";
  const { ledger } = ledgerFor(t, () => ({ accountId: owner, hostId: "33333333-3333-4333-8333-333333333333" }));
  ledger.record([attempt(40, "2026-10-01T12:00:00.000Z")]);
  assert.equal(OPERATIONS["usage.pending"]?.kind, "request");
  const operation = createUsageOperations({ ledger, owner: () => owner })["usage.pending"]!;
  const context = (accountId: string) => ({ accountId, deviceId: "d", signal: new AbortController().signal });
  const result = await operation({ timeZone: "Europe/Moscow", from: "2026-09-01" }, context(owner)) as any;
  assert.deepEqual([result.available, result.lifetime.totalTokens, result.days[0].date, result.unsent], [true, 40, "2026-10-01", 1]);
  assert.equal(JSON.stringify(result).includes(owner), false, "counts only");
  await assert.rejects(Promise.resolve(operation({ timeZone: "UTC", from: "2026-09-01" }, context("44444444-4444-4444-8444-444444444444"))), /owner/);
  await assert.rejects(Promise.resolve(operation({ timeZone: "UTC", from: "September" }, context(owner))), /not valid/);
});
