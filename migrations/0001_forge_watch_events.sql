-- Forge Watch telemetry outbox (WFW-003 / ADR-0025, ADR-0023).
-- Idempotent: runMigrations executes all .sql files in order without a tracking table.
-- Canonical envelope stored as JSONB plus indexed identity columns. The collector is the
-- single writer of (run_id, sequence) the database enforces uniqueness so a duplicate
-- delivery or bypass cannot silently create a second version of the same event.

CREATE TABLE IF NOT EXISTS forge_watch_events (
  event_id        TEXT PRIMARY KEY,
  schema_version  INTEGER NOT NULL,
  timestamp_ms    BIGINT NOT NULL,
  run_id          TEXT NOT NULL,
  trial_id        TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  parent_run_id   TEXT,
  sequence        INTEGER NOT NULL,
  event_type      TEXT NOT NULL,
  source          TEXT NOT NULL,
  provider_id     TEXT,
  model_id        TEXT,
  tool_id         TEXT,
  permission      TEXT,
  authorization_decision TEXT,
  environment_id  TEXT,
  payload_digest  TEXT,
  policy_digest   TEXT,
  context_digest  TEXT,
  correlation_id  TEXT,
  envelope        JSONB NOT NULL,
  dispatched_at   BIGINT,
  created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT forge_watch_events_run_sequence_unique UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS forge_watch_events_run_id_sequence_idx
  ON forge_watch_events (run_id, sequence);

CREATE INDEX IF NOT EXISTS forge_watch_events_run_id_timestamp_idx
  ON forge_watch_events (run_id, timestamp_ms);

CREATE INDEX IF NOT EXISTS forge_watch_events_trial_id_idx
  ON forge_watch_events (trial_id);

CREATE INDEX IF NOT EXISTS forge_watch_events_tenant_id_idx
  ON forge_watch_events (tenant_id);

CREATE INDEX IF NOT EXISTS forge_watch_events_event_type_idx
  ON forge_watch_events (event_type);

CREATE INDEX IF NOT EXISTS forge_watch_events_undispatched_idx
  ON forge_watch_events (created_at)
  WHERE dispatched_at IS NULL;

-- Telemetry-integrity findings (gaps, regressions, malformed/duplicate events).
CREATE TABLE IF NOT EXISTS forge_watch_findings (
  finding_id      TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  kind            TEXT NOT NULL,
  sequence        INTEGER,
  expected        INTEGER,
  observed        INTEGER,
  detail          TEXT NOT NULL,
  at_ms           BIGINT NOT NULL,
  created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS forge_watch_findings_run_id_idx
  ON forge_watch_findings (run_id);

CREATE INDEX IF NOT EXISTS forge_watch_findings_kind_idx
  ON forge_watch_findings (kind);
