# Implementation roadmap and dependency graph

## Delivery order
1. CRU-002 comparable score cohorts.
2. CRU-003 typed fee schedule identity.
3. CRU-004 adversary simulation against live parameters.
4. CRU-005 tenant identity foundation.
5. CRU-006 tenant controls and isolation proof.
6. CRU-007 release evidence and operations.
7. CRU-009 catalogue and quotes.
8. CRU-010/011 separate ETH and SOL commercial rails.
9. CRU-012 chain index, double-entry ledger and reconciliation.
10. CRU-013 metering/subscriptions.
11. CRU-014 commercial UX and checkout.

Adaptive Forge depends on comparable evidence and adversary simulation; it cannot change on-chain settlement economics without ADR. Forge Watch can progress off-chain, but monitoring cannot alter verdicts, Alloy, slashing or withdrawals. UX must use real APIs, not pretend functionality.

## Gate A — Evaluation integrity
Every score carries manifest and digest. Rankings form explicit compatible cohorts. Missing manifests are unverified/unranked. Incompatibility names changed fields. Statistics remain within cohorts and expose sample size and uncertainty.

## Gate B — Economic integrity
Legacy and Arena schedules are typed, versioned and distinct. Consumers require explicit schedule. Legacy rate is read from chain; Arena rate from canonical params. Test conservation across success, slash, refund, timeout, duplicate and reorg paths. No pricing proposal before adversary simulation and independent review.

## Gate C — Mechanism review
Simulate Sybil/stake splitting, bribery, sponsor-agent/evaluator collusion, cartels, spam challenges, benchmark leakage, cheap-task farming and wash activity. Use actual chain/config constants. Publish budgets, thresholds, sensitivities and assumptions. No equilibrium-proof claim.

## Gate D — Tenancy
Derive tenant from authenticated membership, not client org ID. Prove isolation across API, DB, object store, artifacts, queues, caches, webhooks and exports. Global limits/nonces work across instances. Identity outages cannot block settlement. API cannot sign chain transactions.

## Gate E — Operations
SBOM per release; actual restore drill with measured RPO/RTO; measured SLOs before SLA claims; severity/responder/escalation; off-chain kill switch blocks new runs only; human release approval.

## Gate F — Commercial rails
Catalogue/quotes before checkout. Commercial billing separate from trial escrow. ETH/SOL separate rails. Double-entry idempotent reorg-aware ledger reconciled to finality. Segregated Safe/multisig treasury. On-chain transactions/balances are public; never promise privacy.

Global: bounded diffs, test/rollback/stop criteria and evidence. No schema/contract migration without ADR. No production keys in CI/dev. No mainnet or merge to develop without explicit approval.
