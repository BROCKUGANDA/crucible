-- 0011_sponsor_funding_chain_truth.sql — A sponsor's funding, as a chain fact.
--
-- Migration 0009 created the sponsor program and its budget ledger. What it
-- did not create was any way to tell whether the money behind a budget line
-- ever existed. `deposited_wei` was a number the API wrote down about
-- itself: a program could say it had funded a trial, the ledger would
-- believe it, and the console would report a budget that the chain had
-- never seen.
--
-- This migration adds the chain truth:
--
--   * sponsor_funding_claims — what the program claims: a trial id, the
--     sponsor address it claims to have paid from, and the amount.
--   * sponsor_funding_receipts — what the chain said when that claim was
--     checked: the verdict, the reason in words, and the amounts as read
--     from the escrow.
--
-- Two rules govern the numbers here:
--
--   - Every wei value is TEXT, never a numeric column that a driver might
--     hand back as a float. 1 wei of difference matters more than any
--     rounding convenience.
--   - The receipt stores the amounts AS READ. Nothing here is recomputed:
--     the arena fee was computed on-chain at post time, and a stored copy of
--     a recomputation could disagree with the escrow by a wei forever.
--
-- The claim is allowed to be wrong. A claim whose verification failed is
-- still a record — it is what the reconciliation job reports on, and
-- deleting it would make the drift invisible.

-- ---------------------------------------------------------------------------
-- Funding claims
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sponsor_funding_claims (
  id              TEXT PRIMARY KEY,
  -- The program this claim belongs to. NOT a foreign key on purpose: the
  -- chain truth must not depend on the program scaffolding being in the same
  -- state of migration. A claim that outlives a program's storage rewrite is
  -- the thing worth keeping; a claim that cannot be written is not.
  program_id      TEXT NOT NULL,
  -- The tenant that owns the program. The RLS boundary is the tenant, which
  -- is the thing that actually exists in every deployment.
  org_id          TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  -- The arena trial this claim is about. TEXT, not BIGINT: the trial id is
  -- a chain identifier, and a claim about a trial on another chain must be
  -- storable even if it cannot be verified here.
  trial_id        TEXT NOT NULL,
  -- The sponsor address the money is claimed to have come from.
  sponsor_address TEXT NOT NULL,
  -- What the program claims it deposited, in wei.
  claimed_wei     TEXT NOT NULL DEFAULT '0',
  -- The posting transaction, when the sponsor has it.
  tx_hash         TEXT,
  -- The verdict of the most recent check. CLAIMED means "not checked yet",
  -- which is a real state and not the same as UNVERIFIABLE: the first is a
  -- queue, the second is a failed read.
  status          TEXT NOT NULL DEFAULT 'CLAIMED'
    CHECK (status IN ('CLAIMED','VERIFIED','MISMATCH','UNVERIFIABLE')),
  created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT sponsor_funding_claims_program_trial UNIQUE (program_id, trial_id)
);

CREATE INDEX IF NOT EXISTS sponsor_funding_claims_program_idx
  ON sponsor_funding_claims (program_id);
CREATE INDEX IF NOT EXISTS sponsor_funding_claims_org_idx
  ON sponsor_funding_claims (org_id);
CREATE INDEX IF NOT EXISTS sponsor_funding_claims_status_idx
  ON sponsor_funding_claims (status);

-- ---------------------------------------------------------------------------
-- Funding receipts: what the chain said
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sponsor_funding_receipts (
  id                 TEXT PRIMARY KEY,
  claim_id           TEXT NOT NULL REFERENCES sponsor_funding_claims(id) ON DELETE CASCADE,
  verdict            TEXT NOT NULL
    CHECK (verdict IN ('VERIFIED','MISMATCH','UNVERIFIABLE')),
  -- Why, in words a sponsor can read. NULL when verified.
  reason             TEXT,
  -- reward + fee: what the SPONSOR escrowed, read from the chain.
  observed_sponsor_funding_wei TEXT,
  observed_reward_wei TEXT,
  observed_fee_wei   TEXT,
  -- Every wei the trial ever took in. Informational only: this includes the
  -- agent's bond and the skeptics' stakes and is NOT the sponsor's money.
  observed_deposited_wei TEXT,
  observed_paid_out_wei TEXT,
  observed_sponsor   TEXT,
  trial_status       INTEGER,
  checked_at         BIGINT NOT NULL,
  created_at         BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS sponsor_funding_receipts_claim_idx
  ON sponsor_funding_receipts (claim_id);
CREATE INDEX IF NOT EXISTS sponsor_funding_receipts_verdict_idx
  ON sponsor_funding_receipts (verdict);

-- ---------------------------------------------------------------------------
-- RLS: the tenant boundary
-- ---------------------------------------------------------------------------

ALTER TABLE sponsor_funding_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsor_funding_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sponsor_funding_claims_read ON sponsor_funding_claims;
CREATE POLICY sponsor_funding_claims_read
  ON sponsor_funding_claims FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = sponsor_funding_claims.org_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

DROP POLICY IF EXISTS sponsor_funding_claims_write ON sponsor_funding_claims;
CREATE POLICY sponsor_funding_claims_write
  ON sponsor_funding_claims FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = sponsor_funding_claims.org_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

DROP POLICY IF EXISTS sponsor_funding_receipts_read ON sponsor_funding_receipts;
CREATE POLICY sponsor_funding_receipts_read
  ON sponsor_funding_receipts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM sponsor_funding_claims c
      JOIN sponsor_programs sp ON sp.id = c.program_id
      JOIN memberships m ON m.org_id = sp.org_id
      WHERE c.id = sponsor_funding_receipts.claim_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

DROP POLICY IF EXISTS sponsor_funding_receipts_write ON sponsor_funding_receipts;
CREATE POLICY sponsor_funding_receipts_write
  ON sponsor_funding_receipts FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM sponsor_funding_claims c
      JOIN sponsor_programs sp ON sp.id = c.program_id
      JOIN memberships m ON m.org_id = sp.org_id
      WHERE c.id = sponsor_funding_receipts.claim_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );
