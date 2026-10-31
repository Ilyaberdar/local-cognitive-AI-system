import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { RemoteHostStore } from "../src/remote/host/RemoteHostStore";
import { HostDatabase } from "../src/runtime/db/HostDatabase";
import { hostMigrations } from "../src/runtime/db/hostSchema";

const now = new Date("2026-10-31T20:00:00Z");
const open = (t: TestContext, migrations = hostMigrations) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "host.db");
  return { file, host: HostDatabase.open(file, migrations) };
};
const pair = (store: RemoteHostStore, deviceId: string, key = `spki-${deviceId}`, accountId = "account") => {
  const invitationId = `invitation-${deviceId}-${Math.random()}`;
  store.createInvitation(invitationId, now, new Date(now.getTime() + 60_000));
  const claimed = store.claim({ invitationId, accountId, deviceId, deviceSpkiSha256: key, deviceName: deviceId, receiptId: `receipt-${invitationId}`, now });
  assert.ok(claimed.ok);
};

test("devices paired before trust existed keep their grants and are not trusted", t => {
  const { file, host } = open(t, hostMigrations.slice(0, 3));
  // A grant as a v3 host wrote it.
  host.db.prepare("INSERT INTO host_meta(key, value) VALUES ('remote.owner_account_id', 'account')").run();
  host.db.prepare(`INSERT INTO remote_grants(device_id, account_id, device_spki_sha256, device_name, status, receipt_id, granted_at)
    VALUES ('phone', 'account', 'spki-phone', 'phone', 'active', 'receipt-1', ?)`).run(now.toISOString());
  host.close();
  const upgraded = HostDatabase.open(file, hostMigrations);
  t.after(() => upgraded.close());
  const store = new RemoteHostStore(upgraded);
  assert.equal(upgraded.schemaVersion(), 4);
  assert.equal(store.activeGrant("phone")?.deviceName, "phone");
  assert.equal(store.activeGrant("phone")?.trustedAt, undefined);
  assert.equal(store.isTrusted("phone", "account"), false);
});

test("trust is set on an active grant of the owner, and checked against the account and the owner", t => {
  const { host } = open(t);
  t.after(() => host.close());
  const store = new RemoteHostStore(host);
  pair(store, "phone");
  pair(store, "laptop");
  assert.equal(store.setTrusted("phone", true, "host", now), true);
  assert.deepEqual([store.activeGrant("phone")?.trustedAt, store.activeGrant("phone")?.trustedBy], [now.toISOString(), "host"]);
  assert.equal(store.isTrusted("phone", "account"), true);
  assert.equal(store.isTrusted("laptop", "account"), false, "another device is not trusted by it");
  assert.equal(store.isTrusted("phone", "someone-else"), false, "the call must come from the grant's account");
  assert.equal(store.setTrusted("missing", true, "host", now), false);
  assert.equal(store.setTrusted("phone", false, "host", now), true);
  assert.equal(store.isTrusted("phone", "account"), false);
});

test("pairing again, revoking, unlinking or a revocation from the Cloud ends trust", t => {
  const { host } = open(t);
  t.after(() => host.close());
  const store = new RemoteHostStore(host);
  pair(store, "phone");
  store.setTrusted("phone", true, "host", now);
  pair(store, "phone", "spki-new-key");
  assert.equal(store.isTrusted("phone", "account"), false, "a device paired again (a new key) starts untrusted");

  store.setTrusted("phone", true, "host", now);
  assert.equal(store.revoke("phone", "host", now), true);
  assert.equal(store.isTrusted("phone", "account"), false);
  assert.equal(store.grants().find(grant => grant.deviceId === "phone")?.trustedAt, undefined);
  assert.equal(store.setTrusted("phone", true, "host", now), false, "a revoked device cannot be trusted");

  pair(store, "tablet");
  store.setTrusted("tablet", true, "cli", now);
  assert.equal(store.applyRevocation({ seq: 1, kind: "device", deviceId: "tablet" }, now), true);
  assert.equal(store.isTrusted("tablet", "account"), false);

  pair(store, "watch");
  store.setTrusted("watch", true, "host", now);
  store.unlink("host", now);
  assert.equal(store.isTrusted("watch", "account"), false, "unlinked: no owner, no trust");
  assert.equal(store.grants().some(grant => grant.trustedAt), false);
});
