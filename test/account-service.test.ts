import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { TestContext } from "node:test";
import { AccountService } from "../src/account/AccountService";
import type { AccountConfig } from "../src/account/accountConfig";
import type { AccountStatus } from "../src/account/errors";
import type { CredentialVault } from "../src/plugins/contracts";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

const memoryVault = () => {
  const data = new Map<string, string>();
  const vault: CredentialVault = { available: () => true, read: async key => data.get(key), write: async (key, value) => { data.set(key, value); }, remove: async key => { data.delete(key); } };
  return { data, vault };
};

async function fakeServers(t: TestContext) {
  const state = {
    tokenCalls: [] as URLSearchParams[], revoked: [] as string[], meStatus: 200, refreshStatus: 200, refreshError: "", revokeStatus: 200,
    rotation: 1, nonce: "", emailVerified: true, holdRefresh: undefined as Promise<void> | undefined
  };
  let issuer = "";
  const idToken = (sub = "auth0|user") => `${encode({ alg: "RS256" })}.${encode({ iss: issuer, aud: "client-1", sub, exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000), nonce: state.nonce, email: "mira@example.test", name: "Mira" })}.signature`;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const form = new URLSearchParams(body);
    const json = (status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.url === "/oauth/token") {
      state.tokenCalls.push(form);
      if (form.get("grant_type") === "authorization_code") return json(200, { access_token: "access-0", refresh_token: "refresh-0", id_token: idToken(), expires_in: 3600 });
      await state.holdRefresh;
      if (state.refreshStatus !== 200) return json(state.refreshStatus, { error: state.refreshError });
      const next = state.rotation++;
      return json(200, { access_token: `access-${next}`, refresh_token: `refresh-${next}`, id_token: idToken(), expires_in: 3600 });
    }
    if (request.url === "/oauth/revoke") { state.revoked.push(form.get("token") ?? ""); response.writeHead(state.revokeStatus); response.end(); return; }
    if (request.url === "/v1/me") {
      if (state.meStatus !== 200 || !request.headers.authorization?.startsWith("Bearer access-")) return json(state.meStatus === 200 ? 401 : state.meStatus, { error: "x" });
      return json(200, { accountId: "acc-1", email: "mira@example.test", emailVerified: state.emailVerified, displayName: "Mira" });
    }
    json(404, {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  issuer = `${base}/`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config: AccountConfig = { authority: base, issuer, clientId: "client-1", audience: "https://api.test", scope: "openid profile email offline_access",
    callbackPort: 0, cloudUrl: base };
  return { state, config };
}

async function setup(t: TestContext, overrides: Partial<ConstructorParameters<typeof AccountService>[0]> = {}) {
  const servers = await fakeServers(t), storage = memoryVault();
  const opened: string[] = [];
  let completions = 0;
  const create = () => new AccountService({ config: servers.config, vault: storage.vault, onCompleted: () => { completions++; },
    openExternal: async url => { opened.push(url); servers.state.nonce = new URL(url).searchParams.get("nonce") ?? ""; }, ...overrides });
  const service = create();
  t.after(() => service.dispose());
  return { ...servers, ...storage, service, create, opened, completions: () => completions };
}

const browserReturn = async (authorizeUrl: string, parameters: Record<string, string>, init?: RequestInit) => {
  const url = new URL(authorizeUrl), callback = new URL(url.searchParams.get("redirect_uri")!);
  for (const [name, value] of Object.entries({ state: url.searchParams.get("state")!, ...parameters })) callback.searchParams.append(name, value);
  const response = await fetch(callback, init);
  return { status: response.status, text: await response.text() };
};
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
const signedIn = (status: AccountStatus) => status.state === "signed-in";

test("sign-in stores only a refresh token, returns a safe status and survives a restart with rotation", async t => {
  const f = await setup(t);
  assert.deepEqual(await f.service.signIn("google"), { state: "signing-in" });
  const page = await browserReturn(f.opened[0]!, { code: "code-1" });
  assert.equal(page.status, 200);
  assert.match(page.text, /You’re signed in/);
  assert.match(page.text, /localcognitive:\/\/auth\/complete\/[A-Za-z0-9_-]{22}/);
  const exchange = f.state.tokenCalls[0]!;
  assert.equal(exchange.get("redirect_uri"), new URL(f.opened[0]!).searchParams.get("redirect_uri"));
  assert.ok(exchange.get("code_verifier"));
  const status = f.service.status();
  assert.deepEqual(status, { state: "signed-in", cloudReachable: true, profile: { accountId: "acc-1", email: "mira@example.test", emailVerified: true, name: "Mira" } });
  assert.doesNotMatch(JSON.stringify(status), /access-|refresh-/);
  const stored = f.data.get("account/session")!;
  assert.match(stored, /refresh-0/);
  assert.doesNotMatch(stored, /access-0/);
  assert.equal(f.completions(), 1);

  const restarted = f.create(); t.after(() => restarted.dispose());
  await restarted.init();
  assert.equal(restarted.status().state, "signed-in");
  await restarted.refreshNow();
  assert.match(f.data.get("account/session")!, /refresh-1/, "the rotated refresh token is persisted");
  await restarted.refreshNow();
  assert.equal(f.state.tokenCalls.at(-1)!.get("refresh_token"), "refresh-1");
});

test("callback requests with a wrong state, method or path are rejected without consuming the attempt", async t => {
  const f = await setup(t);
  await f.service.signIn("email");
  const callback = new URL(new URL(f.opened[0]!).searchParams.get("redirect_uri")!);
  assert.equal((await browserReturn(f.opened[0]!, { code: "c", state: "wrong" })).status, 400);
  assert.equal((await fetch(`${callback.origin}/other?code=c`)).status, 400);
  assert.equal((await browserReturn(f.opened[0]!, { code: "c" }, { method: "POST" })).status, 400);
  assert.equal(f.service.status().state, "signing-in");
  assert.equal((await browserReturn(f.opened[0]!, { code: "c" })).status, 200);
  assert.ok(signedIn(f.service.status()));
  await assert.rejects(fetch(callback), "the listener closes after sign-in");
});

test("denied authorization, timeouts, busy ports and an unreachable Cloud end in clear errors", async t => {
  const f = await setup(t);
  await f.service.signIn("google");
  assert.equal((await browserReturn(f.opened[0]!, { error: "access_denied" })).status, 400);
  assert.deepEqual(f.service.status(), { state: "error", error: { code: "authorization_denied", message: "Sign-in was cancelled or denied in the browser." } });

  f.state.meStatus = 503;
  await f.service.signIn("google");
  await browserReturn(f.opened[1]!, { code: "c" });
  assert.equal(f.service.status().state === "error" && f.service.status().state, "error");
  assert.equal((f.service.status() as { error: { code: string } }).error.code, "cloud_unreachable");
  assert.equal(f.data.size, 0);
  await waitFor(() => f.state.revoked.includes("refresh-0"));

  const blocker = http.createServer(); blocker.listen(0, "127.0.0.1"); await once(blocker, "listening"); t.after(() => blocker.close());
  const busy = await setup(t);
  const service = new AccountService({ config: { ...busy.config, callbackPort: (blocker.address() as AddressInfo).port }, vault: busy.vault, openExternal: async url => { busy.opened.push(url); } });
  assert.equal((await service.signIn("google") as { error: { code: string } }).error.code, "callback_port_in_use");
  assert.equal(busy.opened.length, 0, "the browser never opens without a listener");

  const slow = await setup(t, { signInTimeoutMs: 20 });
  await slow.service.signIn("email");
  await waitFor(() => slow.service.status().state === "error");
  assert.equal((slow.service.status() as { error: { code: string } }).error.code, "sign_in_timeout");
  assert.deepEqual(slow.service.cancelSignIn(), { state: "signed-out" });
});

test("refresh is single-flight; expired grants sign out; outages keep the session", async t => {
  const f = await setup(t);
  await f.service.signIn("google");
  await browserReturn(f.opened[0]!, { code: "c" });
  const before = f.state.tokenCalls.length;
  await f.service.refreshNow();
  await Promise.all([f.service.refreshNow(), f.service.refreshNow(), f.service.refreshNow()]);
  assert.equal(f.state.tokenCalls.length - before, 2);

  f.state.refreshStatus = 503;
  await f.service.refreshNow();
  assert.deepEqual([f.service.status().state, (f.service.status() as { cloudReachable: boolean }).cloudReachable], ["signed-in", false]);
  f.state.refreshStatus = 200;
  f.state.emailVerified = false;
  await f.service.refreshNow();
  assert.deepEqual((f.service.status() as { profile: { emailVerified: boolean } }).profile.emailVerified, false);

  f.state.refreshStatus = 400; f.state.refreshError = "invalid_grant";
  await f.service.refreshNow();
  assert.equal((f.service.status() as { error: { code: string } }).error.code, "session_expired");
  assert.equal(f.data.size, 0);
});

test("sign-out clears the session immediately, even if revocation fails or a refresh is in flight", async t => {
  const f = await setup(t);
  await f.service.signIn("google");
  await browserReturn(f.opened[0]!, { code: "c" });
  let release!: () => void;
  f.state.holdRefresh = new Promise<void>(resolve => { release = resolve; });
  const refreshing = f.service.refreshNow();
  await waitFor(() => f.state.tokenCalls.length === 2);
  f.state.revokeStatus = 500;
  assert.deepEqual(await f.service.signOut(), { state: "signed-out" });
  release();
  await refreshing;
  assert.deepEqual(f.service.status(), { state: "signed-out" });
  assert.equal(f.data.size, 0);
  await waitFor(() => f.state.revoked.length >= 2);
  assert.ok(f.state.revoked.includes("refresh-0"));
});

test("a session that protected storage cannot read now is kept; one of another sign-in configuration is discarded", async t => {
  const f = await setup(t);
  await f.service.signIn("google");
  await browserReturn(f.opened[0]!, { code: "code-1" });
  const stored = f.data.get("account/session")!;
  // The Keychain refused (or is locked): reading throws.
  const locked = new AccountService({ config: f.config, vault: { ...f.vault, read: async () => { throw new Error("Protected credentials could not be read."); } }, openExternal: async () => {} });
  t.after(() => locked.dispose());
  await locked.init();
  assert.equal(locked.status().state, "signed-out");
  assert.equal(f.data.get("account/session"), stored, "kept for when the storage can be read again");
  const later = f.create(); t.after(() => later.dispose());
  await later.init();
  assert.equal(later.status().state, "signed-in");
  // A different tenant: the record is not this configuration's session.
  const other = new AccountService({ config: { ...f.config, clientId: "client-2" }, vault: f.vault, openExternal: async () => {} });
  t.after(() => other.dispose());
  await other.init();
  assert.equal(f.data.has("account/session"), false);
});
