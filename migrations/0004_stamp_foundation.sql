-- 0004_stamp_foundation.sql — STAMP protocol-ownership domain (Phase 1).
-- Issuer registry, holder parties, instruments, versioned allocation snapshots.
-- All idempotent. Legal review required before production use.

CREATE TABLE IF NOT EXISTS protocol_issuers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  legal_entity_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  jurisdiction_code TEXT NOT NULL,
  registration_number TEXT,
  meta_dao_project_ref TEXT,
  solana_cluster TEXT NOT NULL DEFAULT 'devnet',
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','COUNSEL_REVIEW','ENTITY_READY','IP_PERIMETER_VERIFIED','META_DAO_REVIEW','LISTED','ACTIVE','LEGAL_HOLD','META_DAO_HOLD','WINDING_DOWN','REJECTED')),
  counsel_approval_ref TEXT,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS protocol_issuers_tenant_idx ON protocol_issuers (tenant_id);
CREATE INDEX IF NOT EXISTS protocol_issuers_status_idx ON protocol_issuers (status);

CREATE TABLE IF NOT EXISTS stamp_holder_parties (
  id TEXT PRIMARY KEY,
  issuer_id TEXT NOT NULL REFERENCES protocol_issuers(id) ON DELETE RESTRICT,
  party_type TEXT NOT NULL DEFAULT 'investor',
  display_name_encrypted BYTEA NOT NULL,
  contact_ref TEXT,
  eligibility_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (eligibility_status IN ('pending','approved','rejected','review')),
  eligibility_reviewed_at BIGINT,
  jurisdiction_screening_status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS stamp_holder_parties_issuer_idx ON stamp_holder_parties (issuer_id);

CREATE TABLE IF NOT EXISTS stamp_instruments (
  id TEXT PRIMARY KEY,
  issuer_id TEXT NOT NULL REFERENCES protocol_issuers(id) ON DELETE RESTRICT,
  holder_party_id TEXT NOT NULL REFERENCES stamp_holder_parties(id) ON DELETE RESTRICT,
  instrument_version TEXT NOT NULL DEFAULT '1',
  document_sha256 BYTEA NOT NULL,
  document_uri TEXT NOT NULL,
  issue_date DATE NOT NULL,
  purchase_price_minor NUMERIC(78,0) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USDC',
  accepted_stablecoin_mint TEXT NOT NULL,
  approved_wallet TEXT NOT NULL,
  pro_rata_bps BIGINT NOT NULL CHECK (pro_rata_bps >= 0),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','COUNSEL_APPROVED','OFFERED','SIGNED','PAYMENT_PENDING','FUNDED','ELIGIBLE_FOR_DELIVERY','DELIVERY_REQUESTED','DELIVERY_APPROVED','DELIVERED','VESTING_ACTIVE','VESTING_COMPLETE','CANCELLED','EXPIRED','ASSIGNED','SUPERSEDED','DISPUTED','DISSOLUTION_CLAIM')),
  signed_at BIGINT,
  signed_document_sha256 BYTEA,
  supersedes_instrument_id TEXT REFERENCES stamp_instruments(id),
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT stamp_instruments_no_self_supersede CHECK (supersedes_instrument_id IS NULL OR supersedes_instrument_id <> id)
);
CREATE INDEX IF NOT EXISTS stamp_instruments_issuer_idx ON stamp_instruments (issuer_id);
CREATE INDEX IF NOT EXISTS stamp_instruments_holder_idx ON stamp_instruments (holder_party_id);
CREATE INDEX IF NOT EXISTS stamp_instruments_status_idx ON stamp_instruments (status);

CREATE TABLE IF NOT EXISTS stamp_allocations (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES stamp_instruments(id) ON DELETE RESTRICT,
  schedule_2_version TEXT NOT NULL,
  raw_pro_rata_bps BIGINT NOT NULL,
  effective_pro_rata_bps BIGINT NOT NULL,
  total_network_tokens NUMERIC(78,0),
  holder_portion_tokens NUMERIC(78,0),
  calculation_version TEXT NOT NULL DEFAULT 'v1',
  calculation_input_hash BYTEA NOT NULL,
  calculated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  approved_by TEXT
);
CREATE INDEX IF NOT EXISTS stamp_allocations_instrument_idx ON stamp_allocations (instrument_id);

-- Immutable payments: one row per (network, tx signature, mint). No updates.
CREATE TABLE IF NOT EXISTS stamp_payments (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES stamp_instruments(id) ON DELETE RESTRICT,
  network TEXT NOT NULL,
  token_mint TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_approved_address TEXT NOT NULL,
  amount_base_units NUMERIC(78,0) NOT NULL,
  transaction_signature TEXT NOT NULL,
  block_slot BIGINT,
  finality_status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (finality_status IN ('submitted','confirmed','finalized','reorged')),
  canonicality_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (canonicality_status IN ('pending','canonical','orphaned')),
  observed_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  verified_at BIGINT,
  verification_payload_hash BYTEA NOT NULL,
  CONSTRAINT stamp_payments_unique_sig UNIQUE (network, transaction_signature, token_mint)
);
CREATE INDEX IF NOT EXISTS stamp_payments_instrument_idx ON stamp_payments (instrument_id);

CREATE TABLE IF NOT EXISTS stamp_notices (
  id TEXT PRIMARY KEY,
  issuer_id TEXT NOT NULL REFERENCES protocol_issuers(id) ON DELETE RESTRICT,
  instrument_id TEXT REFERENCES stamp_instruments(id) ON DELETE SET NULL,
  notice_type TEXT NOT NULL,
  effective_at BIGINT NOT NULL,
  contractual_timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  required_delivery_at BIGINT NOT NULL,
  delivered_at BIGINT,
  delivery_channel TEXT NOT NULL DEFAULT 'email',
  delivery_evidence_uri TEXT,
  delivery_evidence_hash BYTEA,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','sent','delivered','failed','escalated'))
);
CREATE INDEX IF NOT EXISTS stamp_notices_issuer_idx ON stamp_notices (issuer_id);

CREATE TABLE IF NOT EXISTS token_structuring_events (
  id TEXT PRIMARY KEY,
  issuer_id TEXT NOT NULL REFERENCES protocol_issuers(id) ON DELETE RESTRICT,
  meta_dao_project_ref TEXT NOT NULL,
  total_network_tokens NUMERIC(78,0) NOT NULL,
  token_mint TEXT NOT NULL,
  token_program_id TEXT NOT NULL,
  structuring_slot BIGINT,
  structuring_signature TEXT,
  finality_status TEXT NOT NULL DEFAULT 'pending',
  legal_supply_snapshot_hash BYTEA NOT NULL,
  meta_dao_approval_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PREPARATION'
);
CREATE INDEX IF NOT EXISTS token_structuring_events_issuer_idx ON token_structuring_events (issuer_id);

CREATE TABLE IF NOT EXISTS stamp_delivery_requests (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES stamp_instruments(id) ON DELETE RESTRICT,
  holder_party_id TEXT NOT NULL REFERENCES stamp_holder_parties(id) ON DELETE RESTRICT,
  request_document_sha256 BYTEA NOT NULL,
  signed_at BIGINT NOT NULL,
  destination_address TEXT NOT NULL,
  address_challenge_signature TEXT NOT NULL,
  address_network TEXT NOT NULL DEFAULT 'solana',
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending','approved','rejected')),
  status TEXT NOT NULL DEFAULT 'REQUESTED'
);
CREATE UNIQUE INDEX IF NOT EXISTS stamp_delivery_active_unique
  ON stamp_delivery_requests (instrument_id)
  WHERE status IN ('REQUESTED','SIGNATURE_VERIFIED','ADDRESS_VALIDATED','ELIGIBILITY_RECHECKED','APPROVED','SUBMITTED','CONFIRMED');

CREATE TABLE IF NOT EXISTS stamp_vesting_schedules (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES stamp_instruments(id) ON DELETE RESTRICT,
  delivered_amount NUMERIC(78,0) NOT NULL,
  delivery_date BIGINT NOT NULL,
  schedule_version TEXT NOT NULL DEFAULT 'v1',
  first_release_at BIGINT NOT NULL,
  monthly_vector JSONB NOT NULL,
  released_total NUMERIC(78,0) NOT NULL DEFAULT 0,
  remaining_total NUMERIC(78,0) NOT NULL,
  chain_account_ref TEXT,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS stamp_vesting_instrument_idx ON stamp_vesting_schedules (instrument_id);

CREATE TABLE IF NOT EXISTS stamp_audit_events (
  id BIGSERIAL PRIMARY KEY,
  issuer_id TEXT,
  instrument_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_hash BYTEA,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS stamp_audit_issuer_idx ON stamp_audit_events (issuer_id);
