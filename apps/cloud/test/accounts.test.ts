import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccountRepository } from "../src/accounts/accountRepository.js";
import { migrate } from "../src/db/migrate.js";
import { MIGRATIONS_DIR } from "../src/paths.js";
import { createTestDatabase, databaseSkip } from "./helpers/testDatabase.js";

const identity = (subject: string, email = "same@example.com") => ({ issuer: "https://tenant/", subject, email, emailVerified: true, displayName: null });

test("identities map to one account, are updated in place and never merged by email", { skip: databaseSkip }, async (t) => {
  const pool = await createTestDatabase(t);
  await migrate(pool, MIGRATIONS_DIR);
  const accounts = createAccountRepository(pool);
  const first = await accounts.upsertIdentity(identity("google-oauth2|1"));
  assert.equal(first.created, true);
  const again = await accounts.upsertIdentity({ ...identity("google-oauth2|1", "new@example.com"), displayName: "Mira" });
  assert.deepEqual(again, { accountId: first.accountId, created: false });
  const record = await accounts.loadAccount(first.accountId, "https://tenant/", "google-oauth2|1");
  assert.equal(record?.identities[0]?.email, "new@example.com");
  assert.equal(record?.identities[0]?.displayName, "Mira");
  assert.equal(record?.identities[0]?.current, true);
  const other = await accounts.upsertIdentity(identity("auth0|2"));
  assert.notEqual(other.accountId, first.accountId);
  const otherIssuer = await accounts.upsertIdentity({ ...identity("google-oauth2|1"), issuer: "https://other/" });
  assert.notEqual(otherIssuer.accountId, first.accountId);
});

test("parallel first logins create exactly one account", { skip: databaseSkip }, async (t) => {
  const pool = await createTestDatabase(t);
  await migrate(pool, MIGRATIONS_DIR);
  const accounts = createAccountRepository(pool);
  const results = await Promise.all(Array.from({ length: 10 }, () => accounts.upsertIdentity(identity("auth0|race"))));
  assert.equal(new Set(results.map((result) => result.accountId)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM accounts")).rows[0].n, 1);
  const record = await accounts.loadAccount(results[0]!.accountId, "https://tenant/", "auth0|race");
  assert.equal(record?.status, "active");
});
