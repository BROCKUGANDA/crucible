-- CRU-RUNTIME-001 / REW-001 durable tables.
-- Atomic event+outbox lives in 0001 this adds the outbox table, run registry,
-- incidents, and reward entitlements. All idempotent (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS forge_watch_outbox (
  id          BIGSERIAL PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES forge_watch_events(event_id) ON DELETE CASCADE,
  phase       TEXT NOT NULL DEFAULT 'L0',
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT,
  lease_until BIGINT,
  last_error  TEXT,
  created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT forge_watch_outbox_event_phase_unique UNIQUE (event_id, phase)
);
CREATE INDEX IF NOT EXISTS forge_watch_outbox_pending_idx
  ON forge_watch_outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  trial_id      TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  org_id        TEXT,
  status        TEXT NOT NULL DEFAULT 'QUEUED',
  idempotency_key TEXT,
  image_digest  TEXT,
  created_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_idx
  ON runs (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_trial_idx ON runs (trial_id);

CREATE TABLE IF NOT EXISTS incidents (
  incident_id TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'DETECTED',
  severity    TEXT NOT NULL DEFAULT 'medium',
  detail      TEXT NOT NULL,
  created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS incidents_run_idx ON incidents (run_id);

CREATE TABLE IF NOT EXISTS reward_entitlements (
  entitlement_id TEXT PRIMARY KEY,
  recipient_address TEXT NOT NULL,
  recipient_chain_id TEXT NOT NULL DEFAULT '31337',
  agent_id     TEXT,
  rule_id      TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  token_id     BIGINT NOT NULL,
  amount       BIGINT NOT NULL DEFAULT 1,
  event_id     TEXT NOT NULL,
  trial_id     TEXT,
  run_id       TEXT,
  run_hash     TEXT,
  argus_report_digest TEXT,
  manifest_digest TEXT,
  settlement_tx_hash TEXT,
  settlement_block_hash TEXT,
  status       TEXT NOT NULL DEFAULT 'earned',
  claim_tx_hash TEXT,
  issued_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  claim_deadline BIGINT,
  claimed_at   BIGINT,
  revocation_reason TEXT,
  CONSTRAINT reward_entitlements_unique UNIQUE (recipient_address, rule_id, rule_version, event_id)
);
CREATE INDEX IF NOT EXISTS reward_entitlements_recipient_idx
  ON reward_entitlements (recipient_address);

CREATE TABLE IF NOT EXISTS achievement_rules (
  rule_id      TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  token_id     BIGINT NOT NULL,
  chain_id     TEXT NOT NULL DEFAULT '31337',
  criteria_digest TEXT NOT NULL,
  issuance_cap BIGINT,
  active_from  BIGINT,
  active_until BIGINT,
  PRIMARY KEY (rule_id, rule_version)
);

CREATE TABLE IF NOT EXISTS reward_campaigns (
  campaign_id  TEXT PRIMARY KEY,
  campaign_version TEXT NOT NULL DEFAULT '1',
  chain_id     TEXT NOT NULL DEFAULT '31337',
  token_id     BIGINT,
  root         TEXT,
  budget       BIGINT NOT NULL DEFAULT 0,
  claimed      BIGINT NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'DRAFT',
  claim_start  BIGINT,
  claim_end    BIGINT,
  created_at   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE TABLE IF NOT EXISTS reward_claims (
  claim_id     TEXT PRIMARY KEY,
  entitlement_id TEXT,
  campaign_id  TEXT,
  recipient    TEXT NOT NULL,
  proof_digest TEXT,
  tx_hash      TEXT,
  status       TEXT NOT NULL DEFAULT 'prepared',
  created_at   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
