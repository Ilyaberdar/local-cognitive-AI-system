import assert from "node:assert/strict";
import { test } from "node:test";
import { toMeResponse, providerFromSubject } from "../src/accounts/meResponse.js";
import { extractProfileClaims, isUserToken, PROFILE_CLAIM_NAMESPACE as ns } from "../src/auth/profileClaims.js";

test("only namespaced profile claims are trusted and verification fails closed", () => {
  assert.deepEqual(extractProfileClaims({ [`${ns}email`]: " a@b.test ", [`${ns}email_verified`]: true, [`${ns}name`]: "  Mira\u0007 " }),
    { email: "a@b.test", emailVerified: true, displayName: "Mira" });
  assert.deepEqual(extractProfileClaims({ email: "plain@b.test", email_verified: true }), { email: null, emailVerified: false, displayName: null });
  assert.equal(extractProfileClaims({ [`${ns}email`]: "a@b.test", [`${ns}email_verified`]: "true" }).emailVerified, false);
  assert.equal(extractProfileClaims({ [`${ns}email_verified`]: true }).emailVerified, false, "verified without an email");
  assert.equal(extractProfileClaims({ [`${ns}email`]: "not-an-email" }).email, null);
  assert.equal(extractProfileClaims({ [`${ns}name`]: "x".repeat(300) }).displayName?.length, 200);
});

test("providers come from the subject prefix and machine tokens are not user tokens", () => {
  assert.deepEqual(["google-oauth2|1", "auth0|2", "apple|3", "github|4", "plain"].map(providerFromSubject), ["google", "email", "apple", "other", "other"]);
  const identity = (subject: string, claims: Record<string, unknown> = {}) => ({ issuer: "https://i/", subject, claims });
  assert.equal(isUserToken(identity("auth0|1")), true);
  assert.equal(isUserToken(identity("abc@clients")), false);
  assert.equal(isUserToken(identity("auth0|1", { gty: "client-credentials" })), false);
});

test("the me response exposes no issuer, subject or row ids", () => {
  const linkedAt = new Date("2026-10-08T10:00:00Z");
  const response = toMeResponse({ id: "acc-1", status: "active", createdAt: linkedAt, identities: [
    { subject: "google-oauth2|secret-subject", email: "a@b.test", emailVerified: true, displayName: "Mira", linkedAt, current: true }] });
  assert.deepEqual(response, { accountId: "acc-1", status: "active", createdAt: "2026-10-08T10:00:00.000Z", email: "a@b.test", emailVerified: true,
    displayName: "Mira", identities: [{ provider: "google", email: "a@b.test", emailVerified: true, linkedAt: "2026-10-08T10:00:00.000Z", current: true }] });
  assert.equal(JSON.stringify(response).includes("secret-subject"), false);
});
