# ADR-0028: Evaluation Integrity Foundation

**Date:** 2026-11-19  
**Status:** Accepted  
**Supersedes:** ADR-0017 (Evaluation Manifest) — extends with full integrity system  
**Related:** ADR-0005 (Deterministic Evidence First), ADR-0004 (Fixed Argus Committee)

## Context

The existing trial system creates evaluations but lacks:
- Versioned benchmark suites with immutable published snapshots
- Machine-readable evaluation specifications
- Independent reproducibility verification
- Multi-dimensional scoring with statistical quality
- Score/reward isolation enforcement

This ADR establishes the foundation for evaluation integrity as the P0 priority, enabling all downstream evaluation work (scoring, replay, disputes) without modifying existing trial infrastructure.

## Decision

### 1. Benchmark Suite Registry in PostgreSQL

Benchmark suites are stored in new PostgreSQL tables (`suites`, `suite_versions`) with versioning. Published suite versions are immutable — changes create new versions, not modifications.

**Rationale:**
- Suites are metadata, not on-chain state. Keeping them in PostgreSQL preserves the contract simplicity established in ADR-0006.
- Versioning matches the trial revision pattern already in use.
- No on-chain suite storage keeps gas costs low and contracts focused on settlement.

### 2. Evaluation Specification as JSON Schema

Each trial execution produces a machine-readable evaluation specification (`evaluation_specs` table) with a `$schema` version field. Published specs are immutable.

**Rationale:**
- JSON Schema enables validation at creation time and machine-readable consumption by external tools.
- The spec captures all inputs: suite version, agent identity, execution environment, judge configuration, scoring methodology.
- Immutability of published specs ensures historical evaluation conditions cannot be rewritten.

### 3. Reproducibility Manifest

Every run captures a reproducibility manifest (`replay_manifests` table) containing all inputs, configurations, and outputs required for independent verification.

**Rationale:**
- The manifest is the single source of truth for reproducibility.
- Three independent replays are required before a result achieves verified status.
- Deterministic vs stochastic methodology distinction prevents incorrect token-identical comparisons.

### 4. Multi-Dimensional Scoring

Five scoring dimensions replace single-score evaluation:
- **CORRECTNESS:** Task completion, output correctness, constraint adherence
- **ROBUSTNESS:** Perturbation resistance, edge-case performance, error recovery
- **SAFETY:** Policy adherence, prompt-injection resistance, unauthorized action prevention
- **EFFICIENCY:** Latency, token consumption, API expenditure, compute usage
- **RELIABILITY:** Completion rate, timeout frequency, error rate, reproducibility

Each dimension has independent rubric versioning and confidence interval calculations.

**Rationale:**
- A single score collapses too much information and hides trade-offs.
- Dimension-specific rubrics enable targeted improvement and fairer comparison.
- Confidence intervals prevent overconfidence from small sample sizes.

### 5. Score/Reward Isolation

The scoring engine (`scoring.ts`) enforces a strict invariant: no financial data may influence scoring. The `assertNoFinancialData()` function rejects any input containing financial keys (reward, budget, wallet, collateral, etc.).

**Rationale:**
- Reward size must never influence grade (directive section 2.2).
- Sponsorship must never influence a judge's verdict.
- Scoring is a pure function of evidence + methodology.

### 6. Adversarial Test Catalogue

Twenty adversarial test categories are defined in the schema (`adversarial_tests` table):
prompt_injection, tool_misuse, privilege_escalation, instruction_hierarchy, malicious_content, data_leakage, secret_exposure, jailbreak, unsafe_code, sandbox_escape, resource_exhaustion, infinite_loop, denial_of_service, self_modification, permission_bypass, context_contamination, evaluation_gaming, benchmark_leakage, agent_collusion, sybil_identity.

**Rationale:**
- Safety and robustness require explicit adversarial testing.
- Each test has documented objective, threat model, expected behavior, detection criteria, and evidence requirements.

## Consequences

### Positive
- Evaluation integrity foundation enables all downstream work (scoring, replay, disputes).
- No dependencies on external services (VRF, mainnet RPC, multisig).
- Builds on existing trial infrastructure without modifying it.
- Carries no financial risk (no money movement).
- Can be fully tested against the existing Anvil setup.

### Negative
- New database tables require migration (idempotent, backward compatible).
- Existing trials without suite versions need a migration strategy.
- Multi-dimensional scoring requires rubric creation for each suite.

### Neutral
- In-memory stores (`suites.ts`, `scoring.ts`) provide immediate functionality; PostgreSQL integration in Phase 2.
- The JSON Schema is version 1.0.0; future versions maintain backward compatibility.

## Implementation

- **Migration:** `migrations/0008_evaluation_integrity.sql` (9 new tables with RLS)
- **Suite registry:** `apps/api/src/suites.ts` (in-memory store, 32 tests)
- **Scoring engine:** `apps/api/src/scoring.ts` (in-memory store, 38 tests)
- **JSON Schema:** `docs/architecture/EVALUATION_SPEC_SCHEMA.json`
- **Tests:** 70 new tests, all passing, no regressions

## Verification

```bash
npm test --workspace @crucible/api -- --run suites.test scoring.test
# 70 tests passed, 0 failed
npm run typecheck --workspace @crucible/api
# 0 errors
```
