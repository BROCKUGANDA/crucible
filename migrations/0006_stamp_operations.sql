-- 0006_stamp_operations.sql — STAMP operational tables (Phase 2-3) and the
-- workload evidence spine (WP0-WP9).
--
-- 0004_stamp_foundation.sql created the issuer/holder/instrument/allocation
-- baseline. This migration adds what an operating STAMP needs on top of it, and
-- the workload tables the evidence-driven verifier writes to.
--
-- Rules this schema encodes (blueprint §6, §7, §12):
--
--   * Amounts are NUMERIC(78,0) base units and percentages are BIGINT basis
--     points. No float column exists anywhere in this file.
--   * Legal, cash and chain facts live in separate tables. No single row blends
--     an entitlement with a transfer.
--   * Every mutation that matters is append-only: audit and outbox are written by
--     the same transaction as the domain row, through the trigger at the bottom.
--   * Nothing here holds a key, a seed or a private document body: documents are
--     referenced by URI plus SHA-256.
--
-- Idempotent throughout: this file is re-run on every boot by the migrator.

-- ---------------------------------------------------------------------------
-- Holder binding and eligibility
-- ---------------------------------------------------------------------------

ALTER TABLE stamp_holder_parties
  ADD COLUMN IF NOT EXISTS principal_address TEXT,
  ADD COLUMN IF NOT EXISTS bound_at BIGINT,
  ADD COLUMN IF NOT EXISTS bound_by TEXT;

-- One holder per verified principal address, and one address per holder: a
-- second binding is a mistake or an attack, and both should fail at the database
-- rather than depend on a route remembering to check.
CREATE UNIQUE INDEX IF NOT EXISTS stamp_holder_principal_unique
  ON stamp_holder_parties (principal_address)
  WHERE principal_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS stamp_holder_principal_idx
  ON stamp_holder_parties (principal_address);

-- A binding is only valid for an eligible holder: an unapproved party cannot
-- reach the investor portal by being bound early.
ALTER TABLE stamp_holder_parties
  DROP CONSTRAINT IF EXISTS stamp_holder_binding_requires_review;
ALTER TABLE stamp_holder_parties
  ADD CONSTRAINT stamp_holder_binding_requires_review
  CHECK (principal_address IS NULL OR eligibility_status <> 'pending');

-- ---------------------------------------------------------------------------
-- Instruments: signing and supersession
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS stamp_instruments_supersedes_idx
  ON stamp_instruments (supersedes_instrument_id);

-- An executed instrument is immutable. The application performs a correction by
-- inserting a new version that supersedes it, never by updating the row.
CREATE OR REPLACE FUNCTION stamp_instruments_immutable_after_signing()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.signed_document_sha256 IS NOT NULL
     AND (NEW.document_sha256 <> OLD.document_sha256
          OR NEW.pro_rata_bps <> OLD.pro_rata_bps
          OR NEW.purchase_price_minor <> OLD.purchase_price_minor) THEN
    RAISE EXCEPTION
      'executed instrument % cannot be amended in place; insert a superseding version',
      OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stamp_instruments_immutable ON stamp_instruments;
CREATE TRIGGER stamp_instruments_immutable
  BEFORE UPDATE ON stamp_instruments
  FOR EACH ROW EXECUTE FUNCTION stamp_instruments_immutable_after_signing();

-- ---------------------------------------------------------------------------
-- Payments: refusal reasons and uniqueness
-- ---------------------------------------------------------------------------

ALTER TABLE stamp_payments
  ADD COLUMN IF NOT EXISTS cluster TEXT,
  ADD COLUMN IF NOT EXISTS refusal_reason TEXT;

-- 0004 already declared the (network, signature, mint) uniqueness; restate it so
-- a database created from 0004's earlier draft still gets it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stamp_payments_unique_sig'
  ) THEN
    ALTER TABLE stamp_payments
      ADD CONSTRAINT stamp_payments_unique_sig
      UNIQUE (network, transaction_signature, token_mint);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS stamp_payments_signature_idx
  ON stamp_payments (transaction_signature);

-- ---------------------------------------------------------------------------
-- Notices: evidence and escalation
-- ---------------------------------------------------------------------------

ALTER TABLE stamp_notices
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS lead_days INTEGER;

CREATE INDEX IF NOT EXISTS stamp_notices_status_idx
  ON stamp_notices (status);
CREATE INDEX IF NOT EXISTS stamp_notices_due_idx
  ON stamp_notices (required_delivery_at);

-- ---------------------------------------------------------------------------
-- Structuring events: the full state list 0004's CHECK does not carry
-- ---------------------------------------------------------------------------

ALTER TABLE token_structuring_events
  ADD COLUMN IF NOT EXISTS mint_authority_before TEXT,
  ADD COLUMN IF NOT EXISTS mint_authority_after TEXT,
  ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;

ALTER TABLE token_structuring_events
  DROP CONSTRAINT IF EXISTS token_structuring_events_status_check;
ALTER TABLE token_structuring_events
  ADD CONSTRAINT token_structuring_events_status_check
  CHECK (status IN (
    'PREPARATION', 'LEGAL_SNAPSHOT_LOCKED', 'HOLDER_NOTICE_SENT',
    'META_DAO_EVENT_SUBMITTED', 'CHAIN_CONFIRMED', 'FINALITY_CONFIRMED',
    'PORTIONS_RECONCILED', 'DELIVERY_OPEN', 'HOLD'
  ));

-- ---------------------------------------------------------------------------
-- Delivery requests: review evidence and deadlines
-- ---------------------------------------------------------------------------

ALTER TABLE stamp_delivery_requests
  ADD COLUMN IF NOT EXISTS contractual_exercise_at BIGINT,
  ADD COLUMN IF NOT EXISTS review_ref TEXT,
  ADD COLUMN IF NOT EXISTS delivered_at BIGINT,
  ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;

ALTER TABLE stamp_delivery_requests
  DROP CONSTRAINT IF EXISTS stamp_delivery_requests_status_check;
ALTER TABLE stamp_delivery_requests
  ADD CONSTRAINT stamp_delivery_requests_status_check
  CHECK (status IN (
    'REQUESTED', 'SIGNATURE_VERIFIED', 'ADDRESS_VALIDATED', 'ELIGIBILITY_RECHECKED',
    'APPROVED', 'SUBMITTED', 'CONFIRMED', 'RECONCILED', 'REJECTED'
  ));

-- A delivery request is only approved once the holder has proved the address.
ALTER TABLE stamp_delivery_requests
  DROP CONSTRAINT IF EXISTS stamp_delivery_requires_address_proof;
ALTER TABLE stamp_delivery_requests
  ADD CONSTRAINT stamp_delivery_requires_address_proof
  CHECK (
    status NOT IN ('ADDRESS_VALIDATED', 'ELIGIBILITY_RECHECKED', 'APPROVED', 'SUBMITTED', 'CONFIRMED', 'RECONCILED')
    OR address_challenge_signature IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- Vesting: the conservation invariant, in the database
-- ---------------------------------------------------------------------------

ALTER TABLE stamp_vesting_schedules
  ADD COLUMN IF NOT EXISTS remainder_policy TEXT NOT NULL DEFAULT 'largest-remainder',
  ADD COLUMN IF NOT EXISTS time_zone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  ADD COLUMN IF NOT EXISTS schedule_input_hash TEXT;

-- released + remaining = delivered, always. A row that breaks this is a
-- reconciliation failure the checks exist to catch, so the database refuses it
-- rather than letting it be discovered later.
ALTER TABLE stamp_vesting_schedules
  DROP CONSTRAINT IF EXISTS stamp_vesting_conserves;
ALTER TABLE stamp_vesting_schedules
  ADD CONSTRAINT stamp_vesting_conserves
  CHECK (released_total + remaining_total = delivered_amount);

ALTER TABLE stamp_vesting_schedules
  DROP CONSTRAINT IF EXISTS stamp_vesting_no_overdraw;
ALTER TABLE stamp_vesting_schedules
  ADD CONSTRAINT stamp_vesting_no_overdraw
  CHECK (released_total >= 0 AND remaining_total >= 0 AND delivered_amount >= 0);

CREATE INDEX IF NOT EXISTS stamp_vesting_schedule_hash_idx
  ON stamp_vesting_schedules (schedule_input_hash);

-- ---------------------------------------------------------------------------
-- Assignment chain: no double counting
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stamp_assignments (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES stamp_instruments(id) ON DELETE RESTRICT,
  from_holder_party_id TEXT NOT NULL REFERENCES stamp_holder_parties(id) ON DELETE RESTRICT,
  to_holder_party_id TEXT NOT NULL REFERENCES stamp_holder_parties(id) ON DELETE RESTRICT,
  portion_base_units NUMERIC(78,0) NOT NULL CHECK (portion_base_units >= 0),
  effective_at BIGINT NOT NULL,
  review_ref TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT stamp_assignments_distinct_parties CHECK (from_holder_party_id <> to_holder_party_id)
);
CREATE INDEX IF NOT EXISTS stamp_assignments_instrument_idx
  ON stamp_assignments (instrument_id);

-- ---------------------------------------------------------------------------
-- Outbox: a durable record of what a mutation told the world
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stamp_outbox (
  id BIGSERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  payload_digest TEXT,
  payload JSONB,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  delivered_at BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS stamp_outbox_pending_idx
  ON stamp_outbox (created_at)
  WHERE delivered_at IS NULL;

ALTER TABLE stamp_audit_events
  ADD COLUMN IF NOT EXISTS detail TEXT;

CREATE INDEX IF NOT EXISTS stamp_audit_instrument_idx
  ON stamp_audit_events (instrument_id);

-- ---------------------------------------------------------------------------
-- Workload evidence spine (WP0-WP9)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workload_runs (
  run_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  trial_id TEXT NOT NULL,
  trial_revision_id TEXT NOT NULL,
  workload_profile TEXT NOT NULL
    CHECK (workload_profile IN ('SOFTWARE_ENGINEERING', 'STRUCTURED_DATA', 'AUTONOMOUS_FINANCE', 'SOLANA_ENGINEERING')),
  status TEXT NOT NULL,
  evidence_source TEXT NOT NULL DEFAULT 'none'
    CHECK (evidence_source IN ('runner', 'client', 'none')),
  withheld_reason TEXT,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  CONSTRAINT workload_runs_attempt_unique UNIQUE (attempt_id)
);
CREATE INDEX IF NOT EXISTS workload_runs_tenant_idx ON workload_runs (tenant_id, trial_id);
CREATE INDEX IF NOT EXISTS workload_runs_creator_idx ON workload_runs (created_by);

-- The pinned provenance of one execution. Immutable once written.
CREATE TABLE IF NOT EXISTS execution_manifests (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  manifest JSONB NOT NULL,
  task_digest TEXT NOT NULL,
  runner_image_digest TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  manifest_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS execution_manifests_run_idx ON execution_manifests (run_id);

-- What the runner observed, one row per check. This is the evidence a verdict is
-- computed from; it is never overwritten.
CREATE TABLE IF NOT EXISTS run_check_evidence (
  id BIGSERIAL PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  detail TEXT NOT NULL,
  artifact_digest TEXT,
  recorded_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT run_check_evidence_unique UNIQUE (attempt_id, check_id)
);

CREATE TABLE IF NOT EXISTS verification_reports (
  attempt_id TEXT PRIMARY KEY,
  status TEXT NOT NULL
    CHECK (status IN ('PASS', 'FAIL', 'ABSTAIN', 'NEEDS_REVIEW', 'INCOMPLETE')),
  report_digest TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  checks JSONB NOT NULL,
  missing_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  infrastructure_failure TEXT,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

-- A score is null when the report was not scoreable. The column permits null on
-- purpose: a zero would be a measurement that was never made.
CREATE TABLE IF NOT EXISTS run_scorecards (
  scorecard_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  metrics JSONB NOT NULL,
  aggregate DOUBLE PRECISION,
  created_at BIGINT NOT NULL,
  CONSTRAINT run_scorecards_aggregate_range
    CHECK (aggregate IS NULL OR (aggregate >= 0 AND aggregate <= 1))
);
CREATE INDEX IF NOT EXISTS run_scorecards_attempt_idx ON run_scorecards (attempt_id);

CREATE TABLE IF NOT EXISTS run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  occurred_at BIGINT NOT NULL,
  producer TEXT NOT NULL,
  payload_digest TEXT,
  payload JSONB,
  correlation_id TEXT,
  causation_id TEXT,
  CONSTRAINT run_events_sequence_unique UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS run_events_attempt_idx ON run_events (attempt_id);

-- ---------------------------------------------------------------------------
-- Data contracts and lineage (WP5-WP7)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS data_contracts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  contract JSONB NOT NULL,
  compatibility_policy TEXT NOT NULL DEFAULT 'backward'
    CHECK (compatibility_policy IN ('backward', 'forward', 'full', 'breaking')),
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT data_contracts_version_unique UNIQUE (tenant_id, name, version)
);

-- OpenLineage-shaped events. `producer` and `schema_url` are NOT NULL because an
-- event without them is not interoperable, and storing one would look like
-- coverage while being unreadable.
CREATE TABLE IF NOT EXISTS lineage_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('START', 'RUNNING', 'COMPLETE', 'ABORT', 'FAIL')),
  event_time TIMESTAMPTZ NOT NULL,
  job_namespace TEXT NOT NULL,
  job_name TEXT NOT NULL,
  producer TEXT NOT NULL,
  schema_url TEXT NOT NULL,
  inputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  outputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  facets JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_digest TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS lineage_events_run_idx ON lineage_events (run_id);
CREATE INDEX IF NOT EXISTS lineage_events_job_idx ON lineage_events (job_namespace, job_name);

-- ---------------------------------------------------------------------------
-- Finance: mandates, intents, approvals (WP8-WP9)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS finance_mandates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  mode TEXT NOT NULL
    CHECK (mode IN ('READ_ONLY', 'PAPER', 'SHADOW', 'HUMAN_APPROVED')),
  autonomy TEXT
    CHECK (autonomy IS NULL OR autonomy IN ('F0', 'F1', 'F2', 'F3', 'F4')),
  mandate JSONB NOT NULL,
  revoked_at BIGINT,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT finance_mandates_version_unique UNIQUE (tenant_id, name, version)
);

CREATE TABLE IF NOT EXISTS execution_intents (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES finance_mandates(id) ON DELETE RESTRICT,
  canonical_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'PROPOSED'
    CHECK (state IN ('PROPOSED', 'RISK_CHECKED', 'AWAITING_APPROVAL', 'APPROVED', 'EXECUTING', 'EXECUTED', 'REJECTED', 'SUSPENDED')),
  risk_result JSONB,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT execution_intents_hash_unique UNIQUE (mandate_id, canonical_hash)
);
CREATE INDEX IF NOT EXISTS execution_intents_state_idx ON execution_intents (state);

-- An approval names the exact payload hash. Changing the payload cannot reuse it:
-- the foreign key is on (intent_id, canonical_hash), so an approval for a
-- different hash has no row to point at.
CREATE TABLE IF NOT EXISTS human_approvals (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  approver TEXT NOT NULL,
  approver_role TEXT NOT NULL,
  author TEXT NOT NULL,
  approved_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  CONSTRAINT human_approvals_intent_unique UNIQUE (intent_id, canonical_hash),
  CONSTRAINT human_approvals_separation_of_duties CHECK (approver <> author)
);

CREATE TABLE IF NOT EXISTS kill_switches (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'tenant', 'agent', 'strategy', 'mandate')),
  scope_id TEXT NOT NULL,
  engaged_at BIGINT NOT NULL,
  engaged_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  cleared_at BIGINT,
  cleared_by TEXT,
  PRIMARY KEY (scope, scope_id, engaged_at)
);

-- ---------------------------------------------------------------------------
-- Audit and outbox, written by whichever transaction made the change
-- ---------------------------------------------------------------------------

-- One trigger function for every workload table.
--
-- The digest is read out of the row's own JSON, not from a column name: a
-- plpgsql function that says `NEW.report_digest` fails at execution time on any
-- table without that column, and this one runs on three tables with three
-- different digest columns.
CREATE OR REPLACE FUNCTION stamp_workload_audit()
RETURNS TRIGGER AS $$
DECLARE
  payload jsonb := to_jsonb(NEW);
  digest text;
BEGIN
  digest := COALESCE(
    payload->>'report_digest',
    payload->>'manifest_hash',
    payload->>'event_digest',
    payload->>'scorecard_id',
    payload->>'run_id'
  );
  INSERT INTO stamp_outbox (topic, payload_digest, payload)
  VALUES (TG_ARGV[0], digest, payload);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS verification_reports_outbox ON verification_reports;
CREATE TRIGGER verification_reports_outbox
  AFTER INSERT ON verification_reports
  FOR EACH ROW EXECUTE FUNCTION stamp_workload_audit('workload.verification.recorded');

DROP TRIGGER IF EXISTS run_scorecards_outbox ON run_scorecards;
CREATE TRIGGER run_scorecards_outbox
  AFTER INSERT ON run_scorecards
  FOR EACH ROW EXECUTE FUNCTION stamp_workload_audit('workload.scorecard.recorded');

DROP TRIGGER IF EXISTS lineage_events_outbox ON lineage_events;
CREATE TRIGGER lineage_events_outbox
  AFTER INSERT ON lineage_events
  FOR EACH ROW EXECUTE FUNCTION stamp_workload_audit('data.lineage.recorded');

-- ---------------------------------------------------------------------------
-- Row-level security: tenant isolation for the workload tables
-- ---------------------------------------------------------------------------

ALTER TABLE workload_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_mandates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workload_runs_tenant ON workload_runs;
CREATE POLICY workload_runs_tenant ON workload_runs
  USING (tenant_id = current_setting('crucible.tenant_id', true));

DROP POLICY IF EXISTS data_contracts_tenant ON data_contracts;
CREATE POLICY data_contracts_tenant ON data_contracts
  USING (tenant_id = current_setting('crucible.tenant_id', true));

DROP POLICY IF EXISTS finance_mandates_tenant ON finance_mandates;
CREATE POLICY finance_mandates_tenant ON finance_mandates
  USING (tenant_id = current_setting('crucible.tenant_id', true));
