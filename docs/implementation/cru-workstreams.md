# CRU-002–CRU-014 controlled implementation prompts

Inspect current code and reuse canonical primitives before each workstream. Completion requires tests and stop conditions on the exact revision.

## CRU-002 — Comparable leaderboard cohorts
Enforce comparability in every ranking. Inspect smith-sdk manifests, eval gates, grader scorecards and hall API. Partition entries using canonical scoresComparable; rank only within cohort; return cohort identity, manifest digest, sample count, exclusions and field-level reasons. Missing manifests are unverified/unranked, never mixed. Preserve conservative ratings and deterministic ties. Test same conditions/different model; changed corpus, suite, evaluator, rubric, seed, sampling, scoring, harness, runner and tool versions; missing manifests; multiple cohorts; empty/duplicate inputs; stable ordering; serialization and UI states. Stop rather than mix if consumer cannot represent cohorts.

## CRU-003 — Typed fee schedules
Make legacy 5% and dormant Arena 15% impossible to confuse. Inspect FEE_BPS, readProtocolFee, canonical params, ADR-0019 and all consumers. Add discriminated types with id/version/rate/basis/rounding/payer/receiver/source. Require explicit schedule. Read legacy from chain, Arena from canonical params. Test compile-time distinction, read failures, invalid params, rounding, conservation and unchanged API/indexer behaviour. Do not change rates or unify schedules.

## CRU-004 — Adversary simulation
Simulate Sybil identities, stake splitting, juror bribery, sponsor-agent/evaluator collusion, cartels, spam challenges, benchmark leakage, cheap-task farming and wash activity. Deterministic seeds; actual chain/config values; sweep 0.01 ETH floor to 1,000 ETH cap. Report budgets, break-even thresholds, sensitivity and assumptions. Test determinism, budget conservation, parameter sensitivity and replay. No economics constants or equilibrium-proof claim without independent review.

## CRU-005 — Organisation and tenant identity
Complete org/workspace/member identities, membership lifecycle, invite expiry/revocation, tenant ownership and role matrix. Resolve tenant from authenticated membership, not request body. Inspect ADR-0022 and agent-security. Test IDOR, revoked/expired membership, role downgrade, replay, duplicate invite, deleted member and identity outage. ADR/migration before persistence semantics change.

## CRU-006 — Tenant controls and isolation
Implement budgets/quotas, scoped revocable API keys, signed replay-protected webhooks, audit export, dataset visibility and COI register. Prove isolation across API, DB, object store, artifacts, queues, cache and exports with two-tenant abuse tests. Test rotation, replay, quota race, queue retry, cache collision and global limits. Stop if any layer lacks negative isolation test. API cannot sign chain transactions.

## CRU-007 — Release evidence and operations
Add per-release SBOM/provenance, dependency/image inventory, real backup/restore drill, measured RPO/RTO, SLOs, severity/escalation and off-chain new-run kill switch. Test restore integrity, provider/queue/DB outages, alerts and preservation of in-flight settlement. No SLA without measured SLO; no release-ready claim without restore and human sign-off.

## CRU-008 — Native-SOL work escrow
Design true native-SOL using System Program transfers, account/PDA model, rent accounting, replay protection, state machine, permissionless settlement, pull claims, conservation and finality. SPL-token escrow is not native SOL. Test SBF build, local validator, rent, failed CPI, account substitution, duplicate settlement and invariants. Block until ADR, toolchain and audit plan. No mainnet.

## CRU-009 — Commercial catalogue and quotes
Create versioned catalogue, entitlements, quote lifecycle/expiry, quantity bounds, discount approvals, currency and immutable quote snapshots. Keep billing separate from trial escrow. Test stale/expired/duplicate quotes, plan changes, entitlement mismatch, integer-safe money and concurrent redemption. No invented prices or tax/legal claims.

## CRU-010 — Native-ETH commercial billing
Dedicated ETH commercial rail and ledger, separate from trial escrow. Invoice reference, idempotent intent, finality, refund/credit policy, pull treasury withdrawal and segregated Safe. Test wrong chain/recipient, under/overpayment, duplicate tx, reorg, replacement, stale quote, receipt outage and reconciliation. No reuse of trial escrow semantics without ADR/review.

## CRU-011 — Native-SOL commercial billing
Independent native-SOL checkout with System Program validation, receipt reference, confirmation/finality, ledger mapping and refund lifecycle. SPL support does not prove native SOL. Test wrong cluster/recipient, insufficient lamports, duplicate signature, rollback, replacement and reconciliation. Block until native-SOL architecture and SBF security review.

## CRU-012 — Chain index, ledger and reconciliation
Chain adapters, canonical event identity, immutable double-entry postings, idempotent ingestion, finality, compensating reorg entries, durable outbox and reconciliation. Postgres source of truth; Redis/BullMQ coordination only. Test duplicate/out-of-order logs, reorg, missing receipt, RPC failover, partial batch, poison message, concurrent posting and conservation. Never silently delete postings.

## CRU-013 — Metering and cost governance
Versioned usage events, idempotent metering, entitlements, quotas, hard/soft limits, overage policy, cost attribution, provider budgets and anomaly alerts. Persist event/outbox before queue. Test duplicate/late/out-of-order events, outages, quota race, downgrade, clock skew, rounding, tenant isolation and invoice reconciliation. Unknown usage is not zero or a precise billable value.

## CRU-014 — Commercial UX and E2E monetisation
Connect catalogue, quote, checkout, ledger and entitlements. Plan pages, quote review, enabled ETH/SOL rails, wallet flow, pending/confirmed/reorg states, invoice/receipt, tx links, activation, cancellation/refund, support and audit. Include loading/empty/retry/error/disabled/unsupported-chain/reduced-motion states. Test E2E, wallet rejection, wrong network, duplicate click, RPC outage, pending payment, reorg, refund and accessibility. Never activate entitlement before canonical ledger confirmation.
