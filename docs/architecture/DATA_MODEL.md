# Data Model

**Last updated:** 2026-11-19

## Overview

Crucible uses PostgreSQL with Row-Level Security (RLS) for tenant isolation. All timestamps are Unix milliseconds. All monetary values use integer arithmetic (wei), never JavaScript floats.

## Core Entities

### Organisations (migrations/0002_organisations.sql)

```sql
organisations
├── id (TEXT PK)
├── name (TEXT)
├── slug (TEXT, unique, lowercase)
├── created_at (BIGINT)
└── updated_at (BIGINT)

memberships
├── id (TEXT PK)
├── org_id (TEXT → organisations.id)
├── principal_id (TEXT)
├── role (TEXT: org.owner, org.admin, org.member)
├── revoked_at (BIGINT, nullable)
├── expires_at (BIGINT, nullable)
└── created_at (BIGINT)
```

### Evaluation Integrity (migrations/0008_evaluation_integrity.sql)

```sql
suites
├── id (TEXT PK)
├── org_id (TEXT → organisations.id)
├── name (TEXT)
├── slug (TEXT, unique per org)
├── description (TEXT)
├── maintainer (TEXT)
├── visibility (TEXT: public, org, private)
├── status (TEXT: DRAFT, PUBLISHED, DEPRECATED, ARCHIVED)
├── created_at (BIGINT)
└── updated_at (BIGINT)

suite_versions
├── id (TEXT PK)
├── suite_id (TEXT → suites.id, RESTRICT)
├── version (TEXT, unique per suite)
├── schema_version (INTEGER)
├── task_families (TEXT[])
├── capability_domains (TEXT[])
├── difficulty (TEXT: easy, medium, hard, expert, unknown)
├── evaluation_protocol (TEXT: deterministic, stochastic, hybrid)
├── scoring_rules (JSONB)
├── test_fixtures (JSONB)
├── required_tools (JSONB)
├── runtime_constraints (JSONB)
├── safety_requirements (JSONB)
├── expected_artifacts (JSONB)
├── validation_rules (JSONB)
├── known_limitations (TEXT)
├── changelog (TEXT)
├── spec_digest (TEXT, SHA-256)
├── published_at (BIGINT, nullable)
└── created_at (BIGINT)

evaluation_specs
├── id (TEXT PK)
├── trial_id (TEXT)
├── trial_revision (INTEGER)
├── suite_version_id (TEXT → suite_versions.id, RESTRICT)
├── agent_id (TEXT)
├── agent_version (TEXT)
├── model_id (TEXT)
├── provider_config (JSONB)
├── execution_environment (JSONB)
├── runtime_config (JSONB)
├── resource_limits (JSONB)
├── tool_permissions (JSONB)
├── judge_config (JSONB)
├── scoring_methodology (JSONB)
├── repetition_policy (JSONB)
├── randomness_config (JSONB)
├── evidence_requirements (JSONB)
├── publication_policy (TEXT: private, org, public)
├── dispute_rules (JSONB)
├── spec_digest (TEXT, SHA-256)
├── status (TEXT: DRAFT, PUBLISHED, EXECUTING, COMPLETED, ARCHIVED)
├── created_at (BIGINT)
└── updated_at (BIGINT)

replay_manifests
├── id (TEXT PK)
├── evaluation_spec_id (TEXT → evaluation_specs.id, RESTRICT)
├── run_id (TEXT)
├── trial_revision_hash (TEXT)
├── suite_version (TEXT)
├── input_hashes (JSONB)
├── agent_identifier (TEXT)
├── agent_build (TEXT)
├── model_identifier (TEXT)
├── prompt_template_version (TEXT)
├── tool_versions (JSONB)
├── runtime_image_digest (TEXT)
├── execution_config (JSONB)
├── judge_version (TEXT)
├── dependency_versions (JSONB)
├── randomness_seed (TEXT)
├── randomness_provenance (JSONB)
├── environment_fingerprint (TEXT)
├── artifact_hashes (JSONB)
├── start_timestamp (BIGINT)
├── finish_timestamp (BIGINT)
├── worker_identity (TEXT)
├── execution_trace_refs (JSONB)
├── manifest_digest (TEXT, SHA-256)
├── replay_status (TEXT: PENDING, REPRODUCIBLE, FAILED, INCONCLUSIVE, REVIEW_REQUIRED)
├── replay_count (INTEGER)
├── replay_agreement (BOOLEAN)
└── created_at (BIGINT)

replay_records
├── id (TEXT PK)
├── manifest_id (TEXT → replay_manifests.id, CASCADE)
├── replay_number (INTEGER, 1-3, unique per manifest)
├── worker_identity (TEXT)
├── start_timestamp (BIGINT)
├── finish_timestamp (BIGINT)
├── output_hash (TEXT)
├── execution_trace_ref (TEXT)
├── status (TEXT: PENDING, RUNNING, COMPLETED, FAILED, SKIPPED)
├── error_detail (TEXT)
└── created_at (BIGINT)

rubrics
├── id (TEXT PK)
├── name (TEXT)
├── description (TEXT)
├── dimensions (JSONB)
├── version (TEXT, unique per name)
├── status (TEXT: DRAFT, ACTIVE, DEPRECATED)
└── created_at (BIGINT)

score_dimensions
├── id (TEXT PK)
├── run_id (TEXT, unique per dimension)
├── rubric_id (TEXT → rubrics.id, RESTRICT)
├── dimension (TEXT: CORRECTNESS, ROBUSTNESS, SAFETY, EFFICIENCY, RELIABILITY)
├── score (NUMERIC(5,4), 0-1)
├── weight (NUMERIC(5,4), 0-1)
├── evidence (JSONB)
├── methodology (TEXT)
├── sample_count (INTEGER)
├── confidence_lower (NUMERIC(5,4))
├── confidence_upper (NUMERIC(5,4))
├── variance (NUMERIC(10,8))
├── judge_id (TEXT)
├── judge_decision (TEXT)
└── created_at (BIGINT)

aggregate_scores
├── id (TEXT PK)
├── run_id (TEXT, unique)
├── rubric_id (TEXT → rubrics.id, RESTRICT)
├── score (NUMERIC(5,4), 0-1)
├── dimension_scores (JSONB)
├── methodology (TEXT)
├── confidence_lower (NUMERIC(5,4))
├── confidence_upper (NUMERIC(5,4))
├── sample_count (INTEGER)
├── status (TEXT: PROVISIONAL, VERIFIED, DISPUTED, REVOKED)
├── created_at (BIGINT)
└── updated_at (BIGINT)

adversarial_tests
├── id (TEXT PK)
├── suite_version_id (TEXT → suite_versions.id, CASCADE)
├── name (TEXT, unique per suite version)
├── category (TEXT: 20 categories)
├── objective (TEXT)
├── threat_model (TEXT)
├── expected_behavior (TEXT)
├── detection_criteria (JSONB)
├── evidence_requirements (JSONB)
├── test_config (JSONB)
├── severity (TEXT: low, medium, high, critical)
└── created_at (BIGINT)
```

### Runtime (migrations/0003_runtime_and_rewards.sql)

```sql
runs
├── id (TEXT PK)
├── trial_id (TEXT)
├── agent_id (TEXT)
├── status (TEXT)
├── started_at (BIGINT)
├── finished_at (BIGINT)
└── ...

forge_watch_outbox
├── id (TEXT PK)
├── run_id (TEXT)
├── event (JSONB)
├── delivered_at (BIGINT, nullable)
└── ...
```

## Row-Level Security

All tables enable RLS. Policies follow the pattern:
- **Public read:** `visibility = 'public'`
- **Org member read:** Membership check with role and expiration
- **Owner write:** `role IN ('org.owner', 'org.admin')` with membership check

## Migration Strategy

- All migrations are idempotent (`CREATE TABLE IF NOT EXISTS`)
- Migrations execute in order (0001 → 0008)
- No migration deletes historical data
- Backward-compatible where possible
