import type { HostDatabase } from "../../runtime/db/HostDatabase";

export interface RemoteGrant {
  deviceId: string;
  accountId: string;
  deviceSpkiSha256: string;
  deviceName?: string;
  status: "active" | "revoked";
  invitationId?: string;
  receiptId: string;
  grantedAt: string;
  lastConnectedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  cloudSyncedAt?: string;
}
export type ClaimDenial = "invitation_unknown" | "invitation_used" | "invitation_expired" | "owner_mismatch";

const META = { hostId: "remote.host_id", owner: "remote.owner_account_id", revocationSeq: "remote.revocation_seq" } as const;
const toGrant = (row: Record<string, unknown>): RemoteGrant => ({
  deviceId: String(row.device_id), accountId: String(row.account_id), deviceSpkiSha256: String(row.device_spki_sha256),
  ...(row.device_name ? { deviceName: String(row.device_name) } : {}), status: row.status as RemoteGrant["status"],
  ...(row.invitation_id ? { invitationId: String(row.invitation_id) } : {}), receiptId: String(row.receipt_id), grantedAt: String(row.granted_at),
  ...(row.last_connected_at ? { lastConnectedAt: String(row.last_connected_at) } : {}), ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
  ...(row.revoked_by ? { revokedBy: String(row.revoked_by) } : {}), ...(row.cloud_synced_at ? { cloudSyncedAt: String(row.cloud_synced_at) } : {})
});

/** Durable Remote state of a host: its Cloud id, owner, invitations and device grants. */
export class RemoteHostStore {
  constructor(private readonly host: HostDatabase) {}

  hostId(): string | undefined { return this.host.meta(META.hostId); }
  setHostId(hostId: string): void { this.setMeta(META.hostId, hostId); }
  clearHostId(): void { this.host.db.prepare("DELETE FROM host_meta WHERE key = ?").run(META.hostId); }
  owner(): string | undefined { return this.host.meta(META.owner); }
  revocationSeq(): number { return Number(this.host.meta(META.revocationSeq) ?? 0); }

  createInvitation(invitationId: string, now: Date, expiresAt: Date): void {
    this.host.db.prepare("INSERT INTO remote_invitations(invitation_id, created_at, expires_at) VALUES (?, ?, ?)").run(invitationId, now.toISOString(), expiresAt.toISOString());
  }

  /** Whether a connection key was used, and by which computer (for `pair`). */
  invitation(invitationId: string): { consumed: boolean; deviceId?: string; deviceName?: string } | undefined {
    const row = this.host.db.prepare(`SELECT i.consumed_at, i.consumed_by_device_id, g.device_name FROM remote_invitations i
      LEFT JOIN remote_grants g ON g.device_id = i.consumed_by_device_id WHERE i.invitation_id = ?`).get(invitationId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { consumed: Boolean(row.consumed_at), ...(row.consumed_by_device_id ? { deviceId: String(row.consumed_by_device_id) } : {}),
      ...(row.device_name ? { deviceName: String(row.device_name) } : {}) };
  }

  /** Consumes the invitation and records the device grant in one transaction. The first claim
   * makes the account the owner; later claims must come from the same account. */
  claim(input: { invitationId: string; accountId: string; deviceId: string; deviceSpkiSha256: string; deviceName?: string; receiptId: string; now: Date }):
    { ok: true; grant: RemoteGrant } | { ok: false; code: ClaimDenial } {
    return this.host.transaction(db => {
      const invitation = db.prepare("SELECT expires_at, consumed_at FROM remote_invitations WHERE invitation_id = ?").get(input.invitationId);
      if (!invitation) return { ok: false, code: "invitation_unknown" } as const;
      if (invitation.consumed_at) return { ok: false, code: "invitation_used" } as const;
      if (Date.parse(String(invitation.expires_at)) <= input.now.getTime()) return { ok: false, code: "invitation_expired" } as const;
      const owner = this.owner();
      if (owner && owner !== input.accountId) return { ok: false, code: "owner_mismatch" } as const;
      const at = input.now.toISOString();
      if (!owner) db.prepare("INSERT INTO host_meta(key, value) VALUES (?, ?)").run(META.owner, input.accountId);
      db.prepare("UPDATE remote_invitations SET consumed_at = ?, consumed_by_device_id = ? WHERE invitation_id = ?").run(at, input.deviceId, input.invitationId);
      // Another device that held this key loses it; one device key, one active grant.
      db.prepare("UPDATE remote_grants SET status = 'revoked', revoked_at = ?, revoked_by = 'replaced' WHERE device_spki_sha256 = ? AND device_id <> ? AND status = 'active'")
        .run(at, input.deviceSpkiSha256, input.deviceId);
      db.prepare(`INSERT INTO remote_grants(device_id, account_id, device_spki_sha256, device_name, status, invitation_id, receipt_id, granted_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET account_id = excluded.account_id, device_spki_sha256 = excluded.device_spki_sha256, device_name = excluded.device_name,
          status = 'active', invitation_id = excluded.invitation_id, receipt_id = excluded.receipt_id, receipt_json = NULL, granted_at = excluded.granted_at,
          revoked_at = NULL, revoked_by = NULL, cloud_synced_at = NULL`)
        .run(input.deviceId, input.accountId, input.deviceSpkiSha256, input.deviceName ?? null, input.invitationId, input.receiptId, at);
      return { ok: true, grant: toGrant(db.prepare("SELECT * FROM remote_grants WHERE device_id = ?").get(input.deviceId)!) } as const;
    });
  }

  activeGrant(deviceId: string): RemoteGrant | undefined {
    const row = this.host.db.prepare("SELECT * FROM remote_grants WHERE device_id = ? AND status = 'active'").get(deviceId);
    return row ? toGrant(row) : undefined;
  }
  grants(): RemoteGrant[] { return this.host.db.prepare("SELECT * FROM remote_grants ORDER BY granted_at").all().map(toGrant); }
  touch(deviceId: string, now: Date): void { this.host.db.prepare("UPDATE remote_grants SET last_connected_at = ? WHERE device_id = ?").run(now.toISOString(), deviceId); }

  /** A revocation made on the host waits for the Cloud (cloud_synced_at) like a claim does. */
  revoke(deviceId: string, by: string, now: Date): boolean {
    return Number(this.host.db.prepare("UPDATE remote_grants SET status = 'revoked', revoked_at = ?, revoked_by = ?, cloud_synced_at = NULL WHERE device_id = ? AND status = 'active'")
      .run(now.toISOString(), by, deviceId).changes) > 0;
  }
  /** Host-side revocations the Cloud has not confirmed yet. */
  unsyncedRevocations(): RemoteGrant[] {
    return this.host.db.prepare("SELECT * FROM remote_grants WHERE status = 'revoked' AND revoked_by = 'host' AND cloud_synced_at IS NULL").all().map(toGrant);
  }
  markRevocationSynced(deviceId: string, now: Date): void {
    this.host.db.prepare("UPDATE remote_grants SET cloud_synced_at = ? WHERE device_id = ? AND status = 'revoked'").run(now.toISOString(), deviceId);
  }
  saveReceipt(receiptId: string, receipt: object): void {
    this.host.db.prepare("UPDATE remote_grants SET receipt_json = ? WHERE receipt_id = ?").run(JSON.stringify(receipt), receiptId);
  }
  receipt(receiptId: string): object | undefined {
    const row = this.host.db.prepare("SELECT receipt_json FROM remote_grants WHERE receipt_id = ?").get(receiptId);
    return row?.receipt_json ? JSON.parse(String(row.receipt_json)) as object : undefined;
  }
  grantByReceipt(receiptId: string): RemoteGrant | undefined {
    const row = this.host.db.prepare("SELECT * FROM remote_grants WHERE receipt_id = ?").get(receiptId);
    return row ? toGrant(row) : undefined;
  }
  /** Unlinking the host: every grant is revoked and the owner removed; local data stays. */
  unlink(by: string, now: Date): void {
    this.host.transaction(db => {
      db.prepare("UPDATE remote_grants SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE status = 'active'").run(now.toISOString(), by);
      db.prepare("DELETE FROM host_meta WHERE key = ?").run(META.owner);
    });
  }

  /** Applies a Cloud revocation once: sequence numbers at or below the last applied are ignored. */
  applyRevocation(revocation: { seq: number; kind: "device" | "host"; deviceId?: string }, now: Date): boolean {
    return this.host.transaction(db => {
      if (revocation.seq <= this.revocationSeq()) return false;
      if (revocation.kind === "host") {
        db.prepare("UPDATE remote_grants SET status = 'revoked', revoked_at = ?, revoked_by = 'cloud' WHERE status = 'active'").run(now.toISOString());
        db.prepare("DELETE FROM host_meta WHERE key = ?").run(META.owner);
      } else if (revocation.deviceId) {
        db.prepare("UPDATE remote_grants SET status = 'revoked', revoked_at = ?, revoked_by = 'cloud' WHERE device_id = ? AND status = 'active'").run(now.toISOString(), revocation.deviceId);
        // The Cloud now knows about a revocation made here.
        db.prepare("UPDATE remote_grants SET cloud_synced_at = ? WHERE device_id = ? AND status = 'revoked'").run(now.toISOString(), revocation.deviceId);
      }
      db.prepare("INSERT INTO host_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(META.revocationSeq, String(revocation.seq));
      return true;
    });
  }

  /** Grants the Cloud has not acknowledged yet: their claim receipts are sent again after reconnecting. */
  unsynced(): RemoteGrant[] {
    return this.host.db.prepare("SELECT * FROM remote_grants WHERE status = 'active' AND cloud_synced_at IS NULL ORDER BY granted_at").all().map(toGrant);
  }
  markSynced(receiptId: string, now: Date): void {
    this.host.db.prepare("UPDATE remote_grants SET cloud_synced_at = ? WHERE receipt_id = ?").run(now.toISOString(), receiptId);
  }

  private setMeta(key: string, value: string): void {
    this.host.db.prepare("INSERT INTO host_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
