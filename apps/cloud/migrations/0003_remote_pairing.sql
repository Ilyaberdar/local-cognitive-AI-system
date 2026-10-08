-- Remote (spec §6, §13): hosts behind NAT, trusted devices, one-time connection tickets and
-- revocations. The relay sees routing metadata only; device<->host traffic is end-to-end TLS.

CREATE TABLE hosts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signing_public_key bytea NOT NULL UNIQUE CHECK (octet_length(signing_public_key) = 32),
  tls_spki_sha256 bytea NOT NULL CHECK (octet_length(tls_spki_sha256) = 32),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  app_version text NOT NULL CHECK (char_length(app_version) <= 64),
  protocol_version integer NOT NULL,
  owner_account_id uuid REFERENCES accounts (id) ON DELETE SET NULL,
  revocation_seq bigint NOT NULL DEFAULT 0,
  registered_ip inet,
  blocked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  last_seen_at timestamptz
);
CREATE INDEX hosts_owner_account_id_idx ON hosts (owner_account_id);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  tls_spki_sha256 bytea NOT NULL CHECK (octet_length(tls_spki_sha256) = 32),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  platform text NOT NULL CHECK (platform IN ('macos', 'windows', 'linux', 'ios', 'android')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_account_key UNIQUE (account_id, tls_spki_sha256)
);

-- Announced by the host when it prints a key; the secret never leaves the host.
CREATE TABLE host_invitations (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  tickets_issued integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX host_invitations_host_id_idx ON host_invitations (host_id);

CREATE TABLE device_grants (
  host_id uuid NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  receipt_id uuid NOT NULL UNIQUE,
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  PRIMARY KEY (host_id, device_id)
);
CREATE INDEX device_grants_account_id_idx ON device_grants (account_id);

-- Only the SHA-256 of a ticket is stored; a ticket is consumed once by the relay.
CREATE TABLE connection_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  host_id uuid NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('pair', 'connect')),
  invitation_id uuid REFERENCES host_invitations (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  auth_expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((purpose = 'pair') = (invitation_id IS NOT NULL))
);
CREATE INDEX connection_tickets_expires_at_idx ON connection_tickets (expires_at);

-- Signed by the host after it committed a grant; idempotent by id.
CREATE TABLE claim_receipts (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL UNIQUE,
  ticket_id uuid NOT NULL UNIQUE,
  payload bytea NOT NULL,
  signature bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Delivered to the host in order; a host offline at revocation time gets them on reconnect.
CREATE TABLE revocations (
  host_id uuid NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('device', 'host')),
  device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, seq)
);

-- No secrets, tickets or message content.
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  account_id uuid,
  host_id uuid,
  device_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_host_id_idx ON audit_events (host_id, created_at);
