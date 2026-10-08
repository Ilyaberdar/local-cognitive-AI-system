import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import pg from "pg";

const adminUrl = process.env.CLOUD_TEST_DATABASE_URL;
/** Database tests are skipped without CLOUD_TEST_DATABASE_URL; CI sets CLOUD_TEST_REQUIRE_DB=1 to fail instead. */
export const databaseSkip = adminUrl ? false : process.env.CLOUD_TEST_REQUIRE_DB === "1"
  ? (() => { throw new Error("CLOUD_TEST_DATABASE_URL is required"); })()
  : "set CLOUD_TEST_DATABASE_URL to run database tests";

/** A throwaway database per test file: node --test runs files in parallel. */
export const createTestDatabase = async (t: TestContext): Promise<pg.Pool> => {
  const name = `lc_cloud_test_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  pool.on("error", () => { /* Connections closing during teardown. */ });
  t.after(async () => {
    await pool.end();
    // Wait for closed sessions to leave the server; forcing earlier would signal a
    // connection that is still shutting down and surface as an uncaught error.
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`DROP DATABASE IF EXISTS ${name}`); break; }
      catch (error) {
        if ((error as { code?: string }).code !== "55006" || attempt >= 40) { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await admin.end();
  });
  return pool;
};
