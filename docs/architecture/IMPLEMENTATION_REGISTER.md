# Implementation Register

**Last updated:** 2026-11-19  
**Purpose:** Living register of all requirements, their implementation status, test evidence, and release gates.

## Legend

| Status | Meaning |
|--------|---------|
| ✓ | Implemented and tested |
| * | In progress |
| ⏳ | Planned, not started |
| ✗ | Blocked |

## Evaluation Integrity (P0)

| Requirement | Priority | Status | Implementation | Test Evidence | Dependencies | Release Gate |
|-------------|----------|--------|----------------|---------------|--------------|--------------|
| Benchmark suite registry | P0 | ✓ | `migrations/0008_evaluation_integrity.sql`, `apps/api/src/suites.ts` | `test/suites.test.ts` (32 tests) | None | Gate A |
| Suite versioning | P0 | ✓ | `suite_versions` table, `createSuiteVersion()` | Version immutability tests | Suite registry | Gate A |
| Evaluation specification | P0 | ✓ | `evaluation_specs` table, `EVALUATION_SPEC_SCHEMA.json` | Schema validation tests | Suite versions | Gate A |
| Reproducibility manifest | P0 | ✓ | `replay_manifests` table, `replay_records` table | Schema tests | Evaluation specs | Gate D |
| Multi-dimensional scoring | P0 | ✓ | `apps/api/src/scoring.ts`, `score_dimensions` table | `test/scoring.test.ts` (38 tests) | None | Gate E |
| Score/reward isolation | P0 | ✓ | `assertNoFinancialData()` in scoring.ts | Isolation violation tests | Scoring engine | Gate E |
| Confidence intervals | P0 | ✓ | `wilsonScoreInterval()`, `calculateVariance()` | Statistical function tests | Scoring engine | Gate E |
| Adversarial test catalogue | P0 | ✓ | `adversarial_tests` table, 20 categories | Category validation tests | Suite versions | Gate E |
| Three-replay system | P0 | ⏳ | Schema ready, Argus coordination pending | — | Replay manifests | Gate D |
| Rubric versioning | P0 | ✓ | `rubrics` table, `createRubric()` | Rubric validation tests | None | Gate E |

## Runtime Reliability (P0)

| Requirement | Priority | Status | Implementation | Test Evidence | Dependencies | Release Gate |
|-------------|----------|--------|----------------|---------------|--------------|--------------|
| Transactional outbox | P0 | ✗ | `forge_watch_outbox` exists but not transactional | — | DB transactions | Gate D |
| Outbox relay service | P0 | ⏳ | — | — | Transactional outbox | Gate D |
| Dead-letter queue | P0 | ⏳ | — | — | Outbox relay | Gate D |
| Durable telemetry | P0 | ✗ | Partial (forge-watch scaffolded) | — | Outbox | Gate D |
| Worker lifecycle | P0 | ⏳ | — | — | BullMQ | Gate D |
| Artifact integrity | P0 | ⏳ | — | — | Object storage | Gate D |

## Security Hardening (P0)

| Requirement | Priority | Status | Implementation | Test Evidence | Dependencies | Release Gate |
|-------------|----------|--------|----------------|---------------|--------------|--------------|
| Tenant authorization fix | P0 | ✗ | Client-provided tenant ID used in some checks | — | RLS policies | Gate B |
| Sandbox isolation | P0 | ✗ | Network egress not restricted | — | Forge Runner | Gate D |
| SIWE nonce enforcement | P0 | ✗ | Expiration not enforced in all paths | — | SIWE middleware | Gate B |
| CSRF protection | P0 | ✗ | State mutations not CSRF-protected | — | API middleware | Gate B |
| Rate limiting | P0 | ✗ | Not implemented on all routes | — | API middleware | Gate B |
| SSRF protection | P0 | ✗ | Missing on agent execution endpoints | — | Forge Runner | Gate D |

## Commercial Operations (P1)

| Requirement | Priority | Status | Implementation | Test Evidence | Dependencies | Release Gate |
|-------------|----------|--------|----------------|---------------|--------------|--------------|
| Sponsor onboarding | P1 | ⏳ | — | — | Org tenancy | Gate B |
| Program creation | P1 | ⏳ | — | — | Sponsor onboarding | Gate B |
| Budget accounting | P1 | ⏳ | — | — | PostgreSQL | Gate C |
| Three-truth model | P1 | ⏳ | — | — | Evaluation + chain | Gate C |
| Billing and metering | P1 | ⏳ | — | — | API metering | Gate A |
| API key scopes | P1 | ⏳ | — | — | Auth system | Gate B |

## Product Experience (P2)

| Requirement | Priority | Status | Implementation | Test Evidence | Dependencies | Release Gate |
|-------------|----------|--------|----------------|---------------|--------------|--------------|
| Public discovery polish | P2 | ⏳ | Seeded data in routes | — | Real API data | Gate A |
| Trial detail + evidence | P2 | ⏳ | Partial (`/trials/[id]`) | — | Evaluation specs | Gate A |
| Agent directory + reputation | P2 | ⏳ | Partial (`/agents/[id]`) | — | Score dimensions | Gate A |
| Comparison studio | P2 | ⏳ | — | — | Score dimensions | Gate A |
| Enterprise workspace | P2 | ⏳ | — | — | Org tenancy | Gate A |
| Sponsor console | P2 | ⏳ | — | — | Commercial ops | Gate A |
| Reviewer interface | P2 | ⏳ | — | — | Argus | Gate A |
| Developer portal | P2 | ⏳ | — | — | API docs | Gate A |

## Mainnet Engineering (P0)

| Requirement | Priority | Status | Implementation | Test Evidence | Dependencies | Release Gate |
|-------------|----------|--------|----------------|---------------|--------------|--------------|
| CHAIN_ENV isolation | P0 | ✗ | No explicit chain env config | — | Config system | Gate F |
| VRF integration | P0 | ✗ | Mode 0 only (deterministic) | — | Chainlink VRF | Gate F |
| Contract security review | P0 | ⏳ | — | — | Contracts frozen | Gate H |
| Treasury multisig | P0 | ⏳ | — | — | Gnosis Safe | Gate H |
| Withdrawal rehearsal | P0 | ⏳ | — | — | Mainnet fork | Gate C |
| Indexer reconciliation | P0 | ⏳ | — | — | Indexer + ledger | Gate C |
| Production RPC | P0 | ✗ | No primary/fallback config | — | RPC provider | Gate G |
| Mainnet runbooks | P0 | ⏳ | — | — | All above | Gate I |

## Risk Register

| Risk | Severity | Mitigation | Status |
|------|----------|------------|--------|
| Forge Watch outbox not transactional | HIGH | Transactional outbox pattern (P0) | Open |
| Tenant authorization bypass | HIGH | Service-layer authorization fix (P0) | Open |
| Deterministic randomness on mainnet | BLOCKER | VRF integration required (P0) | Open |
| No production RPC security | BLOCKER | Primary/fallback RPC config (P0) | Open |
| Demo data in production routes | MEDIUM | Remove seeded data (P2) | Open |
| No webhook signature verification | MEDIUM | HMAC signatures on webhooks (P0) | Open |
| No input size limits | MEDIUM | Request size validation (P0) | Open |
| Missing CSRF protection | MEDIUM | CSRF tokens on state mutations (P0) | Open |
