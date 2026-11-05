# Crucible — Master Phase Plan (incorporating all 11 workstreams + infrastructure)

**Date:** 2026-11-05  
**Branch:** `develop`  
**Baseline:** `abe7304`  
**Source:** `docs/engineering/BASELINE.md`, `BLOCKED_FOR_HUMAN.md`, pasted-context-1/2/3

## Phase status

| Phase | CRU | Item | Status | Blocker |
|---|---|---|---|---|
| 0 | CRU-001 | Baseline inventory | ✅ Done | — |
| 1 | CRU-005 | Organisation & tenancy foundation | ✅ Done | — |
| 2 | CRU-006 | Tenant controls, budgets, API keys, audit | 🔄 Starting | — |
| 3 | CRU-007 | Release evidence (SBOM, DR drill, SLOs, kill switch) | Planned | — |
| 4 | CRU-008 | Native-SOL work-escrow | Blocked | BLOCKED_FOR_HUMAN #13 — Anchor toolchain, PDA design, independent audit; SBF build blocked |
| 5 | CRU-009 | Commercial catalogue, pricing, quotes | Blocked | BLOCKED_FOR_HUMAN #14 — approved pricing policy, payment contracts, legal review |
| 6 | CRU-010 | Native-ETH commercial billing contract | Blocked | Same as CRU-009 |
| 7 | CRU-011 | Native-SOL commercial billing program | Blocked | Same as CRU-009 |
| 8 | CRU-012 | Dual-chain indexing, double-entry ledger, reconciliation | Blocked | Same as CRU-009 |
| 9 | CRU-013 | Subscriptions, credits, CEU metering, cost governance | Blocked | Same as CRU-009 |
| 10 | CRU-014 | Commercial UX, ETH/SOL checkout | Blocked | Same as CRU-009 |

## Workstreams (from pasted-context-1.txt)

| WS | Item | Relation to phases |
|---|---|---|
| WS-0 | Evidence-based baseline | Phase 0 (done) |
| WS-1 | Environment isolation (demo/staging/prod) | Phase 3 |
| WS-2 | Interactive public demo | Phase 3 |
| WS-3 | Full sponsor journey | Phase 3 |
| WS-4 | Agent & agent-operator journey | Phase 3 |
| WS-5 | Skeptic & Argus journey | Phase 3 |
| WS-6 | Browser E2E suite | Phase 3 |
| WS-7 | Indexer, content, API production readiness | Phase 3 + new ADR (PostgreSQL) |
| WS-8 | Mainnet treasury & payment assurance | Blocked (mainnet sign-offs) |
| WS-9 | Reliability, security & adversarial testing | Phase 3 |
| WS-10 | CI & release gates | Phase 3 |
| WS-11 | Commercial proof & revenue reporting | Blocked (CRU-009-014) |

## Infrastructure decision (from pasted-context-2/3)

**PostgreSQL + Redis Queue + Redis Cache + BullMQ + Cloudflare R2** is recommended for production. However:

- **ADR-0008** mandates in-memory indexer. Adding PostgreSQL/Redis/BullMQ requires a **new ADR** before any code.
- The new ADR must specify: durable event persistence, checkpoints, idempotent ingestion, reorg detection/restart recovery, RPC failover, cursor integrity, reconciliation against contract state.
- PostgreSQL must NOT replace the blockchain — two distinct sources of authority (chain = financial truth, DB = application/read model).
- Redis queue and cache must be separate instances (noeviction for queue, LRU for cache).
- BullMQ is at-least-once → workers must be idempotent.
- Outbox pattern: PG transaction → outbox record → BullMQ → worker → PG result.
- Cloudflare R2 for large artifacts (logs, benchmarks, evidence) with digest + size + content type + retention.
- Never store private keys/seeds in DB; store public addresses only.
- Never use Redis as authoritative for ETH balances, escrow liabilities, treasury credits, trial settlement.

**Action:** Write ADR-0023 (PostgreSQL + Redis + BullMQ + R2 production infrastructure) before implementing WS-7 persistence. Until then, org/tenancy state remains in-memory (ADR-0008 compliant).

## Migration requirement

"Create migrations for all of them" — once ADR-0023 is approved, migrations are needed for:

| Domain | Tables | Migration file |
|---|---|---|
| identity | users, wallet_associations, agent_identities, organisations | `migrations/0001_identity.sql` |
| trials | trial_metadata, lifecycle_projections, sponsor_info, deadlines | `migrations/0002_trials.sql` |
| evaluation | trial_manifests, scores, difficulty_estimates, benchmark_results | `migrations/0003_evaluation.sql` |
| execution | agent_runs, execution_metadata, sandbox_refs, artifact_digests | `migrations/0004_execution.sql` |
| disputes | skeptic_challenges, argus_commitments, reveals, outcomes | `migrations/0005_disputes.sql` |
| settlement | chain_settlement_events, liabilities, participant_credits | `migrations/0006_settlement.sql` |
| treasury | fee_credits, withdrawals, reconciliation_records, accounting_entries | `migrations/0007_treasury.sql` |
| indexer | chain_blocks, event_cursors, canonicality, reorg_recovery | `migrations/0008_indexer.sql` |
| jobs | durable_background_work, retries, attempts, failure_records | `migrations/0009_jobs.sql` |
| audit | admin_actions, security_events, configuration_changes | `migrations/0010_audit.sql` |
| commercial | enterprise_subscriptions, invoices, customer_usage, billing_records | `migrations/0011_commercial.sql` |

All migrations need: explicit foreign keys, unique constraints, transactional updates, tenant-scoped access controls, idempotency keys, outbox records.

## Execution rule

Implement one phase at a time, one reviewable change at a time. Mutation-prove every branch. Update `docs/since-submission.md` per shipped change. Never re-run a red money gate to get green.

## What I will NOT do

- Implement CRU-008 through CRU-014 (blocked for human)
- Add PostgreSQL/Redis/BullMQ without ADR-0023
- Fabricate stubs, mocks, or fakes on runtime paths
- Claim mainnet readiness or deploy real funds
- Change the 5% fee or add USDC/ERC-20
