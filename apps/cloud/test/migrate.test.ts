import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "../src/db/migrate.js";
import { MIGRATIONS_DIR } from "../src/paths.js";
import { createTestDatabase, databaseSkip } from "./helpers/testDatabase.js";

test("migrations apply once, including concurrent runs", { skip: databaseSkip }, async (t) => {
  const pool = await createTestDatabase(t);
  const [first, second] = await Promise.all([migrate(pool, MIGRATIONS_DIR), migrate(pool, MIGRATIONS_DIR)]);
  assert.deepEqual([...first, ...second], ["0001_accounts_identity_links.sql", "0002_identity_display_name.sql", "0003_remote_pairing.sql"]);
  assert.deepEqual(await migrate(pool, MIGRATIONS_DIR), []);
});

test("edited or unknown migrations are refused", { skip: databaseSkip }, async (t) => {
  const pool = await createTestDatabase(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-migrations-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "0001_first.sql"), "CREATE TABLE first_table (id int);");
  await migrate(pool, directory);
  await fs.writeFile(path.join(directory, "0001_first.sql"), "CREATE TABLE first_table (id bigint);");
  await assert.rejects(migrate(pool, directory), /was modified after being applied/);
  await pool.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ('0999', '0999_future.sql', 'x')");
  await assert.rejects(migrate(pool, MIGRATIONS_DIR), /unknown migration 0999/);
});

test("identity links are unique per issuer and subject, never merged by email", { skip: databaseSkip }, async (t) => {
  const pool = await createTestDatabase(t);
  await migrate(pool, MIGRATIONS_DIR);
  const account = async () => (await pool.query<{ id: string }>("INSERT INTO accounts DEFAULT VALUES RETURNING id")).rows[0]!.id;
  const link = (accountId: string, subject: string) => pool.query(
    "INSERT INTO identity_links (account_id, issuer, subject, email) VALUES ($1, 'https://tenant/', $2, 'same@example.com')", [accountId, subject]);
  const a = await account(), b = await account();
  await link(a, "google-oauth2|1");
  await link(b, "auth0|2");
  await assert.rejects(link(b, "google-oauth2|1"), (error: { code?: string; constraint?: string }) =>
    error.code === "23505" && error.constraint === "identity_links_issuer_subject_key");
  await pool.query("DELETE FROM accounts WHERE id = $1", [a]);
  assert.equal((await pool.query("SELECT 1 FROM identity_links WHERE account_id = $1", [a])).rowCount, 0);
});
