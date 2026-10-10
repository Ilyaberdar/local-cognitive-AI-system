import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { duplexPair } from "node:stream";
import test, { TestContext } from "node:test";
import { RemoteRequestError, RemoteSession, type SessionStart } from "../src/remote/client/RemoteSession";
import { connectTls, FramedChannel, pairingExporter, pairingProof } from "../src/remote/channel";
import { ConnectionKeyError, decodeConnectionKey, encodeConnectionKey } from "../src/remote/connectionKey";
import { RemoteHost, RemoteOperationError, type ClaimReceipt, type StreamOpen } from "../src/remote/host/RemoteHost";
import { RemoteHostStore } from "../src/remote/host/RemoteHostStore";
import { createSigningIdentity, createTlsIdentity, loadTlsIdentity, type TlsIdentity } from "../src/remote/identity";
import { HostDatabase } from "../src/runtime/db/HostDatabase";
import { hostMigrations } from "../src/runtime/db/hostSchema";

const HOST_ID = "6f1c2c3e-58a4-4c55-9a0e-3c7f5b1d2e90";
/** An in-memory transport that behaves like the relayed WebSocket: destroying one end closes the other. */
const linkedPair = () => {
  const [hostSide, deviceSide] = duplexPair();
  hostSide.once("close", () => deviceSide.destroy());
  deviceSide.once("close", () => hostSide.destroy());
  return [hostSide, deviceSide] as const;
};

test("connection keys round-trip, tolerate case and line breaks, and reject typos, other services and expiry", () => {
  const fields = { environment: 1, hostId: HOST_ID, invitationId: crypto.randomUUID(), hostSpkiSha256: crypto.randomBytes(32), secret: crypto.randomBytes(32),
    expiresAt: Math.floor(Date.now() / 1000) + 600 };
  const key = encodeConnectionKey(fields);
  assert.equal(key.length, 177);
  assert.match(key, /^LCR1-[A-Z2-7]{164}-[A-Z2-7]{7}$/);
  const decoded = decodeConnectionKey(key.toLowerCase().replace(/(.{50})/g, "$1\n  "), { environment: 1 });
  assert.deepEqual({ ...decoded, hostSpkiSha256: decoded.hostSpkiSha256.toString("hex"), secret: decoded.secret.toString("hex") },
    { ...fields, hostSpkiSha256: fields.hostSpkiSha256.toString("hex"), secret: fields.secret.toString("hex") });
  let caught = 0, total = 0;
  for (let index = 5; index < key.length; index++) {
    if (key[index] === "-") continue;
    for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567") {
      if (char === key[index]) continue;
      total++;
      try { decodeConnectionKey(key.slice(0, index) + char + key.slice(index + 1)); } catch (error) { caught++; assert.ok(error instanceof ConnectionKeyError); }
    }
  }
  assert.equal(caught, total, "every single-character change is detected, including unused bits");
  const rejects = (text: string, code: string, options = {}) => assert.throws(() => decodeConnectionKey(text, options),
    (error: unknown) => error instanceof ConnectionKeyError && error.code === code && !error.message.includes(fields.secret.toString("hex")));
  rejects("LCR1-abc", "format");
  rejects(key, "environment", { environment: 2 });
  rejects(key, "expired", { now: (fields.expiresAt + 1) * 1000 });
  rejects(encodeConnectionKey({ ...fields, expiresAt: 1 }), "expired");
});

interface Fixture { host: RemoteHost; store: RemoteHostStore; hostTls: TlsIdentity; receipts: ClaimReceipt[]; now: { value: number } }
function fixture(t: TestContext): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remote-channel-"));
  const database = HostDatabase.open(path.join(directory, "host.db"), hostMigrations);
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const store = new RemoteHostStore(database);
  store.setHostId(HOST_ID);
  const hostTls = createTlsIdentity("lc-host"), now = { value: Date.now() };
  const host = new RemoteHost({ store, tls: hostTls, signing: createSigningIdentity(), hostName: "Fedora", serverVersion: "0.1.0", environment: 1, now: () => now.value,
    operations: { "host.info": (_payload, context) => ({ name: "Fedora", deviceId: context.deviceId }), "fail.known": () => { throw new RemoteOperationError("No such model.", "not_found"); },
      "fail.unknown": () => { throw new Error("/srv/secret/path exploded"); }, "slow": () => new Promise(resolve => setTimeout(() => resolve("done"), 50)) } });
  const receipts: ClaimReceipt[] = [];
  host.on("claimed", (receipt: ClaimReceipt) => receipts.push(receipt));
  t.after(() => host.disconnectAll("test"));
  return { host, store, hostTls, receipts, now };
}

interface Device { identity: TlsIdentity; deviceId: string; accountId: string }
const device = (accountId = "acct-1"): Device => ({ identity: createTlsIdentity("lc-device"), deviceId: crypto.randomUUID(), accountId });

/** Connects through an in-memory stream; `open` is what the Cloud would vouch for. */
function connect(f: Fixture, dev: Device, start: Partial<SessionStart> & { purpose: "pair" | "connect" }, open: Partial<StreamOpen> = {}) {
  const [hostSide, deviceSide] = linkedPair();
  const ticketId = crypto.randomUUID();
  void f.host.serve(hostSide, { streamId: crypto.randomUUID(), purpose: start.purpose, ticketId, accountId: dev.accountId, deviceId: dev.deviceId,
    deviceSpkiSha256: dev.identity.spkiSha256.toString("hex"), invitationId: start.invitationId, authExpiresAt: f.now.value + 3_600_000, ...open });
  return RemoteSession.open(deviceSide, { identity: dev.identity, hostSpkiSha256: f.hostTls.spkiSha256, hostId: HOST_ID, ticketId,
    accountId: dev.accountId, deviceId: dev.deviceId, timeoutMs: 5000, ...start });
}
const pairWith = (f: Fixture, dev: Device, key = f.host.createInvitation(), overrides: Partial<SessionStart> = {}, open: Partial<StreamOpen> = {}) => {
  const parsed = decodeConnectionKey(key.key, { environment: 1 });
  return connect(f, dev, { purpose: "pair", invitationId: parsed.invitationId, secret: parsed.secret, hostSpkiSha256: parsed.hostSpkiSha256, deviceName: "Mac", ...overrides }, open);
};
const denied = (code: string) => (error: unknown) => error instanceof RemoteRequestError && error.code === code;

test("a device pairs with the key, gets a grant and a signed-off receipt, and reconnects without it", async t => {
  const f = fixture(t), mac = device();
  const session = await pairWith(f, mac);
  assert.equal(session.welcome.hostName, "Fedora");
  assert.ok(session.welcome.capabilities.includes("host.info"));
  assert.deepEqual(await session.request("host.info"), { name: "Fedora", deviceId: mac.deviceId });
  assert.equal(f.store.owner(), "acct-1");
  const grant = f.store.activeGrant(mac.deviceId)!;
  assert.equal(grant.deviceSpkiSha256, mac.identity.spkiSha256.toString("hex"));
  assert.equal(grant.deviceName, "Mac");
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0]!.receiptId, grant.receiptId);
  session.close();

  const again = await connect(f, mac, { purpose: "connect" });
  assert.deepEqual(await again.request("host.info"), { name: "Fedora", deviceId: mac.deviceId });
  await assert.rejects(again.request("fail.known"), denied("not_found"));
  await assert.rejects(again.request("fail.unknown"), (error: unknown) => error instanceof RemoteRequestError && error.code === "operation_failed" && !error.message.includes("/srv"));
  await assert.rejects(again.request("nope"), denied("unknown_operation"));
  assert.deepEqual(await Promise.all([again.request("slow"), again.request("slow")]), ["done", "done"]);
  again.close();
});

test("pairing is refused for a wrong secret, a reused or replayed key, another account and a mismatched ticket", async t => {
  const f = fixture(t), mac = device();
  const key = f.host.createInvitation();
  await assert.rejects(pairWith(f, mac, key, { secret: crypto.randomBytes(32) }), denied("proof_invalid"));
  assert.equal(f.store.owner(), undefined, "a failed proof claims nothing");
  await assert.rejects(pairWith(f, mac, key, {}, { accountId: "acct-other" }), denied("hello_mismatch"));
  await assert.rejects(pairWith(f, mac, key, {}, { deviceSpkiSha256: crypto.randomBytes(32).toString("hex") }), denied("device_key_mismatch"));
  (await pairWith(f, mac, key)).close();
  await assert.rejects(pairWith(f, device(), key), denied("invitation_unknown"), "a key works once");
  await assert.rejects(pairWith(f, device("acct-2")), denied("owner_mismatch"), "a claimed server belongs to its owner");
  f.now.value += 11 * 60_000;
  await assert.rejects(pairWith(f, device(), key), denied("invitation_unknown"));
});

test("the device refuses a server whose key does not match before sending anything", async t => {
  const f = fixture(t), mac = device();
  await assert.rejects(pairWith(f, mac, f.host.createInvitation(), { hostSpkiSha256: crypto.randomBytes(32) }),
    (error: unknown) => (error as { code?: string }).code === "host_identity_mismatch");
  assert.equal(f.store.owner(), undefined);
});

test("a proof captured from one session does not pair another", async t => {
  const f = fixture(t), mac = device();
  const key = decodeConnectionKey(f.host.createInvitation().key);
  const [hostSide, deviceSide] = linkedPair();
  const ticketId = crypto.randomUUID();
  void f.host.serve(hostSide, { streamId: "s", purpose: "pair", ticketId, accountId: mac.accountId, deviceId: mac.deviceId,
    deviceSpkiSha256: mac.identity.spkiSha256.toString("hex"), invitationId: key.invitationId, authExpiresAt: Date.now() + 60_000 });
  const socket = await connectTls(deviceSide, mac.identity, key.hostSpkiSha256);
  const channel = new FramedChannel(socket);
  // The proof is computed for a different ticket: it must not verify in this session.
  const stale = pairingProof(key.secret, pairingExporter(socket, { hostId: HOST_ID, invitationId: key.invitationId, ticketId: crypto.randomUUID(),
    accountId: mac.accountId, deviceId: mac.deviceId, deviceSpkiSha256: mac.identity.spkiSha256, hostSpkiSha256: key.hostSpkiSha256 }));
  channel.send({ type: "hello", protocol: 1, purpose: "pair", accountId: mac.accountId, deviceId: mac.deviceId, invitationId: key.invitationId, proof: stale.toString("base64url") });
  const reply = await new Promise(resolve => channel.once("message", resolve));
  assert.deepEqual((reply as { code: string }).code, "proof_invalid");
});

test("two devices racing with one key produce exactly one grant", async t => {
  const f = fixture(t);
  const key = f.host.createInvitation();
  const results = await Promise.allSettled([pairWith(f, device(), key), pairWith(f, device(), key)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(f.store.grants().filter(grant => grant.status === "active").length, 1);
  for (const result of results) if (result.status === "fulfilled") result.value.close();
});

test("reconnecting needs an active grant for this account and key; revocation ends live sessions", async t => {
  const f = fixture(t), mac = device();
  (await pairWith(f, mac)).close();
  await assert.rejects(connect(f, device(), { purpose: "connect" }), denied("not_authorized"), "an unknown device");
  const otherKey = { ...mac, identity: createTlsIdentity("lc-device") };
  await assert.rejects(connect(f, otherKey, { purpose: "connect" }), denied("not_authorized"), "the same device id with another key");
  await assert.rejects(connect(f, { ...mac, accountId: "acct-2" }, { purpose: "connect" }), denied("not_authorized"), "another account");

  const live = await connect(f, mac, { purpose: "connect" });
  const closed = new Promise(resolve => live.once("close", resolve));
  f.store.revoke(mac.deviceId, "host", new Date());
  f.host.disconnectDevice(mac.deviceId);
  assert.equal(await closed, "revoked");
  await assert.rejects(live.request("host.info"), denied("disconnected"));
  await assert.rejects(connect(f, mac, { purpose: "connect" }), denied("not_authorized"));

  assert.equal(f.store.applyRevocation({ seq: 3, kind: "host" }, new Date()), true);
  assert.equal(f.store.applyRevocation({ seq: 3, kind: "host" }, new Date()), false, "a revocation applies once");
  assert.equal(f.store.owner(), undefined, "an unlinked server can be claimed again");
});

test("a session ends when its Cloud authorization expires", async t => {
  const f = fixture(t), mac = device();
  (await pairWith(f, mac)).close();
  const session = await connect(f, mac, { purpose: "connect" }, { authExpiresAt: f.now.value + 100 });
  // Session timers do not keep a process alive; an in-memory transport holds no handle either.
  const alive = setInterval(() => undefined, 50);
  try { assert.equal(await new Promise(resolve => session.once("close", resolve)), "auth_expired"); } finally { clearInterval(alive); }
});

test("requests before the welcome and oversized frames close the connection", async t => {
  const f = fixture(t), mac = device();
  (await pairWith(f, mac)).close();
  const raw = async () => {
    const [hostSide, deviceSide] = linkedPair();
    void f.host.serve(hostSide, { streamId: "s", purpose: "connect", ticketId: "t", accountId: mac.accountId, deviceId: mac.deviceId,
      deviceSpkiSha256: mac.identity.spkiSha256.toString("hex"), authExpiresAt: Date.now() + 60_000 });
    const channel = new FramedChannel(await connectTls(deviceSide, mac.identity, f.hostTls.spkiSha256));
    const messages: unknown[] = [];
    channel.on("message", message => messages.push(message));
    return { channel, messages, closed: new Promise(resolve => channel.once("close", resolve)) };
  };
  const frame = (message: object) => { const body = Buffer.from(JSON.stringify(message)); const size = Buffer.alloc(4); size.writeUInt32BE(body.length); return Buffer.concat([size, body]); };
  const early = await raw();
  // One write: the request reaches the host before it could have sent the welcome.
  early.channel.socket.write(Buffer.concat([frame({ type: "hello", protocol: 1, purpose: "connect", accountId: mac.accountId, deviceId: mac.deviceId }),
    frame({ type: "request", id: 1, op: "host.info" })]));
  await early.closed;
  assert.equal(early.messages.some(message => (message as { type: string }).type === "response"), false);

  const big = await raw();
  const size = Buffer.alloc(4); size.writeUInt32BE(2 * 1024 * 1024);
  big.channel.socket.write(size);
  await big.closed;
});

test("a saved identity is restored only with its own key", () => {
  const identity = createTlsIdentity("lc-device");
  assert.deepEqual(loadTlsIdentity({ keyPem: identity.keyPem, certPem: identity.certPem }).spkiSha256, identity.spkiSha256);
  assert.throws(() => loadTlsIdentity({ keyPem: createTlsIdentity("x").keyPem, certPem: identity.certPem }), /does not match/);
});

test("a computer newer than its server is told to update the server, with the server's version", async t => {
  const f = fixture(t), mac = device();
  const key = decodeConnectionKey(f.host.createInvitation().key);
  const [hostSide, deviceSide] = linkedPair();
  void f.host.serve(hostSide, { streamId: "s", purpose: "pair", ticketId: crypto.randomUUID(), accountId: mac.accountId, deviceId: mac.deviceId,
    deviceSpkiSha256: mac.identity.spkiSha256.toString("hex"), invitationId: key.invitationId, authExpiresAt: Date.now() + 60_000 });
  const socket = await connectTls(deviceSide, mac.identity, key.hostSpkiSha256);
  const channel = new FramedChannel(socket);
  channel.send({ type: "hello", protocol: 99, purpose: "pair", accountId: mac.accountId, deviceId: mac.deviceId, invitationId: key.invitationId });
  const reply = await new Promise(resolve => channel.once("message", resolve)) as { code: string; message: string; serverVersion: string };
  assert.equal(reply.code, "server_too_old");
  assert.match(reply.message, /Update the server: sudo local-cognitive-server update/);
  assert.equal(reply.serverVersion, "0.1.0");
});
