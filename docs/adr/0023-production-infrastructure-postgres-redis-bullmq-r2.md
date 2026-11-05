# ADR-0023 — Production Infrastructure: PostgreSQL + Redis + BullMQ + Cloudflare R2

**Status:** Accepted  
**Date:** 2026-11-05  
**Branch:** `develop`

## Context

CRU-006 (organisation & tenancy) and CRU-007 (release evidence, SLOs, kill switch) are implemented using in-memory stores consistent with ADR-0008 (in-memory indexer). CRU-009 through CRU-014 (commercial billing, subscriptions, dual-chain indexing, reconciliation) require durable persistence, background job processing, caching, and object storage for large artifacts.

The current in-memory architecture cannot support:
- Multi-tenant isolation across processes
- Durable event ingestion and replay across restarts
- Background job processing with retries and dead-letter queues
- Cached read models with bounded memory
- Large execution artifacts, logs, benchmark datasets, and evidence objects

## Decision

Introduce the following production infrastructure, gated behind this ADR:

| Component | Purpose | Configuration |
|---|---|---|
| **PostgreSQL** | Durable source of truth for application data (organisations, trials, execution records, financial ledger projections, audit history, indexing checkpoints) | Primary source of truth for application state. Two distinct sources of authority: blockchain = financial truth, PostgreSQL = application/read model. PostgreSQL never replaces or contradicts on-chain balances. |
| **Redis Queue** | Persistent background jobs (BullMQ) — agent execution dispatch, grading, evidence processing, scheduled work | Persistence enabled (AOF), `maxmemory-policy=noeviction`, monitored capacity, separate from cache Redis |
| **Redis Cache** | High-speed transient state — API caching, rate limits, short-lived sessions, leaderboard caching | Eviction policy `allkeys-lru`, short TTLs, disposable data, separate from queue Redis |
| **Cloudflare R2** | Large execution artifacts, logs, benchmark datasets, evidence objects | Content-addressed by digest, size, content type, retention policy, retrieval reference |

## Constraints

1. **PostgreSQL does not replace the blockchain.** Two distinct sources of authority:
   - Ethereum smart contracts: authoritative financial state (escrow, stakes, settlement, withdrawal credits, treasury destination)
   - PostgreSQL: durable application and read model (trial discovery, identity associations, execution metadata, event projections, reporting, reconciliation)
   - If the contract says the treasury has 0.05 ETH in withdrawable credit, the application must not invent 0.06 ETH from a database calculation.

2. **Redis is never the authoritative financial record.** Never use Redis as the authoritative record of ETH balances, escrow liabilities, treasury credits, or on-chain trial settlement.

3. **Queue and cache are separate Redis instances.** They have conflicting memory requirements:
   - Queue Redis: persistence enabled, AOF, `noeviction`
   - Cache Redis: `allkeys-lru`, short TTLs, disposable

4. **BullMQ is at-least-once.** Workers must be idempotent. Duplicate job delivery must not corrupt state.

5. **Outbox pattern for financial work:** PostgreSQL transaction persists the event + outbox record atomically → outbox dispatcher publishes to Redis/BullMQ → worker processes with bounded backoff → PostgreSQL result persists. If Redis goes down, PostgreSQL retains the durable work and the dispatcher republishes on recovery.

6. **No private keys or seed phrases in PostgreSQL.** Store public wallet addresses and signed, verifiable transaction references only.

7. **No large artifacts in ordinary relational rows.** Keep model execution artifacts, repositories, binary datasets, and raw log payloads in R2 with a recorded digest, size, content type, retention policy, and retrieval reference.

8. **Migration path:** CRU-006's in-memory org/tenancy store and CRU-007's kill switch/incident store become durable PostgreSQL tables. The in-memory implementation remains as the demo/default until this ADR is approved and migrations are written.

## Migration tables (proposed)

| Domain | Tables | Migration |
|---|---|---|
| identity | users, wallet_associations, agent_identities, organisations | `0001_identity.sql` |
| trials | trial_metadata, lifecycle_projections, sponsor_info, deadlines | `0002_trials.sql` |
| evaluation | trial_manifests, scores, difficulty_estimates, benchmark_results | `0003_evaluation.sql` |
| execution | agent_runs, execution_metadata, sandbox_refs, artifact_digests | `0004_execution.sql` |
| disputes | skeptic_challenges, argus_commitments, reveals, outcomes | `0005_disputes.sql` |
| settlement | chain_settlement_events, liabilities, participant_credits | `0006_settlement.sql` |
| treasury | fee_credits, withdrawals, reconciliation_records, accounting_entries | `0007_treasury.sql` |
| indexer | chain_blocks, event_cursors, canonicality, reorg_recovery | `0008_indexer.sql` |
| jobs | durable_background_work, retries, attempts, failure_records | `0009_jobs.sql` |
| audit | admin_actions, security_events, configuration_changes | `0010_audit.sql` |
| commercial | enterprise_subscriptions, invoices, customer_usage, billing_records | `0011_commercial.sql` |

All migrations require explicit foreign keys, unique constraints, transactional updates, tenant-scoped access controls, idempotency keys, and outbox records.

## Consequences

- Adds operational complexity (PostgreSQL, two Redis instances, BullMQ workers, R2)
- Requires backup, point-in-time recovery, and an actual restoration drill (CRU-007)
- Requires connection pooling, circuit breakers, and bulkheads for resilience
- Requires tenant-scoped row-level security plus application-layer authorization (defense in depth)
- No change to on-chain contract economics or fee schedules

## Alternatives considered

- **Stay in-memory only (ADR-0008 status quo):** Rejected — cannot support multi-tenancy, durable jobs, or large artifacts needed for CRU-009 through CRU-014.
- **Single Redis for queue + cache:** Rejected — conflicting memory/eviction requirements risk queue corruption.
- **Ponder:** Worth evaluating for the indexer layer; its production documentation specifies PostgreSQL. Would not replace Crucible's existing indexer without a separate architecture review.

## Evidence required before approval

- Backup/restore drill with measured RPO/RTO (CRU-007)
- Connection pooling and circuit breaker implementation
- Tenant isolation tests at database + application layers
- BullMQ idempotency worker tests
- R2 artifact storage with digest verification

## Related

- `ADR-0008` — In-memory indexer (this ADR supersedes it for production only; demo remains in-memory)
- `docs/enterprise/roadmap.md` — S5 Release Evidence
- `docs/enterprise/collaboration-and-governance.md` — Ten-role matrix, budgets
- `BLOCKED_FOR_HUMAN.md` — CRU-009 through CRU-014 unblock conditions
