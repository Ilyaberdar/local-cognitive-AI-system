import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AccountRecord } from "./meResponse.js";

export interface IdentityInput { issuer: string; subject: string; email: string | null; emailVerified: boolean; displayName: string | null }

export interface AccountRepository {
  upsertIdentity(input: IdentityInput): Promise<{ accountId: string; created: boolean }>;
  loadAccount(accountId: string, issuer: string, subject: string): Promise<AccountRecord | undefined>;
}

// The unique (issuer, subject) index decides a first-login race: the loser waits, takes
// DO UPDATE and gets the winner's account id, so it never creates an account. FK checks
// run at the end of the statement, so the link may reference the account inserted after it.
const upsertSql = `
WITH link AS (
  INSERT INTO identity_links AS l (account_id, issuer, subject, email, email_verified, display_name)
  VALUES ($1::uuid, $2, $3, $4, $5, $6)
  ON CONFLICT (issuer, subject) DO UPDATE
    SET email = EXCLUDED.email, email_verified = EXCLUDED.email_verified,
        display_name = EXCLUDED.display_name, last_seen_at = now()
  RETURNING l.account_id
), created AS (
  INSERT INTO accounts (id) SELECT account_id FROM link WHERE account_id = $1::uuid RETURNING id
)
SELECT link.account_id, (created.id IS NOT NULL) AS created FROM link LEFT JOIN created ON true`;

// A separate statement: joined into the upsert, its snapshot would predate the winner's commit.
const loadSql = `
SELECT a.id, a.status, a.created_at, l.subject, l.email, l.email_verified, l.display_name,
       l.created_at AS linked_at, (l.issuer = $2 AND l.subject = $3) AS current
FROM accounts a JOIN identity_links l ON l.account_id = a.id
WHERE a.id = $1 ORDER BY l.created_at, l.id`;

interface LoadRow { id: string; status: AccountRecord["status"]; created_at: Date; subject: string; email: string | null;
  email_verified: boolean; display_name: string | null; linked_at: Date; current: boolean }

export const createAccountRepository = (pool: Pick<pg.Pool, "query">): AccountRepository => ({
  async upsertIdentity(input) {
    const { rows } = await pool.query<{ account_id: string; created: boolean }>(upsertSql,
      [randomUUID(), input.issuer, input.subject, input.email, input.emailVerified, input.displayName]);
    const row = rows[0];
    if (!row) throw new Error("Identity upsert returned no row");
    return { accountId: row.account_id, created: row.created };
  },
  async loadAccount(accountId, issuer, subject) {
    const { rows } = await pool.query<LoadRow>(loadSql, [accountId, issuer, subject]);
    const first = rows[0];
    if (!first) return undefined;
    return { id: first.id, status: first.status, createdAt: first.created_at, identities: rows.map((row) => ({
      subject: row.subject, email: row.email, emailVerified: row.email_verified, displayName: row.display_name,
      linkedAt: row.linked_at, current: row.current })) };
  }
});
