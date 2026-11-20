# Release Evidence

**Last updated:** 2026-11-19

## Overview

This document records the evidence for each release, including test results, verification commands, and gate status.

## Phase 1: Evaluation Integrity Foundation

### Test Results

```bash
npm test --workspace @crucible/api -- --run suites.test scoring.test
# 70 tests passed, 0 failed
npm run typecheck --workspace @crucible/api
# 0 errors
npm test --workspace @crible/api -- --run
# 866 tests passed, 6 skipped (PostgreSQL not available)
```

### Files Created

| File | Purpose |
|------|---------|
| `migrations/0008_evaluation_integrity.sql` | 9 new tables with RLS |
| `apps/api/src/suites.ts` | Suite registry module |
| `apps/api/src/scoring.ts` | Multi-dimensional scoring engine |
| `apps/api/test/suites.test.ts` | 32 suite tests |
| `apps/api/test/scoring.test.ts` | 38 scoring tests |
| `docs/architecture/EVALUATION_SPEC_SCHEMA.json` | JSON Schema v1.0.0 |
| `docs/adr/0028-evaluation-integrity-foundation.md` | ADR for evaluation integrity |
| `docs/architecture/IMPLEMENTATION_REGISTER.md` | Living implementation register |

### Gate Status

| Gate | Status | Evidence |
|------|--------|----------|
| Gate A (Repository integrity) | ✓ | 866 tests pass, typecheck clean |
| Gate B (Auth/authz) | ⏳ | Not modified in this phase |
| Gate C (Money safety) | ⏳ | Not modified in this phase |
| Gate D (Runtime integrity) | ⏳ | Not modified in this phase |
| Gate E (Evaluation integrity) | ✓ | Suite registry, scoring, isolation tests |
| Gate F (Randomness) | ⏳ | Not modified in this phase |
| Gate G (Infrastructure) | ⏳ | Not modified in this phase |
| Gate H (Contract deployment) | ⏳ | Not modified in this phase |
| Gate I (Operational readiness) | ⏳ | Not modified in this phase |
| Gate J (Mainnet preflight) | ⏳ | Not modified in this phase |

### Regression Protection

- All 796 existing tests continue to pass
- No modifications to existing contracts
- No modifications to existing trial infrastructure
- Score/reward isolation tested: financial data injection correctly throws

### Invariants Verified

| Invariant | Status |
|-----------|--------|
| Conservation | ✓ Not modified |
| Pull-based settlement | ✓ Not modified |
| FEE_BPS = 500 | ✓ Not modified |
| Score/reward isolation | ✓ New tests added |
