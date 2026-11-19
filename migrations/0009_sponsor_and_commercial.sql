-- 0009_sponsor_and_commercial.sql — Sponsor programs, budget accounting,
-- commercial tiers, and usage tracking (Phase 5-8).
--
-- Extends the evaluation integrity foundation with commercial operations:
--   * Sponsor programs with 8-state budget accounting.
--   * Budget entry audit trail.
--   * Commercial tier configuration.
--   * Tenant plans and usage tracking.
--
-- All idempotent: runMigrations executes all .sql files in order.

-- ---------------------------------------------------------------------------
-- Sponsor programs: sponsor-funded evaluation programs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sponsor_programs (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','APPROVED','ACTIVE','PAUSED','COMPLETED','CANCELLED','SETTLED','FAILED')),
  budget_cap_wei        TEXT NOT NULL DEFAULT '0',
  committed_wei         TEXT NOT NULL DEFAULT '0',
  deposited_wei         TEXT NOT NULL DEFAULT '0',
  escrowed_wei          TEXT NOT NULL DEFAULT '0',
  allocated_wei         TEXT NOT NULL DEFAULT '0',
  pending_wei           TEXT NOT NULL DEFAULT '0',
  payable_wei           TEXT NOT NULL DEFAULT '0',
  paid_wei              TEXT NOT NULL DEFAULT '0',
  withdrawn_wei         TEXT NOT NULL DEFAULT '0',
  eligibility           JSONB NOT NULL DEFAULT '{}',
  reward_structure      JSONB NOT NULL DEFAULT '{}',
  approval_requirements JSONB NOT NULL DEFAULT '{}',
  created_at            BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at            BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS sponsor_programs_org_id_idx ON sponsor_programs (org_id);
CREATE INDEX IF NOT EXISTS sponsor_programs_status_idx ON sponsor_programs (status);

-- ---------------------------------------------------------------------------
-- Budget entries: audit trail for budget changes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS budget_entries (
  id          TEXT PRIMARY KEY,
  program_id  TEXT NOT NULL REFERENCES sponsor_programs(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  amount_wei  TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS budget_entries_program_id_idx ON budget_entries (program_id);

-- ---------------------------------------------------------------------------
-- Commercial tiers: configurable pricing tiers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commercial_tiers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  pricing         JSONB NOT NULL DEFAULT '{}',
  quotas          JSONB NOT NULL DEFAULT '{}',
  features        JSONB NOT NULL DEFAULT '{}',
  created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

-- ---------------------------------------------------------------------------
-- Tenant plans: per-tenant tier assignment
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_plans (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL UNIQUE,
  tier_id                 TEXT NOT NULL REFERENCES commercial_tiers(id) ON DELETE RESTRICT,
  budget_alert_threshold  INTEGER NOT NULL DEFAULT 80,
  overage_allowed         BOOLEAN NOT NULL DEFAULT false,
  created_at              BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at              BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

-- ---------------------------------------------------------------------------
-- Usage records: per-tenant usage tracking
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS usage_records (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenant_plans(tenant_id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  amount      BIGINT NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS usage_records_tenant_id_idx ON usage_records (tenant_id);
CREATE INDEX IF NOT EXISTS usage_records_category_idx ON usage_records (category);
CREATE INDEX IF NOT EXISTS usage_records_created_at_idx ON usage_records (created_at);

-- ---------------------------------------------------------------------------
-- RLS Policies
-- ---------------------------------------------------------------------------

ALTER TABLE sponsor_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;

-- Sponsor programs: readable by org members
DROP POLICY IF EXISTS sponsor_programs_read ON sponsor_programs;
CREATE POLICY sponsor_programs_read
  ON sponsor_programs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = sponsor_programs.org_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

DROP POLICY IF EXISTS sponsor_programs_write ON sponsor_programs;
CREATE POLICY sponsor_programs_write
  ON sponsor_programs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = sponsor_programs.org_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

-- Budget entries: readable by program org members
DROP POLICY IF EXISTS budget_entries_read ON budget_entries;
CREATE POLICY budget_entries_read
  ON budget_entries FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM sponsor_programs sp
      JOIN memberships m ON m.org_id = sp.org_id
      WHERE sp.id = budget_entries.program_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

-- Commercial tiers: public read
DROP POLICY IF EXISTS commercial_tiers_read ON commercial_tiers;
CREATE POLICY commercial_tiers_read ON commercial_tiers FOR SELECT USING (true);

-- Tenant plans: readable by tenant members
DROP POLICY IF EXISTS tenant_plans_read ON tenant_plans;
CREATE POLICY tenant_plans_read
  ON tenant_plans FOR SELECT
  USING (
    tenant_id = current_setting('crucible.current_tenant_id', true)
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = tenant_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
    )
  );

-- Usage records: readable by tenant members
DROP POLICY IF EXISTS usage_records_read ON usage_records;
CREATE POLICY usage_records_read
  ON usage_records FOR SELECT
  USING (
    tenant_id = current_setting('crucible.current_tenant_id', true)
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = usage_records.tenant_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
    )
  );
