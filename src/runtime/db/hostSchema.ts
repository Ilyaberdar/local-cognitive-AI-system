import { randomBytes, randomUUID } from "node:crypto";
import type { Migration } from "./HostDatabase";

/** Append-only once released: a shipped migration is never edited, only followed by a new one.
 * Durable runtime state for Remote (spec §7, §10, §13); consumers arrive in R4 and R6. */
export const hostMigrations: readonly Migration[] = [{
  version: 1, name: "runtime_core",
  up(db) {
    db.exec(`
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
CREATE TABLE host_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE commands(
  command_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  target TEXT,
  payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('accepted','running','completed','failed','rejected','interrupted')),
  run_id TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  accepted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope, idempotency_key)
) STRICT;
CREATE TABLE runs(
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  session_id TEXT,
  command_id TEXT REFERENCES commands(command_id),
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','completed','failed','cancelled','interrupted','needs_review')),
  revision INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;
CREATE INDEX runs_session ON runs(session_id, created_at);
CREATE UNIQUE INDEX runs_one_active_chat_turn ON runs(session_id) WHERE kind = 'chat' AND status IN ('queued','running','waiting_approval');
CREATE TABLE messages(
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT REFERENCES runs(run_id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  status TEXT NOT NULL CHECK (status IN ('accepted','streaming','completed','failed','interrupted')),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX messages_session ON messages(session_id, created_at, message_id);
CREATE TABLE event_streams(
  stream_id TEXT PRIMARY KEY,
  journal_epoch TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  first_retained_sequence INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE TABLE events(
  stream_id TEXT NOT NULL REFERENCES event_streams(stream_id),
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  entity_id TEXT,
  run_id TEXT,
  revision INTEGER,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY(stream_id, sequence)
) STRICT, WITHOUT ROWID;
CREATE TABLE usage_events(
  event_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  run_id TEXT,
  session_id TEXT,
  occurred_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
) STRICT;
CREATE TABLE usage_outbox(
  event_id TEXT PRIMARY KEY REFERENCES usage_events(event_id),
  state TEXT NOT NULL CHECK (state IN ('pending','sent','acked','local_only')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  acked_at TEXT,
  last_error TEXT
) STRICT;
CREATE INDEX usage_outbox_pending ON usage_outbox(state, next_attempt_at);
`);
    // Cursors carry the epoch; a restored or recreated database gets a new one, so stale cursors resync.
    db.prepare("INSERT INTO host_meta(key, value) VALUES ('journal_epoch', ?)").run(randomUUID());
  }
}, {
  // Remote pairing (spec §6): invitation secrets stay in daemon memory; only ids and expiry are stored.
  version: 2, name: "remote_pairing",
  up(db) {
    db.exec(`
CREATE TABLE remote_invitations(
  invitation_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_device_id TEXT
) STRICT;
CREATE TABLE remote_grants(
  device_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_spki_sha256 TEXT NOT NULL,
  device_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  invitation_id TEXT,
  receipt_id TEXT NOT NULL UNIQUE,
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  granted_at TEXT NOT NULL,
  last_connected_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  cloud_synced_at TEXT
) STRICT;
CREATE UNIQUE INDEX remote_grants_active_device_key ON remote_grants(device_spki_sha256) WHERE status = 'active';
`);
  }
}, {
  // The usage ledger (spec §10): one row per request to a model, its tokens as counts (NULL when
  // the provider reported none), the account it ran for and its delivery to the Cloud. The v1
  // tables were never written; they are replaced.
  version: 3, name: "usage_ledger",
  up(db) {
    db.exec(`
DROP TABLE IF EXISTS usage_outbox;
DROP TABLE IF EXISTS usage_events;
CREATE TABLE usage_events(
  event_id TEXT PRIMARY KEY,
  execution_host_id TEXT NOT NULL,
  account_id TEXT,
  call_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  run_ref TEXT,
  session_ref TEXT,
  origin TEXT,
  purpose TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed','rejected','failed','cancelled')),
  http_status INTEGER,
  usage_source TEXT NOT NULL CHECK (usage_source IN ('reported','estimated','unknown')),
  input_tokens INTEGER CHECK (input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens >= 0),
  sync_state TEXT NOT NULL CHECK (sync_state IN ('pending','sent','acked','local_only')),
  sync_attempts INTEGER NOT NULL DEFAULT 0,
  next_sync_at TEXT,
  cloud_received_at TEXT,
  sync_error TEXT
) STRICT;
CREATE INDEX usage_events_time ON usage_events(occurred_at);
CREATE INDEX usage_events_sync ON usage_events(sync_state, account_id, next_sync_at);
`);
    const meta = db.prepare("INSERT OR IGNORE INTO host_meta(key, value) VALUES (?, ?)");
    meta.run("usage.runtime_id", randomUUID());
    meta.run("usage.id_salt", randomBytes(32).toString("base64url"));
    meta.run("usage.ledger_started_at", new Date().toISOString());
  }
}];
