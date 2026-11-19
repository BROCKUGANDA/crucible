-- 0008_evaluation_integrity.sql — Benchmark suite registry, evaluation specs,
-- replay manifests, and multi-dimensional scoring (Phase 1-2).
--
-- This migration establishes the foundation for evaluation integrity:
--   * Versioned benchmark suites with immutable published snapshots.
--   * Evaluation specifications as machine-readable JSON Schema.
--   * Replay manifests for independent reproducibility verification.
--   * Multi-dimensional scoring with rubric versioning.
--   * Score/reward isolation (no financial data in scoring tables).
--
-- All idempotent: runMigrations executes all .sql files in order.

-- ---------------------------------------------------------------------------
-- Benchmark suites: the top-level container for evaluation tasks
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS suites (
  id            TEXT PRIMARY KEY,
  org_id        TEXT REFERENCES organisations(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  maintainer    TEXT NOT NULL,
  visibility    TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public','org','private')),
  status        TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PUBLISHED','DEPRECATED','ARCHIVED')),
  created_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT suites_slug_lower CHECK (slug = lower(slug)),
  CONSTRAINT suites_one_per_org_slug UNIQUE (org_id, slug)
);

CREATE INDEX IF NOT EXISTS suites_org_id_idx ON suites (org_id);
CREATE INDEX IF NOT EXISTS suites_visibility_idx ON suites (visibility);
CREATE INDEX IF NOT EXISTS suites_status_idx ON suites (status);

-- ---------------------------------------------------------------------------
-- Suite versions: immutable snapshots of a suite at a point in time
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS suite_versions (
  id                TEXT PRIMARY KEY,
  suite_id          TEXT NOT NULL REFERENCES suites(id) ON DELETE RESTRICT,
  version           TEXT NOT NULL,
  schema_version    INTEGER NOT NULL DEFAULT 1,
  task_families     TEXT[] NOT NULL DEFAULT '{}',
  capability_domains TEXT[] NOT NULL DEFAULT '{}',
  difficulty        TEXT NOT NULL DEFAULT 'unknown'
    CHECK (difficulty IN ('easy','medium','hard','expert','unknown')),
  evaluation_protocol TEXT NOT NULL DEFAULT 'deterministic'
    CHECK (evaluation_protocol IN ('deterministic','stochastic','hybrid')),
  scoring_rules     JSONB NOT NULL DEFAULT '{}'::jsonb,
  test_fixtures     JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_tools    JSONB NOT NULL DEFAULT '[]'::jsonb,
  runtime_constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
  safety_requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
  expected_artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation_rules  JSONB NOT NULL DEFAULT '{}'::jsonb,
  known_limitations TEXT NOT NULL DEFAULT '',
  changelog         TEXT NOT NULL DEFAULT '',
  spec_digest       TEXT NOT NULL,
  published_at      BIGINT,
  created_at        BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT suite_versions_one_per_suite_version UNIQUE (suite_id, version)
);

CREATE INDEX IF NOT EXISTS suite_versions_suite_id_idx ON suite_versions (suite_id);
CREATE INDEX IF NOT EXISTS suite_versions_task_families_idx ON suite_versions USING GIN (task_families);
CREATE INDEX IF NOT EXISTS suite_versions_capability_domains_idx ON suite_versions USING GIN (capability_domains);

-- ---------------------------------------------------------------------------
-- Evaluation specifications: machine-readable spec for a trial execution
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evaluation_specs (
  id                TEXT PRIMARY KEY,
  trial_id          TEXT NOT NULL,
  trial_revision    INTEGER NOT NULL DEFAULT 1,
  suite_version_id  TEXT NOT NULL REFERENCES suite_versions(id) ON DELETE RESTRICT,
  agent_id          TEXT NOT NULL,
  agent_version     TEXT,
  model_id          TEXT,
  provider_config   JSONB NOT NULL DEFAULT '{}'::jsonb,
  execution_environment JSONB NOT NULL DEFAULT '{}'::jsonb,
  runtime_config    JSONB NOT NULL DEFAULT '{}'::jsonb,
  resource_limits   JSONB NOT NULL DEFAULT '{}'::jsonb,
  tool_permissions  JSONB NOT NULL DEFAULT '{}'::jsonb,
  judge_config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  scoring_methodology JSONB NOT NULL DEFAULT '{}'::jsonb,
  repetition_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  randomness_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
  publication_policy TEXT NOT NULL DEFAULT 'private'
    CHECK (publication_policy IN ('private','org','public')),
  dispute_rules     JSONB NOT NULL DEFAULT '{}'::jsonb,
  spec_digest       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PUBLISHED','EXECUTING','COMPLETED','ARCHIVED')),
  created_at        BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at        BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS evaluation_specs_trial_id_idx ON evaluation_specs (trial_id);
CREATE INDEX IF NOT EXISTS evaluation_specs_suite_version_id_idx ON evaluation_specs (suite_version_id);
CREATE INDEX IF NOT EXISTS evaluation_specs_agent_id_idx ON evaluation_specs (agent_id);
CREATE INDEX IF NOT EXISTS evaluation_specs_status_idx ON evaluation_specs (status);

-- ---------------------------------------------------------------------------
-- Replay manifests: capture all inputs for independent reproducibility
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS replay_manifests (
  id                    TEXT PRIMARY KEY,
  evaluation_spec_id    TEXT NOT NULL REFERENCES evaluation_specs(id) ON DELETE RESTRICT,
  run_id                TEXT NOT NULL,
  trial_revision_hash   TEXT NOT NULL,
  suite_version         TEXT NOT NULL,
  input_hashes          JSONB NOT NULL DEFAULT '{}'::jsonb,
  agent_identifier      TEXT NOT NULL,
  agent_build           TEXT NOT NULL,
  model_identifier      TEXT NOT NULL,
  prompt_template_version TEXT,
  tool_versions         JSONB NOT NULL DEFAULT '{}'::jsonb,
  runtime_image_digest  TEXT NOT NULL,
  execution_config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  judge_version         TEXT NOT NULL,
  dependency_versions   JSONB NOT NULL DEFAULT '{}'::jsonb,
  randomness_seed       TEXT,
  randomness_provenance JSONB,
  environment_fingerprint TEXT NOT NULL,
  artifact_hashes       JSONB NOT NULL DEFAULT '{}'::jsonb,
  start_timestamp       BIGINT NOT NULL,
  finish_timestamp      BIGINT NOT NULL,
  worker_identity       TEXT NOT NULL,
  execution_trace_refs  JSONB NOT NULL DEFAULT '[]'::jsonb,
  manifest_digest       TEXT NOT NULL,
  replay_status         TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (replay_status IN ('PENDING','REPRODUCIBLE','FAILED','INCONCLUSIVE','REVIEW_REQUIRED')),
  replay_count          INTEGER NOT NULL DEFAULT 0,
  replay_agreement      BOOLEAN,
  created_at            BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS replay_manifests_evaluation_spec_id_idx ON replay_manifests (evaluation_spec_id);
CREATE INDEX IF NOT EXISTS replay_manifests_run_id_idx ON replay_manifests (run_id);
CREATE INDEX IF NOT EXISTS replay_manifests_replay_status_idx ON replay_manifests (replay_status);

-- ---------------------------------------------------------------------------
-- Individual replay records for the three-replay system
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS replay_records (
  id                    TEXT PRIMARY KEY,
  manifest_id           TEXT NOT NULL REFERENCES replay_manifests(id) ON DELETE CASCADE,
  replay_number         INTEGER NOT NULL CHECK (replay_number >= 1 AND replay_number <= 3),
  worker_identity       TEXT NOT NULL,
  start_timestamp       BIGINT NOT NULL,
  finish_timestamp      BIGINT NOT NULL,
  output_hash           TEXT NOT NULL,
  execution_trace_ref   TEXT,
  status                TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','SKIPPED')),
  error_detail          TEXT,
  created_at            BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT replay_records_one_per_manifest_number UNIQUE (manifest_id, replay_number)
);

CREATE INDEX IF NOT EXISTS replay_records_manifest_id_idx ON replay_records (manifest_id);

-- ---------------------------------------------------------------------------
-- Multi-dimensional scoring: rubrics and dimension-specific scores
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rubrics (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  dimensions    JSONB NOT NULL,
  version       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','ACTIVE','DEPRECATED')),
  created_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT rubrics_one_per_name_version UNIQUE (name, version)
);

CREATE INDEX IF NOT EXISTS rubrics_name_idx ON rubrics (name);
CREATE INDEX IF NOT EXISTS rubrics_status_idx ON rubrics (status);

-- ---------------------------------------------------------------------------
-- Score dimensions: individual dimension scores per run
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS score_dimensions (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  rubric_id         TEXT NOT NULL REFERENCES rubrics(id) ON DELETE RESTRICT,
  dimension         TEXT NOT NULL
    CHECK (dimension IN ('CORRECTNESS','ROBUSTNESS','SAFETY','EFFICIENCY','RELIABILITY')),
  score             NUMERIC(5,4) NOT NULL CHECK (score >= 0 AND score <= 1),
  weight            NUMERIC(5,4) NOT NULL DEFAULT 0.2 CHECK (weight >= 0 AND weight <= 1),
  evidence          JSONB NOT NULL DEFAULT '{}'::jsonb,
  methodology       TEXT NOT NULL,
  sample_count      INTEGER NOT NULL DEFAULT 1,
  confidence_lower  NUMERIC(5,4),
  confidence_upper  NUMERIC(5,4),
  variance          NUMERIC(10,8),
  judge_id          TEXT,
  judge_decision    TEXT,
  created_at        BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT score_dimensions_one_per_run_dimension UNIQUE (run_id, dimension)
);

CREATE INDEX IF NOT EXISTS score_dimensions_run_id_idx ON score_dimensions (run_id);
CREATE INDEX IF NOT EXISTS score_dimensions_rubric_id_idx ON score_dimensions (rubric_id);
CREATE INDEX IF NOT EXISTS score_dimensions_dimension_idx ON score_dimensions (dimension);

-- ---------------------------------------------------------------------------
-- Aggregate scores: weighted combination of dimension scores
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS aggregate_scores (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  rubric_id         TEXT NOT NULL REFERENCES rubrics(id) ON DELETE RESTRICT,
  score             NUMERIC(5,4) NOT NULL CHECK (score >= 0 AND score <= 1),
  dimension_scores  JSONB NOT NULL,
  methodology       TEXT NOT NULL,
  confidence_lower  NUMERIC(5,4),
  confidence_upper  NUMERIC(5,4),
  sample_count      INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'PROVISIONAL'
    CHECK (status IN ('PROVISIONAL','VERIFIED','DISPUTED','REVOKED')),
  created_at        BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at        BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT aggregate_scores_one_per_run UNIQUE (run_id)
);

CREATE INDEX IF NOT EXISTS aggregate_scores_run_id_idx ON aggregate_scores (run_id);
CREATE INDEX IF NOT EXISTS aggregate_scores_status_idx ON aggregate_scores (status);

-- ---------------------------------------------------------------------------
-- Adversarial test catalogue: tests for safety and robustness
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS adversarial_tests (
  id                TEXT PRIMARY KEY,
  suite_version_id  TEXT NOT NULL REFERENCES suite_versions(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  category          TEXT NOT NULL
    CHECK (category IN ('prompt_injection','tool_misuse','privilege_escalation',
      'instruction_hierarchy','malicious_content','data_leakage','secret_exposure',
      'jailbreak','unsafe_code','sandbox_escape','resource_exhaustion',
      'infinite_loop','denial_of_service','self_modification','permission_bypass',
      'context_contamination','evaluation_gaming','benchmark_leakage',
      'agent_collusion','sybil_identity','other')),
  objective         TEXT NOT NULL,
  threat_model      TEXT NOT NULL,
  expected_behavior TEXT NOT NULL,
  detection_criteria JSONB NOT NULL,
  evidence_requirements JSONB NOT NULL,
  test_config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  severity          TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low','medium','high','critical')),
  created_at        BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  CONSTRAINT adversarial_tests_one_per_suite_name UNIQUE (suite_version_id, name)
);

CREATE INDEX IF NOT EXISTS adversarial_tests_suite_version_id_idx ON adversarial_tests (suite_version_id);
CREATE INDEX IF NOT EXISTS adversarial_tests_category_idx ON adversarial_tests (category);

-- ---------------------------------------------------------------------------
-- Row-level security: tenant isolation for suite tables
-- ---------------------------------------------------------------------------

ALTER TABLE suites ENABLE ROW LEVEL SECURITY;
ALTER TABLE suite_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE replay_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE replay_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE rubrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE score_dimensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aggregate_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE adversarial_tests ENABLE ROW LEVEL SECURITY;

-- Suites: public suites readable by all, org/private suites restricted.
DROP POLICY IF EXISTS suites_public_read ON suites;
CREATE POLICY suites_public_read
  ON suites FOR SELECT
  USING (visibility = 'public');

DROP POLICY IF EXISTS suites_org_member_read ON suites;
CREATE POLICY suites_org_member_read
  ON suites FOR SELECT
  USING (
    visibility IN ('org','public')
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = suites.org_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

DROP POLICY IF EXISTS suites_owner_write ON suites;
CREATE POLICY suites_owner_write
  ON suites FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = suites.org_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.role IN ('org.owner', 'org.admin')
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.org_id = suites.org_id
        AND m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.role IN ('org.owner', 'org.admin')
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

-- Suite versions: readable by suite readers, writable by suite owners.
DROP POLICY IF EXISTS suite_versions_read ON suite_versions;
CREATE POLICY suite_versions_read
  ON suite_versions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM suites s
      WHERE s.id = suite_versions.suite_id
        AND (
          s.visibility = 'public'
          OR (
            s.visibility IN ('org','private')
            AND EXISTS (
              SELECT 1 FROM memberships m
              WHERE m.org_id = s.org_id
                AND m.principal_id = current_setting('crucible.current_principal_id', true)
                AND m.revoked_at IS NULL
                AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
            )
          )
        )
    )
  );

DROP POLICY IF EXISTS suite_versions_write ON suite_versions;
CREATE POLICY suite_versions_write
  ON suite_versions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM suites s
      WHERE s.id = suite_versions.suite_id
        AND EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.org_id = s.org_id
            AND m.principal_id = current_setting('crucible.current_principal_id', true)
            AND m.role IN ('org.owner', 'org.admin')
            AND m.revoked_at IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM suites s
      WHERE s.id = suite_versions.suite_id
        AND EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.org_id = s.org_id
            AND m.principal_id = current_setting('crucible.current_principal_id', true)
            AND m.role IN ('org.owner', 'org.admin')
            AND m.revoked_at IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
        )
    )
  );

-- Evaluation specs: readable by org members, writable by org owners.
DROP POLICY IF EXISTS evaluation_specs_read ON evaluation_specs;
CREATE POLICY evaluation_specs_read
  ON evaluation_specs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM evaluation_specs es
      JOIN suite_versions sv ON sv.id = es.suite_version_id
      JOIN suites s ON s.id = sv.suite_id
      WHERE es.id = evaluation_specs.id
        AND (
          s.visibility = 'public'
          OR (
            s.visibility IN ('org','private')
            AND EXISTS (
              SELECT 1 FROM memberships m
              WHERE m.org_id = s.org_id
                AND m.principal_id = current_setting('crucible.current_principal_id', true)
                AND m.revoked_at IS NULL
                AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
            )
          )
        )
    )
  );

DROP POLICY IF EXISTS evaluation_specs_write ON evaluation_specs;
CREATE POLICY evaluation_specs_write
  ON evaluation_specs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM evaluation_specs es
      JOIN suite_versions sv ON sv.id = es.suite_version_id
      JOIN suites s ON s.id = sv.suite_id
      WHERE es.id = evaluation_specs.id
        AND EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.org_id = s.org_id
            AND m.principal_id = current_setting('crucible.current_principal_id', true)
            AND m.role IN ('org.owner', 'org.admin')
            AND m.revoked_at IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM evaluation_specs es
      JOIN suite_versions sv ON sv.id = es.suite_version_id
      JOIN suites s ON s.id = sv.suite_id
      WHERE es.id = evaluation_specs.id
        AND EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.org_id = s.org_id
            AND m.principal_id = current_setting('crucible.current_principal_id', true)
            AND m.role IN ('org.owner', 'org.admin')
            AND m.revoked_at IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
        )
    )
  );

-- Replay manifests and records: readable by org members.
DROP POLICY IF EXISTS replay_manifests_read ON replay_manifests;
CREATE POLICY replay_manifests_read
  ON replay_manifests FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM evaluation_specs es
      WHERE es.id = replay_manifests.evaluation_spec_id
        AND es.id IN (
          SELECT id FROM evaluation_specs
          WHERE publication_policy = 'public'
          OR publication_policy IN ('org','private')
            AND EXISTS (
              SELECT 1 FROM suite_versions sv
              JOIN suites s ON s.id = sv.suite_id
              WHERE sv.id = evaluation_specs.suite_version_id
                AND EXISTS (
                  SELECT 1 FROM memberships m
                  WHERE m.org_id = s.org_id
                    AND m.principal_id = current_setting('crucible.current_principal_id', true)
                    AND m.revoked_at IS NULL
                    AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
                )
            )
        )
    )
  );

DROP POLICY IF EXISTS replay_records_read ON replay_records;
CREATE POLICY replay_records_read
  ON replay_records FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM replay_manifests rm
      WHERE rm.id = replay_records.manifest_id
        AND rm.id IN (SELECT id FROM replay_manifests)
    )
  );

-- Rubrics: public read, org write.
DROP POLICY IF EXISTS rubrics_read ON rubrics;
CREATE POLICY rubrics_read ON rubrics FOR SELECT USING (true);

DROP POLICY IF EXISTS rubrics_write ON rubrics;
CREATE POLICY rubrics_write
  ON rubrics FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.role IN ('org.owner', 'org.admin')
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.principal_id = current_setting('crucible.current_principal_id', true)
        AND m.role IN ('org.owner', 'org.admin')
        AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  );

-- Score dimensions and aggregate scores: readable by org members.
DROP POLICY IF EXISTS score_dimensions_read ON score_dimensions;
CREATE POLICY score_dimensions_read
  ON score_dimensions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM runs r
      WHERE r.run_id = score_dimensions.run_id
        AND (
          r.org_id IS NULL
          OR EXISTS (
            SELECT 1 FROM memberships m
            WHERE m.org_id = r.org_id
              AND m.principal_id = current_setting('crucible.current_principal_id', true)
              AND m.revoked_at IS NULL
              AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
          )
        )
    )
  );

DROP POLICY IF EXISTS aggregate_scores_read ON aggregate_scores;
CREATE POLICY aggregate_scores_read
  ON aggregate_scores FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM runs r
      WHERE r.run_id = aggregate_scores.run_id
        AND (
          r.org_id IS NULL
          OR EXISTS (
            SELECT 1 FROM memberships m
            WHERE m.org_id = r.org_id
              AND m.principal_id = current_setting('crucible.current_principal_id', true)
              AND m.revoked_at IS NULL
              AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
          )
        )
    )
  );

-- Adversarial tests: readable by suite readers.
DROP POLICY IF EXISTS adversarial_tests_read ON adversarial_tests;
CREATE POLICY adversarial_tests_read
  ON adversarial_tests FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM suite_versions sv
      JOIN suites s ON s.id = sv.suite_id
      WHERE sv.id = adversarial_tests.suite_version_id
        AND (
          s.visibility = 'public'
          OR (
            s.visibility IN ('org','private')
            AND EXISTS (
              SELECT 1 FROM memberships m
              WHERE m.org_id = s.org_id
                AND m.principal_id = current_setting('crucible.current_principal_id', true)
                AND m.revoked_at IS NULL
                AND (m.expires_at IS NULL OR m.expires_at > EXTRACT(EPOCH FROM NOW()) * 1000)
            )
          )
        )
    )
  );
