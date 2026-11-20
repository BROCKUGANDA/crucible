-- 0012_sponsor_ledger_durable.sql — the sponsor's own records, durable.
--
-- What this migration fixes, and why it is a schema change and not a code
-- change:
--
-- Migration 0009 created `sponsor_programs` and `budget_entries`, and
-- migration 0011 created `sponsor_funding_claims`. None of them was ever
-- written to: the API's sponsor and programme state lived in process memory
-- (`apps/api/src/sponsor-onboarding.ts`), so a restart lost every sponsor,
-- every programme and every budget line — and the funding claims, which WERE
-- durable, hung off a programme that no longer existed.
--
-- Worse, the claims could not be written at all in a real deployment:
--
--   sponsor_funding_claims.org_id REFERENCES organisations(id)
--
-- and NOTHING in this repository ever inserts an organisation. The tenancy
-- model is deliberately in process memory (`packages/agent-security/src/
-- org-store.ts`, whose own header says "persistence is explicitly deferred:
-- no database or queue is introduced without a new ADR"). So the foreign key
-- refused EVERY claim:
--
--   insert or update on table "sponsor_funding_claims" violates foreign key
--   constraint "sponsor_funding_claims_org_id_fkey"
--
-- — measured against a real PostgreSQL 17, not inferred. The claims path was
-- the heart of "a sponsor's funding is a chain fact", and it could not record
-- a claim.
--
-- The fix has two halves.
--
-- 1. The foreign keys to `organisations` are DROPPED. The tenant boundary is
--    not weakened by this: it is enforced in the route, against the
--    in-memory membership model that is the actual source of truth today
--    (`isMemberOf` in `apps/api/src/sponsor-funding-routes.ts`), and the
--    row-level policies below still carry the database-level expression of
--    the same rule for the day the organisation model becomes durable. What
--    is removed is a constraint that could only ever refuse a legitimate
--    write. A financial record that names its tenant is worth keeping even
--    when the tenant's own record lives elsewhere.
--
-- 2. The sponsor's own records become durable: `sponsor_orgs` (the customer
--    record — name, wallet, contact, onboarding steps) and the extension of
--    `sponsor_programs` with the columns the domain model actually has
--    (the sponsor it belongs to, its objectives, its suites, its evaluation
--    window, its publication policy, its dispute rules and its launch and
--    completion times).
--
-- Every wei value stays TEXT. Money never crosses a float — not in the
-- database, not on the way in, and not in any total computed from these rows.

-- ---------------------------------------------------------------------------
-- The foreign keys that could only ever refuse a legitimate write
-- ---------------------------------------------------------------------------

ALTER TABLE sponsor_funding_claims
  DROP CONSTRAINT IF EXISTS sponsor_funding_claims_org_id_fkey;

ALTER TABLE sponsor_programs
  DROP CONSTRAINT IF EXISTS sponsor_programs_org_id_fkey;

-- ---------------------------------------------------------------------------
-- Sponsors: the customer record, durable
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sponsor_orgs (
  id                TEXT PRIMARY KEY,
  -- The tenant that owns this sponsor. NOT a foreign key, for the reason at
  -- the top of this file: the organisation model is in process memory.
  org_id            TEXT NOT NULL,
  name              TEXT NOT NULL,
  -- The wallet that signs for this sponsor. Lower-cased on write so the
  -- comparison is exact and never case-dependent.
  wallet_address    TEXT NOT NULL,
  contact_email     TEXT NOT NULL DEFAULT '',
  -- PENDING | APPROVED | ACTIVE | SUSPENDED | COMPLETED
  status            TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','ACTIVE','SUSPENDED','COMPLETED')),
  -- The onboarding steps and whether each one is done.
  onboarding_steps  JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at        BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  approved_at       BIGINT,
  updated_at        BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS sponsor_orgs_org_idx ON sponsor_orgs (org_id);
CREATE INDEX IF NOT EXISTS sponsor_orgs_wallet_idx ON sponsor_orgs (wallet_address);

-- ---------------------------------------------------------------------------
-- Programmes: the columns the domain model has and the table did not
-- ---------------------------------------------------------------------------

ALTER TABLE sponsor_programs
  ADD COLUMN IF NOT EXISTS sponsor_id        TEXT;
ALTER TABLE sponsor_programs
  ADD COLUMN IF NOT EXISTS objectives        TEXT NOT NULL DEFAULT '';
ALTER TABLE sponsor_programs
  ADD COLUMN IF NOT EXISTS suites            JSONB NOT NULL DEFAULT '[]'::JSONB;
ALTER TABLE sponsor_programs
  ADD COLUMN IF NOT EXISTS evaluation_period JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE sponsor_programs
  ADD COLUMN IF NOT EXISTS publication_policy TEXT NOT NULL DEFAULT 'public';
ALTER TABLE sponsor_programs
  ADD COLUMN IF NOT EXISTS dispute_rules     TEXT NOT NULL DEFAULT '';
ALTER TABLE sponsor_programs
  ADD COLUMN IF NOT EXISTS approved_at       BIGINT;
ALTER TABLE sponsor_programs
  ADD COLUMN IF NOT EXISTS launched_at       BIGINT;
ALTER TABLE sponsor_programs
  ADD COLUMN IF NOT EXISTS completed_at      BIGINT;

CREATE INDEX IF NOT EXISTS sponsor_programs_sponsor_idx ON sponsor_programs (sponsor_id);

-- ---------------------------------------------------------------------------
-- Ledger order
-- ---------------------------------------------------------------------------
--
-- A ledger whose entries have no defined order is a ledger you cannot read
-- back. Two movements written in the same millisecond (a deposit writes two
-- entries: `deposited` and `escrowed`) sorted by a random id come out in a
-- random order, and the order changes every run.
--
-- `seq` is the insertion order, assigned by the database. It is what the
-- ledger is read by; `created_at` stays for "when", `seq` for "in what
-- order". A BIGSERIAL is used rather than a timestamp so that two entries
-- written in the same millisecond still have a defined order.

ALTER TABLE budget_entries
  ADD COLUMN IF NOT EXISTS seq BIGSERIAL;

ALTER TABLE sponsor_funding_receipts
  ADD COLUMN IF NOT EXISTS seq BIGSERIAL;

-- ---------------------------------------------------------------------------
-- RLS: the tenant boundary, expressed in the database as well
-- ---------------------------------------------------------------------------
--
-- These policies mirror the ones migration 0009 wrote for `sponsor_programs`.
-- Today they are inert for the API's own writes, because the API connects as
-- the table's owner and PostgreSQL does not apply RLS to the owner — and
-- because `memberships` is as empty as `organisations`. They are written now
-- so that the expression of the rule exists in one place, and so that the day
-- the organisation model becomes durable, the boundary is already there.

ALTER TABLE sponsor_orgs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sponsor_orgs_read ON sponsor_orgs;
CREATE POLICY sponsor_orgs_read
  ON sponsor_orgs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = sponsor_orgs.org_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

DROP POLICY IF EXISTS sponsor_orgs_write ON sponsor_orgs;
CREATE POLICY sponsor_orgs_write
  ON sponsor_orgs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = sponsor_orgs.org_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );
