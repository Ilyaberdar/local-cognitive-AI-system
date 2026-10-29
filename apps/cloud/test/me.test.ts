import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type pg from "pg";
import type { AccountRepository } from "../src/accounts/accountRepository.js";
import { createApp } from "../src/app.js";
import { PROFILE_CLAIM_NAMESPACE as ns } from "../src/auth/profileClaims.js";
import { memoryAccounts } from "./helpers/memoryAccounts.js";
import { listen } from "./helpers/testServer.js";

const issuer = "https://tenant.example.auth0.com/", audience = "https://api.test";
const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
const { publicKey, privateKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
const token = (subject: string, claims: Record<string, unknown> = {}) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" })
  .setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(privateKey);

const me = async (accounts: AccountRepository, bearer: string) => {
  const server = await listen(createApp({ pool, auth: { issuer, audience, keys }, accounts }));
  try {
    const response = await fetch(`${server.url}/v1/me`, { headers: { authorization: `Bearer ${bearer}` } });
    return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() as Record<string, any> };
  } finally { await server.close(); }
};

test("first login creates one account; later logins return it with fresh profile claims", async () => {
  const store = memoryAccounts();
  const first = await me(store.repository, await token("auth0|1", { [`${ns}email`]: "a@b.test", [`${ns}email_verified`]: false }));
  assert.equal(first.status, 200);
  assert.equal(first.cache, "no-store");
  assert.equal(first.body.emailVerified, false);
  assert.deepEqual(first.body.identities.map((identity: { provider: string }) => identity.provider), ["email"]);
  const second = await me(store.repository, await token("auth0|1", { [`${ns}email`]: "a@b.test", [`${ns}email_verified`]: true, [`${ns}name`]: "Mira" }));
  assert.equal(second.body.accountId, first.body.accountId);
  assert.equal(second.body.emailVerified, true);
  assert.equal(second.body.displayName, "Mira");
});

test("a Sign in with Apple identity keeps its relay email and verification when a later token carries no email", async () => {
  const store = memoryAccounts(), relay = "x7k2@privaterelay.appleid.com";
  const first = await me(store.repository, await token("apple|001234.abc", { [`${ns}email`]: relay, [`${ns}email_verified`]: true, [`${ns}name`]: "Mira" }));
  assert.deepEqual([first.status, first.body.email, first.body.emailVerified, first.body.displayName], [200, relay, true, "Mira"]);
  assert.deepEqual(first.body.identities.map((identity: { provider: string }) => identity.provider), ["apple"]);
  const later = await me(store.repository, await token("apple|001234.abc"));
  assert.deepEqual([later.body.accountId, later.body.email, later.body.emailVerified, later.body.displayName], [first.body.accountId, relay, true, "Mira"],
    "Apple sends the name once; a token without an email says nothing new about the identity");
  const changed = await me(store.repository, await token("apple|001234.abc", { [`${ns}email`]: "mira@example.test", [`${ns}email_verified`]: false }));
  assert.deepEqual([changed.body.email, changed.body.emailVerified, changed.body.displayName], ["mira@example.test", false, "Mira"],
    "a token with an email replaces it, unverified too");
  const google = await me(store.repository, await token("google-oauth2|9", { [`${ns}email`]: "mira@example.test", [`${ns}email_verified`]: true }));
  assert.notEqual(google.body.accountId, first.body.accountId, "never merged by email");
});

test("missing claims, machine tokens, disabled accounts and storage failures", async () => {
  const store = memoryAccounts();
  const missing = await me(store.repository, await token("google-oauth2|2"));
  assert.deepEqual([missing.status, missing.body.email, missing.body.emailVerified], [200, null, false]);
  assert.deepEqual(await me(store.repository, await token("client@clients")), { status: 403, cache: null, body: { error: "user_token_required" } });
  store.disable(missing.body.accountId);
  assert.deepEqual((await me(store.repository, await token("google-oauth2|2"))).body, { error: "account_disabled" });
  const failing: AccountRepository = { upsertIdentity: async () => { throw new Error("db down"); }, loadAccount: async () => undefined };
  assert.deepEqual((await me(failing, await token("auth0|3"))).body, { error: "internal_error" });
});
