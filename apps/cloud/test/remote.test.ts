import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { PROFILE_CLAIM_NAMESPACE as ns } from "../src/auth/profileClaims.js";
import { migrate } from "../src/db/migrate.js";
import { MIGRATIONS_DIR } from "../src/paths.js";
import { CLOSE, Relay, RELAY_PATHS } from "../src/remote/relay.js";
import { createRemoteRepository } from "../src/remote/remoteRepository.js";
import { relayAuthMessage, SIGNATURE_CONTEXT } from "../src/remote/signatures.js";
import { createTestDatabase, databaseSkip } from "./helpers/testDatabase.js";

const issuer = "https://tenant.example.auth0.com/", audience = "https://api.test";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
const token = (subject: string, verified = true) => new SignJWT({ [`${ns}email`]: `${subject}@example.test`, [`${ns}email_verified`]: verified })
  .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(privateKey);
const signFor = (key: KeyObject, context: string, message: Buffer) => sign(null, Buffer.concat([Buffer.from(context), Buffer.from([0]), message]), key);

async function cloud(t: TestContext) {
  const pool = await createTestDatabase(t);
  await migrate(pool, MIGRATIONS_DIR);
  const repo = createRemoteRepository(pool);
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const relay = new Relay({ repo, origin, limits: { authTimeoutMs: 500, attachTimeoutMs: 1000 } });
  server.on("request", createApp({ pool, auth: { issuer, audience, keys }, remote: { repo, relay, limits: { registrationsPerHour: 3 } } }));
  server.on("upgrade", relay.handleUpgrade);
  t.after(() => new Promise<void>(resolve => { relay.close(); server.closeAllConnections(); server.close(() => resolve()); }));
  const api = async (method: string, url: string, body?: unknown, bearer?: string) => {
    const response = await fetch(`${origin}${url}`, { method, headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() as any };
  };
  return { pool, origin, api, ws: (pathname: string) => new WebSocket(`${origin.replace("http", "ws")}${pathname}`) };
}
type Cloud = Awaited<ReturnType<typeof cloud>>;

/** A queue of a socket's text messages and its close code. */
const watch = (socket: WebSocket) => {
  const messages: any[] = [];
  const waiters: Array<(message: any) => void> = [];
  socket.on("message", (data, binary) => { if (binary) return; const message = JSON.parse(data.toString()); const waiter = waiters.shift(); if (waiter) waiter(message); else messages.push(message); });
  const closed = new Promise<number>(resolve => socket.once("close", code => resolve(code)));
  return { next: () => new Promise<any>(resolve => { const message = messages.shift(); if (message) resolve(message); else waiters.push(resolve); }), closed,
    opened: new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); }) };
};

async function registerHost(c: Cloud, name = "Fedora") {
  const signing = generateKeyPairSync("ed25519");
  const signingPublicKey = Buffer.from(signing.publicKey.export({ format: "jwk" }).x!, "base64url");
  const payload = Buffer.from(JSON.stringify({ signingPublicKey: signingPublicKey.toString("base64url"), tlsSpkiSha256: randomBytes(32).toString("hex"), name, appVersion: "0.1.0", protocol: 1 }));
  const response = await c.api("POST", "/v1/hosts/register", { payload: payload.toString("base64url"), signature: signFor(signing.privateKey, SIGNATURE_CONTEXT.register, payload).toString("base64url") });
  return { hostId: response.body.hostId as string, status: response.status, signing: signing.privateKey, payload };
}

async function connectHost(c: Cloud, host: { hostId: string; signing: KeyObject }, lastRevocationSeq = 0, appVersion?: string) {
  const socket = c.ws(RELAY_PATHS.host), control = watch(socket);
  await control.opened;
  socket.send(JSON.stringify({ type: "hello", hostId: host.hostId, protocol: 1, lastRevocationSeq, ...(appVersion ? { appVersion } : {}) }));
  const challenge = await control.next();
  socket.send(JSON.stringify({ type: "auth", signature: signFor(host.signing, SIGNATURE_CONTEXT.relayAuth, relayAuthMessage(host.hostId, challenge.nonce, c.origin)).toString("base64url") }));
  return { socket, control, ready: await control.next(), send: (message: object) => socket.send(JSON.stringify(message)) };
}

const user = async (c: Cloud, subject: string, verified = true) => {
  const bearer = await token(subject, verified);
  const device = await c.api("POST", "/v1/devices", { spkiSha256: randomBytes(32).toString("hex"), name: "Mac", platform: "macos" }, bearer);
  const me = await c.api("GET", "/v1/me", undefined, bearer);
  return { bearer, deviceId: device.body.deviceId as string, accountId: me.body.accountId as string };
};

/** A device connection through the relay, attached by the host, as raw bytes. */
async function relayed(c: Cloud, host: Awaited<ReturnType<typeof connectHost>>, ticket: string) {
  const client = c.ws(RELAY_PATHS.client), clientEvents = watch(client);
  await clientEvents.opened;
  client.send(JSON.stringify({ type: "auth", ticket }));
  const open = await host.control.next();
  assert.equal(open.type, "stream.open");
  const stream = c.ws(RELAY_PATHS.hostStream), streamEvents = watch(stream);
  await streamEvents.opened;
  stream.send(JSON.stringify({ type: "attach", streamId: open.streamId, streamToken: open.streamToken }));
  assert.deepEqual(await clientEvents.next(), { type: "connected" });
  return { client, stream, open, clientClosed: clientEvents.closed, streamClosed: streamEvents.closed };
}
const nextBinary = (socket: WebSocket) => new Promise<Buffer>(resolve => socket.once("message", data => resolve(data as Buffer)));

test("hosts register with proof of their key and authenticate the control channel by signature", { skip: databaseSkip }, async t => {
  const c = await cloud(t);
  const host = await registerHost(c);
  assert.equal(host.status, 201);
  const forged = { payload: host.payload.toString("base64url"), signature: randomBytes(64).toString("base64url") };
  assert.equal((await c.api("POST", "/v1/hosts/register", forged)).status, 401);
  const again = await c.api("POST", "/v1/hosts/register", { payload: host.payload.toString("base64url"),
    signature: signFor(host.signing, SIGNATURE_CONTEXT.register, host.payload).toString("base64url") });
  assert.deepEqual([again.status, again.body.hostId], [200, host.hostId], "re-registering keeps the id");
  assert.equal((await registerHost(c)).status, 429, "registrations are rate limited per address");

  const online = await connectHost(c, host);
  assert.deepEqual(online.ready, { type: "ready", ownerAccountId: null, revocations: [] });
  const impostor = c.ws(RELAY_PATHS.host), events = watch(impostor);
  await events.opened;
  impostor.send(JSON.stringify({ type: "hello", hostId: host.hostId, protocol: 1, lastRevocationSeq: 0 }));
  await events.next();
  impostor.send(JSON.stringify({ type: "auth", signature: randomBytes(64).toString("base64url") }));
  assert.equal(await events.closed, CLOSE.auth);
  // After an update the host connects with its new version, and that is what is stored.
  const replacement = await connectHost(c, host, 0, "0.2.0");
  assert.equal(await online.control.closed, CLOSE.replaced, "a second connection of the same host replaces the first");
  assert.equal((await c.pool.query("SELECT app_version FROM hosts WHERE id = $1", [host.hostId])).rows[0].app_version, "0.2.0");
  replacement.socket.close();
});

test("pairing: tickets, relayed bytes, a signed claim, then connect tickets; revocation cuts sessions", { skip: databaseSkip }, async t => {
  const c = await cloud(t);
  const registered = await registerHost(c);
  const alice = await user(c, "auth0|alice"), bob = await user(c, "auth0|bob"), unverified = await user(c, "auth0|eve", false);
  const invitationId = randomUUID();
  const pair = (who: typeof alice, extra: object = {}) => c.api("POST", "/v1/connections", { purpose: "pair", hostId: registered.hostId, deviceId: who.deviceId, invitationId, ...extra }, who.bearer);

  assert.deepEqual((await pair(alice)).body, { error: "host_offline" });
  const host = await connectHost(c, registered);
  assert.deepEqual((await pair(alice)).body, { error: "invitation_unknown" });
  host.send({ type: "invitation.announce", invitationId, expiresAt: Date.now() + 600_000 });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual((await pair(unverified)).body, { error: "email_unverified" });
  assert.deepEqual((await pair(alice, { deviceId: bob.deviceId })).body, { error: "device_unknown" }, "another account's device");
  assert.deepEqual((await c.api("POST", "/v1/connections", { purpose: "connect", hostId: registered.hostId, deviceId: alice.deviceId }, alice.bearer)).body,
    { error: "not_authorized" });

  const issued = await pair(alice);
  assert.equal(issued.status, 201);
  const stored = await c.pool.query("SELECT token_sha256 FROM connection_tickets WHERE id = $1", [issued.body.ticketId]);
  assert.deepEqual(stored.rows[0].token_sha256, createHash("sha256").update(Buffer.from(issued.body.ticket, "base64url")).digest(), "only the hash is stored");

  const session = await relayed(c, host, issued.body.ticket);
  assert.equal(session.open.purpose, "pair");
  assert.equal(session.open.accountId, alice.accountId);
  assert.equal(session.open.invitationId, invitationId);
  const big = randomBytes(60 * 1024);
  session.client.send(big, { binary: true });
  assert.deepEqual(await nextBinary(session.stream), big);
  session.stream.send(Buffer.from("pong"), { binary: true });
  assert.deepEqual(await nextBinary(session.client), Buffer.from("pong"));

  const reuse = c.ws(RELAY_PATHS.client), reuseEvents = watch(reuse);
  await reuseEvents.opened;
  reuse.send(JSON.stringify({ type: "auth", ticket: issued.body.ticket }));
  assert.equal(await reuseEvents.closed, CLOSE.auth, "a ticket works once");
  const queryOnly = new WebSocket(`${c.origin.replace("http", "ws")}${RELAY_PATHS.client}?ticket=${issued.body.ticket}`), queryEvents = watch(queryOnly);
  assert.equal(await queryEvents.closed, CLOSE.authTimeout, "a ticket in the URL is ignored");

  const receipt = { receiptId: randomUUID(), hostId: registered.hostId, invitationId, ticketId: session.open.ticketId, accountId: alice.accountId,
    deviceId: alice.deviceId, deviceSpkiSha256: session.open.deviceSpkiSha256, grantedAt: new Date().toISOString() };
  const claim = (body: object, key = registered.signing) => {
    const payload = Buffer.from(JSON.stringify(body));
    host.send({ type: "claim.confirm", payload: payload.toString("base64url"), signature: signFor(key, SIGNATURE_CONTEXT.claim, payload).toString("base64url") });
    return host.control.next();
  };
  assert.deepEqual(await claim({ ...receipt, deviceId: bob.deviceId }), { type: "claim.reject", receiptId: receipt.receiptId, code: "ticket_mismatch" });
  assert.equal((await claim(receipt, generateKeyPairSync("ed25519").privateKey)).code, "invalid_receipt", "a signature by another key");
  assert.deepEqual(await claim(receipt), { type: "claim.ack", receiptId: receipt.receiptId });
  assert.deepEqual(await claim(receipt), { type: "claim.ack", receiptId: receipt.receiptId }, "idempotent");

  const hosts = await c.api("GET", "/v1/hosts", undefined, alice.bearer);
  assert.equal(hosts.body.hosts.length, 1);
  assert.equal(hosts.body.hosts[0].online, true);
  assert.deepEqual(hosts.body.hosts[0].devices.map((device: any) => [device.deviceId, device.status]), [[alice.deviceId, "active"]]);
  assert.deepEqual((await c.api("GET", "/v1/hosts", undefined, bob.bearer)).body.hosts, []);
  const bobInvite = randomUUID();
  host.send({ type: "invitation.announce", invitationId: bobInvite, expiresAt: Date.now() + 600_000 });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual((await pair(bob, { invitationId: bobInvite })).body, { error: "host_owned_by_other" });

  const connect = await c.api("POST", "/v1/connections", { purpose: "connect", hostId: registered.hostId, deviceId: alice.deviceId }, alice.bearer);
  assert.equal(connect.status, 201);
  const live = await relayed(c, host, connect.body.ticket);
  assert.equal(live.open.purpose, "connect");
  assert.equal((await c.api("DELETE", `/v1/hosts/${registered.hostId}/devices/${alice.deviceId}`, undefined, bob.bearer)).status, 404, "only the owner revokes");
  assert.equal((await c.api("DELETE", `/v1/hosts/${registered.hostId}/devices/${alice.deviceId}`, undefined, alice.bearer)).status, 204);
  assert.deepEqual(await host.control.next(), { type: "revocation", seq: 1, kind: "device", deviceId: alice.deviceId });
  assert.equal(await live.clientClosed, CLOSE.revoked);
  assert.deepEqual((await c.api("POST", "/v1/connections", { purpose: "connect", hostId: registered.hostId, deviceId: alice.deviceId }, alice.bearer)).body,
    { error: "not_authorized" });

  host.socket.close();
  const back = await connectHost(c, registered, 0);
  assert.deepEqual(back.ready.revocations, [{ seq: 1, kind: "device", deviceId: alice.deviceId }], "a host offline at revocation gets it on reconnect");
  assert.equal((await c.api("DELETE", `/v1/hosts/${registered.hostId}`, undefined, alice.bearer)).status, 204);
  assert.deepEqual(await back.control.next(), { type: "revocation", seq: 2, kind: "host", deviceId: null });
  assert.deepEqual((await c.api("GET", "/v1/hosts", undefined, alice.bearer)).body.hosts, []);
  back.socket.close();
});

test("an invitation issues a bounded number of tickets and a host must attach in time", { skip: databaseSkip }, async t => {
  const c = await cloud(t);
  const registered = await registerHost(c);
  const alice = await user(c, "auth0|alice");
  const host = await connectHost(c, registered);
  const announce = async () => {
    const invitationId = randomUUID();
    host.send({ type: "invitation.announce", invitationId, expiresAt: Date.now() + 600_000 });
    await new Promise(resolve => setTimeout(resolve, 100));
    return invitationId;
  };
  const pair = (invitationId: string) => c.api("POST", "/v1/connections", { purpose: "pair", hostId: registered.hostId, deviceId: alice.deviceId, invitationId }, alice.bearer);
  const invitationId = await announce();
  const statuses = [];
  for (let index = 0; index < 11; index++) statuses.push((await pair(invitationId)).status);
  assert.deepEqual(statuses, [...Array(10).fill(201), 429]);

  // The host is told about the stream but never attaches: the device is not left waiting.
  const issued = await pair(await announce());
  const client = c.ws(RELAY_PATHS.client), events = watch(client);
  await events.opened;
  client.send(JSON.stringify({ type: "auth", ticket: issued.body.ticket }));
  assert.equal((await host.control.next()).type, "stream.open");
  assert.equal(await events.closed, CLOSE.hostOffline);
  host.socket.close();
});
