import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

export type Purpose = "pair" | "connect";
export interface HostRecord { id: string; signingPublicKey: Buffer; tlsSpkiSha256: Buffer; name: string; appVersion: string; ownerAccountId: string | null;
  revocationSeq: number; blocked: boolean; claimedAt: Date | null; lastSeenAt: Date | null }
export interface ConsumedTicket { ticketId: string; accountId: string; deviceId: string; hostId: string; purpose: Purpose; invitationId: string | null;
  authExpiresAt: Date; deviceSpkiSha256: Buffer; deviceName: string }
export interface Revocation { seq: number; kind: "device" | "host"; deviceId: string | null }
export interface ClaimReceipt { receiptId: string; hostId: string; invitationId: string; ticketId: string; accountId: string; deviceId: string; deviceSpkiSha256: string; grantedAt: string }
export type TicketDenial = "device_unknown" | "host_unknown" | "invitation_unknown" | "invitation_used" | "invitation_expired" | "invitation_exhausted"
  | "host_owned_by_other" | "not_authorized";

export const TICKETS_PER_INVITATION = 10;
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest();

interface HostRow { id: string; signing_public_key: Buffer; tls_spki_sha256: Buffer; name: string; app_version: string; owner_account_id: string | null;
  revocation_seq: string; blocked_at: Date | null; claimed_at: Date | null; last_seen_at: Date | null }
const toHost = (row: HostRow): HostRecord => ({ id: row.id, signingPublicKey: row.signing_public_key, tlsSpkiSha256: row.tls_spki_sha256, name: row.name,
  appVersion: row.app_version, ownerAccountId: row.owner_account_id, revocationSeq: Number(row.revocation_seq), blocked: row.blocked_at !== null,
  claimedAt: row.claimed_at, lastSeenAt: row.last_seen_at });

const transaction = async <T>(pool: pg.Pool, body: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
};

/** Appends a revocation and bumps the host's sequence in the caller's transaction. */
const addRevocation = async (client: pg.PoolClient, hostId: string, kind: "device" | "host", deviceId: string | null): Promise<Revocation> => {
  const { rows } = await client.query<{ revocation_seq: string }>("UPDATE hosts SET revocation_seq = revocation_seq + 1 WHERE id = $1 RETURNING revocation_seq", [hostId]);
  const seq = Number(rows[0]!.revocation_seq);
  await client.query("INSERT INTO revocations (host_id, seq, kind, device_id) VALUES ($1, $2, $3, $4)", [hostId, seq, kind, deviceId]);
  return { seq, kind, deviceId };
};

export type RemoteRepository = ReturnType<typeof createRemoteRepository>;

export const createRemoteRepository = (pool: pg.Pool) => ({
  /** Idempotent by signing key: a host re-registering keeps its id. */
  async registerHost(input: { signingPublicKey: Buffer; tlsSpkiSha256: Buffer; name: string; appVersion: string; protocol: number; ip: string | null }) {
    const { rows } = await pool.query<{ id: string; created: boolean }>(`
      INSERT INTO hosts (signing_public_key, tls_spki_sha256, name, app_version, protocol_version, registered_ip) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (signing_public_key) DO UPDATE SET tls_spki_sha256 = EXCLUDED.tls_spki_sha256, name = EXCLUDED.name,
        app_version = EXCLUDED.app_version, protocol_version = EXCLUDED.protocol_version
      RETURNING id, (xmax = 0) AS created`,
      [input.signingPublicKey, input.tlsSpkiSha256, input.name, input.appVersion, input.protocol, input.ip]);
    return { hostId: rows[0]!.id, created: rows[0]!.created };
  },

  async host(id: string): Promise<HostRecord | undefined> {
    const { rows } = await pool.query<HostRow>("SELECT * FROM hosts WHERE id = $1", [id]);
    return rows[0] ? toHost(rows[0]) : undefined;
  },

  async touchHost(id: string, appVersion?: string): Promise<void> {
    await pool.query("UPDATE hosts SET last_seen_at = now(), app_version = coalesce($2, app_version) WHERE id = $1", [id, appVersion ?? null]);
  },

  async announceInvitation(hostId: string, invitationId: string, expiresAt: Date): Promise<boolean> {
    const { rowCount } = await pool.query("INSERT INTO host_invitations (id, host_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
      [invitationId, hostId, expiresAt]);
    return rowCount === 1;
  },

  async upsertDevice(accountId: string, spki: Buffer, name: string, platform: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(`
      INSERT INTO devices (account_id, tls_spki_sha256, name, platform) VALUES ($1, $2, $3, $4)
      ON CONFLICT (account_id, tls_spki_sha256) DO UPDATE SET name = EXCLUDED.name, platform = EXCLUDED.platform, last_seen_at = now()
      RETURNING id`, [accountId, spki, name, platform]);
    return rows[0]!.id;
  },

  /** Hosts the account owns, with the devices that were granted access to each. */
  async hostsFor(accountId: string) {
    const hosts = await pool.query<HostRow>("SELECT * FROM hosts WHERE owner_account_id = $1 ORDER BY claimed_at, id", [accountId]);
    const grants = await pool.query<{ host_id: string; device_id: string; name: string; platform: string; status: string; granted_at: Date; revoked_at: Date | null }>(`
      SELECT g.host_id, g.device_id, d.name, d.platform, g.status, g.granted_at, g.revoked_at
      FROM device_grants g JOIN devices d ON d.id = g.device_id
      WHERE g.account_id = $1 AND g.host_id = ANY($2::uuid[]) ORDER BY g.granted_at`, [accountId, hosts.rows.map(row => row.id)]);
    return hosts.rows.map(row => ({ ...toHost(row), devices: grants.rows.filter(grant => grant.host_id === row.id) }));
  },

  /** A one-time ticket for one relay connection. Pairing tickets need a live invitation of an
   * unclaimed host or one owned by the account; connect tickets need an active grant. */
  async issueTicket(input: { accountId: string; deviceId: string; hostId: string; purpose: Purpose; invitationId?: string; ttlMs: number; authTtlMs: number }):
    Promise<{ ok: true; ticketId: string; token: Buffer; expiresAt: Date; authExpiresAt: Date } | { ok: false; code: TicketDenial }> {
    return transaction(pool, async client => {
      const device = await client.query("SELECT 1 FROM devices WHERE id = $1 AND account_id = $2", [input.deviceId, input.accountId]);
      if (!device.rowCount) return { ok: false, code: "device_unknown" } as const;
      const host = await client.query<HostRow>("SELECT * FROM hosts WHERE id = $1 AND blocked_at IS NULL FOR SHARE", [input.hostId]);
      if (!host.rows[0]) return { ok: false, code: "host_unknown" } as const;
      const owner = host.rows[0].owner_account_id;
      if (input.purpose === "pair") {
        if (owner && owner !== input.accountId) return { ok: false, code: "host_owned_by_other" } as const;
        const invitation = await client.query<{ expires_at: Date; consumed_at: Date | null; tickets_issued: number }>(
          "SELECT expires_at, consumed_at, tickets_issued FROM host_invitations WHERE id = $1 AND host_id = $2 FOR UPDATE", [input.invitationId, input.hostId]);
        const row = invitation.rows[0];
        if (!row) return { ok: false, code: "invitation_unknown" } as const;
        if (row.consumed_at) return { ok: false, code: "invitation_used" } as const;
        if (row.expires_at.getTime() <= Date.now()) return { ok: false, code: "invitation_expired" } as const;
        if (row.tickets_issued >= TICKETS_PER_INVITATION) return { ok: false, code: "invitation_exhausted" } as const;
        await client.query("UPDATE host_invitations SET tickets_issued = tickets_issued + 1 WHERE id = $1", [input.invitationId]);
      } else {
        const grant = await client.query("SELECT 1 FROM device_grants WHERE host_id = $1 AND device_id = $2 AND account_id = $3 AND status = 'active'",
          [input.hostId, input.deviceId, input.accountId]);
        if (owner !== input.accountId || !grant.rowCount) return { ok: false, code: "not_authorized" } as const;
      }
      const token = randomBytes(32), now = Date.now();
      const expiresAt = new Date(now + input.ttlMs), authExpiresAt = new Date(now + input.authTtlMs);
      const { rows } = await client.query<{ id: string }>(`
        INSERT INTO connection_tickets (token_sha256, account_id, device_id, host_id, purpose, invitation_id, expires_at, auth_expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [sha256(token), input.accountId, input.deviceId, input.hostId, input.purpose, input.purpose === "pair" ? input.invitationId : null, expiresAt, authExpiresAt]);
      return { ok: true, ticketId: rows[0]!.id, token, expiresAt, authExpiresAt } as const;
    });
  },

  /** Consumes a ticket once; connect tickets are checked against the grant again. */
  async consumeTicket(token: Buffer): Promise<ConsumedTicket | undefined> {
    const { rows } = await pool.query<{ id: string; account_id: string; device_id: string; host_id: string; purpose: Purpose; invitation_id: string | null;
      auth_expires_at: Date; tls_spki_sha256: Buffer; name: string; allowed: boolean }>(`
      WITH consumed AS (
        UPDATE connection_tickets SET consumed_at = now()
        WHERE token_sha256 = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING id, account_id, device_id, host_id, purpose, invitation_id, auth_expires_at
      )
      SELECT c.*, d.tls_spki_sha256, d.name,
        (c.purpose = 'pair' OR EXISTS (SELECT 1 FROM device_grants g JOIN hosts h ON h.id = g.host_id
          WHERE g.host_id = c.host_id AND g.device_id = c.device_id AND g.status = 'active' AND h.owner_account_id = c.account_id)) AS allowed
      FROM consumed c JOIN devices d ON d.id = c.device_id`, [sha256(token)]);
    const row = rows[0];
    if (!row || !row.allowed) return undefined;
    return { ticketId: row.id, accountId: row.account_id, deviceId: row.device_id, hostId: row.host_id, purpose: row.purpose, invitationId: row.invitation_id,
      authExpiresAt: row.auth_expires_at, deviceSpkiSha256: row.tls_spki_sha256, deviceName: row.name };
  },

  /** Records a host-signed claim. Every field must match the consumed pairing ticket.
   * Idempotent: the same receipt again is acknowledged without changes. */
  async recordClaim(receipt: ClaimReceipt, payload: Buffer, signature: Buffer): Promise<"recorded" | "duplicate" | "ticket_mismatch" | "host_owned_by_other"> {
    return transaction(pool, async client => {
      const existing = await client.query("SELECT 1 FROM claim_receipts WHERE id = $1", [receipt.receiptId]);
      if (existing.rowCount) return "duplicate";
      const ticket = await client.query<{ device_spki: Buffer }>(`
        SELECT d.tls_spki_sha256 AS device_spki FROM connection_tickets t JOIN devices d ON d.id = t.device_id
        WHERE t.id = $1 AND t.consumed_at IS NOT NULL AND t.purpose = 'pair' AND t.host_id = $2 AND t.account_id = $3 AND t.device_id = $4
          AND t.invitation_id = $5 FOR UPDATE OF t`,
        [receipt.ticketId, receipt.hostId, receipt.accountId, receipt.deviceId, receipt.invitationId]);
      if (!ticket.rows[0] || ticket.rows[0].device_spki.toString("hex") !== receipt.deviceSpkiSha256) return "ticket_mismatch";
      const host = await client.query<{ owner_account_id: string | null }>("SELECT owner_account_id FROM hosts WHERE id = $1 FOR UPDATE", [receipt.hostId]);
      const owner = host.rows[0]?.owner_account_id;
      if (owner && owner !== receipt.accountId) return "host_owned_by_other";
      if (!owner) await client.query("UPDATE hosts SET owner_account_id = $2, claimed_at = now() WHERE id = $1", [receipt.hostId, receipt.accountId]);
      await client.query("UPDATE host_invitations SET consumed_at = coalesce(consumed_at, now()) WHERE id = $1", [receipt.invitationId]);
      await client.query(`
        INSERT INTO device_grants (host_id, device_id, account_id, status, receipt_id, granted_at) VALUES ($1, $2, $3, 'active', $4, $5)
        ON CONFLICT (host_id, device_id) DO UPDATE SET account_id = EXCLUDED.account_id, status = 'active', receipt_id = EXCLUDED.receipt_id,
          granted_at = EXCLUDED.granted_at, revoked_at = NULL, revoked_by = NULL`,
        [receipt.hostId, receipt.deviceId, receipt.accountId, receipt.receiptId, new Date(receipt.grantedAt)]);
      await client.query(`INSERT INTO claim_receipts (id, host_id, device_id, account_id, invitation_id, ticket_id, payload, signature)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [receipt.receiptId, receipt.hostId, receipt.deviceId, receipt.accountId, receipt.invitationId, receipt.ticketId, payload, signature]);
      await client.query("INSERT INTO audit_events (kind, account_id, host_id, device_id) VALUES ('device_paired', $1, $2, $3)", [receipt.accountId, receipt.hostId, receipt.deviceId]);
      return "recorded";
    });
  },

  /** Revokes one device's grant. `accountId` null means the host itself asked (signed). */
  async revokeDevice(hostId: string, deviceId: string, accountId: string | null, by: string): Promise<Revocation | undefined> {
    return transaction(pool, async client => {
      const host = await client.query<{ owner_account_id: string | null }>("SELECT owner_account_id FROM hosts WHERE id = $1 FOR UPDATE", [hostId]);
      if (!host.rows[0] || (accountId !== null && host.rows[0].owner_account_id !== accountId)) return undefined;
      const changed = await client.query("UPDATE device_grants SET status = 'revoked', revoked_at = now(), revoked_by = $3 WHERE host_id = $1 AND device_id = $2 AND status = 'active'",
        [hostId, deviceId, by]);
      if (!changed.rowCount) return undefined;
      await client.query("INSERT INTO audit_events (kind, account_id, host_id, device_id, detail) VALUES ('device_revoked', $1, $2, $3, $4)",
        [host.rows[0].owner_account_id, hostId, deviceId, { by }]);
      return addRevocation(client, hostId, "device", deviceId);
    });
  },

  /** Unlinks a host from its owner: every grant is revoked and the host can be claimed again. */
  async unlinkHost(hostId: string, accountId: string | null, by: string): Promise<Revocation | undefined> {
    return transaction(pool, async client => {
      const host = await client.query<{ owner_account_id: string | null }>("SELECT owner_account_id FROM hosts WHERE id = $1 FOR UPDATE", [hostId]);
      if (!host.rows[0] || (accountId !== null && host.rows[0].owner_account_id !== accountId)) return undefined;
      await client.query("UPDATE device_grants SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE host_id = $1 AND status = 'active'", [hostId, by]);
      await client.query("UPDATE hosts SET owner_account_id = NULL, claimed_at = NULL WHERE id = $1", [hostId]);
      await client.query("INSERT INTO audit_events (kind, account_id, host_id, detail) VALUES ('host_unlinked', $1, $2, $3)", [host.rows[0].owner_account_id, hostId, { by }]);
      return addRevocation(client, hostId, "host", null);
    });
  },

  async revocationsAfter(hostId: string, seq: number): Promise<Revocation[]> {
    const { rows } = await pool.query<{ seq: string; kind: "device" | "host"; device_id: string | null }>(
      "SELECT seq, kind, device_id FROM revocations WHERE host_id = $1 AND seq > $2 ORDER BY seq", [hostId, seq]);
    return rows.map(row => ({ seq: Number(row.seq), kind: row.kind, deviceId: row.device_id }));
  },

  async audit(kind: string, fields: { accountId?: string; hostId?: string; deviceId?: string; detail?: Record<string, unknown> }): Promise<void> {
    await pool.query("INSERT INTO audit_events (kind, account_id, host_id, device_id, detail) VALUES ($1, $2, $3, $4, $5)",
      [kind, fields.accountId ?? null, fields.hostId ?? null, fields.deviceId ?? null, fields.detail ?? {}]);
  }
});
