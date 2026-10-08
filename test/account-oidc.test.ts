import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AccountConfig } from "../src/account/accountConfig";
import { resolveAccountConfig } from "../src/account/accountConfig";
import { parseAuthDeepLink } from "../src/account/deepLink";
import { buildAuthorizeUrl, pkcePair, randomToken, validateIdToken } from "../src/account/oidc";
import { authPageHeaders, renderAuthCompletionPage } from "../src/security/AuthCompletionPage";

const config: AccountConfig = { authority: "https://tenant.example", issuer: "https://tenant.example/", clientId: "client-1",
  audience: "https://api.test", scope: "openid profile email offline_access", callbackPort: 17850, cloudUrl: "http://127.0.0.1:8080" };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = 1_800_000_000_000;
const idToken = (claims: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: "RS256" }) =>
  `${encode(header)}.${encode({ iss: config.issuer, aud: "client-1", sub: "auth0|1", exp: now / 1000 + 600, iat: now / 1000, nonce: "n-1", ...claims })}.signature`;

test("PKCE, state and attempt ids are random and well formed", () => {
  const { verifier, challenge } = pkcePair();
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge);
  assert.equal(verifier.length, 43);
  assert.equal(randomToken(16).length, 22);
  assert.notEqual(randomToken(), randomToken());
});

test("authorize URLs carry PKCE, nonce, audience and per-method hints", () => {
  const base = { redirectUri: "http://127.0.0.1:17850/callback", state: "s", nonce: "n", challenge: "c" };
  const google = new URL(buildAuthorizeUrl(config, { ...base, method: "google" }));
  assert.equal(google.origin + google.pathname, "https://tenant.example/authorize");
  for (const [name, value] of Object.entries({ response_type: "code", client_id: "client-1", redirect_uri: base.redirectUri, audience: "https://api.test",
    state: "s", nonce: "n", code_challenge: "c", code_challenge_method: "S256", prompt: "login", connection: "google-oauth2" })) assert.equal(google.searchParams.get(name), value);
  assert.equal(new URL(buildAuthorizeUrl(config, { ...base, method: "signup" })).searchParams.get("screen_hint"), "signup");
  assert.equal(new URL(buildAuthorizeUrl(config, { ...base, method: "email" })).searchParams.has("connection"), false);
});

test("ID token claims are validated without accepting tampering", () => {
  assert.equal(validateIdToken(idToken(), config, { nonce: "n-1", now }).sub, "auth0|1");
  for (const token of [idToken({ iss: "https://evil/" }), idToken({ aud: "other" }), idToken({ aud: ["client-1", "other"] }), idToken({ nonce: "n-2" }),
    idToken({ exp: now / 1000 - 600 }), idToken({ iat: now / 1000 + 600 }), idToken({}, { alg: "none" }), idToken({}, { alg: "HS256" }),
    `${idToken()}${"x".repeat(17 * 1024)}`, "a.b"]) {
    assert.throws(() => validateIdToken(token, config, { nonce: "n-1", now }), /could not be verified/);
  }
  assert.equal(validateIdToken(idToken({ aud: ["client-1", "other"], azp: "client-1" }), config, { nonce: "n-1", now }).sub, "auth0|1");
  assert.throws(() => validateIdToken(idToken({ sub: "auth0|2" }), config, { subject: "auth0|1", now }));
});

test("deep links only accept the opaque completion id", () => {
  const id = "A".repeat(22);
  assert.equal(parseAuthDeepLink(`localcognitive://auth/complete/${id}`), id);
  assert.equal(parseAuthDeepLink(`LOCALCOGNITIVE://auth/complete/${id}/`), id);
  for (const link of [`localcognitive://auth/complete/${id}?x=1`, `localcognitive://auth/complete/${id}#x`, `localcognitive://user@auth/complete/${id}`,
    `localcognitive://auth/complete/%2e%2e/${id}`, `localcognitive://other/complete/${id}`, `localcognitive://auth/complete/${"A".repeat(21)}`,
    `localcognitive://auth/complete/${"A".repeat(23)}`, `http://auth/complete/${id}`, `localcognitive://auth/complete/${id}${" ".repeat(200)}x`, 42]) {
    assert.equal(parseAuthDeepLink(link), undefined, String(link));
  }
});

test("the completion page escapes text, allows only its hashed style and a valid app link", () => {
  const html = renderAuthCompletionPage({ outcome: "failure", title: "<script>alert(1)</script>", message: `"quoted" & <b>`, appLink: "javascript:alert(1)" });
  assert.doesNotMatch(html, /<script>|<b>|javascript:/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;quoted&quot; &amp; &lt;b&gt;/);
  const success = renderAuthCompletionPage({ outcome: "success", title: "You’re signed in", message: "ok", appLink: `localcognitive://auth/complete/${"B".repeat(22)}` });
  assert.match(success, /Open Local Cognitive/);
  const style = /<style>(.*)<\/style>/.exec(success)![1]!;
  assert.match(authPageHeaders["Content-Security-Policy"]!, new RegExp(`style-src 'sha256-${createHash("sha256").update(style).digest("base64").replace(/[+/]/g, "\\$&")}'`));
  assert.match(authPageHeaders["Content-Security-Policy"]!, /default-src 'none'/);
  assert.doesNotMatch(success, /https?:\/\//);
});

test("packaged builds ignore tenant overrides and refuse insecure Cloud URLs", () => {
  const env = { LOCAL_COGNITIVE_AUTH0_DOMAIN: "evil.example", LOCAL_COGNITIVE_CLOUD_URL: "http://127.0.0.1:9000" };
  assert.equal(resolveAccountConfig({ env, packaged: true }).authority, "https://dev-1r1wg4zfij4lam4r.eu.auth0.com");
  assert.equal(resolveAccountConfig({ env, packaged: false }).cloudUrl, "http://127.0.0.1:9000");
  assert.throws(() => resolveAccountConfig({ env: { LOCAL_COGNITIVE_CLOUD_URL: "http://cloud.example" }, packaged: false }));
  assert.equal(resolveAccountConfig({ env: {}, packaged: false }).issuer, "https://dev-1r1wg4zfij4lam4r.eu.auth0.com/");
});

test("account code cannot change integration ownership", () => {
  const directory = path.resolve(__dirname, "..", "..", "src", "account");
  for (const file of fs.readdirSync(directory)) assert.doesNotMatch(fs.readFileSync(path.join(directory, file), "utf8"), /RuntimeManager|switchIntegrationOwner/, file);
});
