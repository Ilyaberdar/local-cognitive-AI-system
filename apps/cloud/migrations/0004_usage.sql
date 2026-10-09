-- Usage (spec §10, §13): one row per request to a model, as the runtime that ran it recorded it.
-- Counts and opaque references only: no text, paths or arguments. A count the provider did not
-- report is NULL, never 0. `execution_host_id` is a registered host's id (source 'host') or a
-- desktop runtime's own id (source 'local'); the pair with `event_id` makes a resend a duplicate.

CREATE TABLE usage_events (
  execution_host_id uuid NOT NULL,
  event_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('host', 'local')),
  call_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 1000),
  run_ref text CHECK (run_ref ~ '^[A-Za-z0-9_-]{1,64}$'),
  session_ref text CHECK (session_ref ~ '^[A-Za-z0-9_-]{1,64}$'),
  origin text CHECK (char_length(origin) <= 32),
  purpose text CHECK (char_length(purpose) <= 64),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 64),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 128),
  started_at timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('completed', 'rejected', 'failed', 'cancelled')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  usage_source text NOT NULL CHECK (usage_source IN ('reported', 'estimated', 'unknown')),
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  total_tokens bigint CHECK (total_tokens >= 0),
  cached_input_tokens bigint CHECK (cached_input_tokens >= 0),
  cache_write_tokens bigint CHECK (cache_write_tokens >= 0),
  reasoning_tokens bigint CHECK (reasoning_tokens >= 0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (execution_host_id, event_id)
);
CREATE INDEX usage_events_account_occurred_idx ON usage_events (account_id, occurred_at);
CREATE INDEX usage_events_account_received_idx ON usage_events (account_id, received_at);
