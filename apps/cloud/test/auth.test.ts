import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import type pg from "pg";
import { createApp } from "../src/app.js";
import { memoryAccounts } from "./helpers/memoryAccounts.js";
import { listen } from "./helpers/testServer.js";

const issuer = "https://tenant.example.auth0.com/";
const audience = "https://api.test";
const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
const { publicKey, privateKey } = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });

const token = (claims: { iss?: string; aud?: string; sub?: string | null; exp?: string | number } = {}, key = privateKey) => {
  const jwt = new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(claims.iss ?? issuer)
    .setAudience(claims.aud ?? audience).setIssuedAt().setExpirationTime(claims.exp ?? "5m");
  if (claims.sub !== null) jwt.setSubject(claims.sub ?? "google-oauth2|123");
  return jwt.sign(key);
};

const me = async (keySet: JWTVerifyGetKey, authorization?: string) => {
  const server = await listen(createApp({ pool, auth: { issuer, audience, keys: keySet }, accounts: memoryAccounts().repository }));
  try {
    const response = await fetch(`${server.url}/v1/me`, { headers: authorization ? { authorization } : {} });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally { await server.close(); }
};

test("a valid access token resolves an account", async () => {
  const { status, body } = await me(keys, `Bearer ${await token()}`);
  assert.equal(status, 200);
  assert.match(String(body.accountId), /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(body).includes("google-oauth2|123"), false, "the subject is never exposed");
});

test("missing, malformed and invalid tokens are 401", async () => {
  const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: issuer, aud: audience, sub: "x", exp: 9_999_999_999 })).toString("base64url")}.`;
  for (const authorization of [undefined, "Basic abc", "Bearer not a token", `Bearer ${await token({ aud: "https://other" })}`,
    `Bearer ${await token({ iss: "https://evil.example/" })}`, `Bearer ${await token({ exp: Math.floor(Date.now() / 1000) - 60 })}`,
    `Bearer ${await token({}, other.privateKey)}`, `Bearer ${await token({ sub: null })}`, `Bearer ${unsigned}`]) {
    assert.equal((await me(keys, authorization)).status, 401, authorization);
  }
});

test("an unreachable key set is 503, not a reason to sign out", async () => {
  const unreachable: JWTVerifyGetKey = async () => { throw new TypeError("fetch failed"); };
  assert.deepEqual(await me(unreachable, `Bearer ${await token()}`), { status: 503, body: { error: "auth_unavailable" } });
});
