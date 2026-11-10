-- 0005_transaction_abstraction.sql — durable transaction intent, outbox, idempotency.
-- All idempotent (CREATE TABLE IF NOT EXISTS). Postgres-backed; in-memory fallback
-- for single-process dev/test.

CREATE TABLE IF NOT EXISTS tx_intents (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  target TEXT NOT NULL,
  method TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','simulated','submitted','included','finalized','failed','reconciled')),
  idempotency_key TEXT,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS tx_intents_idempotency_idx
  ON tx_intents (principal, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS tx_intents_state_idx ON tx_intents (state);
CREATE INDEX IF NOT EXISTS tx_intents_tenant_idx ON tx_intents (tenant_id);

CREATE TABLE IF NOT EXISTS tx_outbox (
  id BIGSERIAL PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES tx_intents(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  last_error TEXT,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS tx_outbox_next_idx ON tx_outbox (next_attempt_at);

CREATE TABLE IF NOT EXISTS chain_nonces (
  account TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  nonce BIGINT NOT NULL,
  updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  PRIMARY KEY (account, chain_id)
);

CREATE TABLE IF NOT EXISTS sponsorship_ledger (
  id BIGSERIAL PRIMARY KEY,
  intent_id TEXT REFERENCES tx_intents(id) ON DELETE SET NULL,
  policy_version TEXT NOT NULL,
  estimated_wei TEXT NOT NULL,
  actual_wei TEXT,
  status TEXT NOT NULL DEFAULT 'estimated'
    CHECK (status IN ('estimated','submitted','reconciled','failed')),
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
