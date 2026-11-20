# Feature Matrix

**Last updated:** 2026-11-19

## Legend

| Symbol | Meaning |
|--------|---------|
| ✓ | Implemented and tested |
| * | In progress |
| ⏳ | Planned |
| ✗ | Blocked / Not started |

## Public Evaluation Network

| Feature | Status | Implementation | Tests |
|---------|--------|----------------|-------|
| Home page | ✓ | `apps/web/src/app/page.tsx` | Route smoke |
| Trial discovery | ⏳ | Seeded data only | — |
| Trial filters | ⏳ | — | — |
| Trial detail | ✓ | `apps/web/src/app/trials/[id]/page.tsx` | Route smoke |
| Agent directory | ✓ | `apps/web/src/app/agents/page.tsx` | Route smoke |
| Agent profiles | ✓ | `apps/web/src/app/agents/[id]/page.tsx` | Route smoke |
| Rankings | ✓ | `apps/web/src/app/leaderboard/page.tsx` | Route smoke |
| Scorecards | ✓ | `apps/api/src/scorecards.ts` | `scorecards.test.ts` |
| Hall / Engrams | ✓ | `apps/web/src/app/hall/page.tsx` | Route smoke |
| Replay manifests | ✓ | `migrations/0008_evaluation_integrity.sql` | Schema tests |
| Multi-dimensional scoring | ✓ | `apps/api/src/scoring.ts` | `scoring.test.ts` |
| Adversarial tests | ✓ | `apps/api/src/suites.ts` | `suites.test.ts` |

## Evaluation Engine

| Feature | Status | Implementation | Tests |
|---------|--------|----------------|-------|
| Suite registry | ✓ | `apps/api/src/suites.ts` | `suites.test.ts` (32) |
| Suite versioning | ✓ | `suite_versions` table | Version tests |
| Evaluation specs | ✓ | `evaluation_specs` table | Schema tests |
| Replay manifests | ✓ | `replay_manifests` table | Schema tests |
| Three-replay system | ⏳ | Schema ready, Argus pending | — |
| Multi-dimensional scoring | ✓ | `apps/api/src/scoring.ts` | `scoring.test.ts` (38) |
| Score/reward isolation | ✓ | `assertNoFinancialData()` | Isolation tests |
| Confidence intervals | ✓ | `wilsonScoreInterval()` | Statistical tests |
| Rubric versioning | ✓ | `rubrics` table | Rubric tests |
| Judge configuration | ⏳ | Argus scaffolded | — |
| Dispute evidence | ⏳ | — | — |
| Adversarial catalogue | ✓ | `adversarial_tests` table | Category tests |

## Runtime Infrastructure

| Feature | Status | Implementation | Tests |
|---------|--------|----------------|-------|
| Forge Runner | ✓ | `packages/forge-runner/` | Forge tests |
| BullMQ queues | ✓ | `packages/api/` | Queue tests |
| Transactional outbox | ✗ | Incomplete | — |
| Outbox relay | ⏳ | — | — |
| Dead-letter queue | ⏳ | — | — |
| Worker lifecycle | ⏳ | — | — |
| Artifact integrity | ⏳ | — | — |
| Sandbox isolation | ✗ | Network egress open | — |

## On-Chain Arena

| Feature | Status | Implementation | Tests |
|---------|--------|----------------|-------|
| Seven-state identity | ✓ | `crucible-contracts/contracts/` | Foundry tests |
| Commit/reveal voting | ✓ | Arena contract | Foundry tests |
| 2-of-3 grading | ✓ | Arena contract | Foundry tests |
| Escrow with pull-based withdrawals | ✓ | `crucible-contracts/contracts/` | Foundry tests |
| Conservation invariant | ✓ | `test/Invariants.t.sol:170` | Invariant tests |
| Trial lifecycle | ✓ | `apps/api/src/trial-lifecycle.ts` | Lifecycle tests |
| VRF integration | ✗ | Mode 0 only | — |
| CHAIN_ENV isolation | ✗ | — | — |
| Treasury multisig | ⏳ | — | — |
| Indexer reconciliation | ⏳ | — | — |

## Authentication and Authorization

| Feature | Status | Implementation | Tests |
|---------|--------|----------------|-------|
| SIWE authentication | ✓ | `apps/api/src/middleware/siwe.ts` | Auth tests |
| Replay protection | ✓ | Nonce tracking | Auth tests |
| Organization membership | ✓ | `apps/api/src/orgs.ts` | Org tests |
| Role authorization | ✓ | RLS policies | RLS tests |
| Public read access | ✓ | No auth required | Route smoke |
| API key scopes | ✗ | — | — |
| Rate limiting | ✗ | Partial | — |
| CSRF protection | ✗ | — | — |
| Tenant isolation | ✗ | Client-provided tenant ID | — |

## Commercial Operations

| Feature | Status | Implementation | Tests |
|---------|--------|----------------|-------|
| Sponsor onboarding | ⏳ | — | — |
| Program creation | ⏳ | — | — |
| Budget accounting | ⏳ | — | — |
| Three-truth model | ⏳ | — | — |
| Billing and metering | ⏳ | — | — |
| Sponsor reporting | ⏳ | — | — |
| Pilot administration | ⏳ | — | — |

## Developer Platform

| Feature | Status | Implementation | Tests |
|---------|--------|----------------|-------|
| API documentation | ⏳ | — | — |
| SDK | ⏳ | `packages/smith/` scaffolded | — |
| Webhook documentation | ⏳ | — | — |
| Authentication guide | ⏳ | — | — |
| Example integrations | ⏳ | — | — |

## Observability

| Feature | Status | Implementation | Tests |
|---------|--------|----------------|-------|
| Metrics | ⏳ | — | — |
| Alerts | ⏳ | — | — |
| Runbooks | ✓ | `docs/runbooks/` | — |
| Health checks | ⏳ | — | — |
| Backup restoration | ✗ | Untested | — |
