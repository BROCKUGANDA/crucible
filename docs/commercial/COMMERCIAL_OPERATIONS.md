# Commercial Operations

**Last updated:** 2026-11-19

## Overview

Crucible maintains a three-truth model separating evaluation, commercial, and chain data. No inference between payment and evaluation results.

## Three-Truth Model

| Truth | Description | Source |
|-------|-------------|--------|
| Evaluation truth | What happened and what the evidence supports | Grader, Argus, replay manifests |
| Commercial truth | Who sponsored, how much was committed, allocated, payable, paid | Sponsor console, budget accounting |
| Chain truth | What was submitted, confirmed, and finalized on-chain | Contracts, indexer, reconciliation |

## Commercial Separation

- Never infer an on-chain payment from an internal database status
- Never infer an evaluation result from a sponsor payment
- Evaluation, commercial, and chain data remain separate systems
- Reconciliation service compares all three truths

## Budget Accounting

| State | Description |
|-------|-------------|
| Committed | Total budget approved by sponsor |
| Deposited | ETH deposited into escrow |
| Escrowed | ETH held in the contract |
| Allocated | ETH assigned to specific trials |
| Pending | ETH awaiting settlement |
| Payable | ETH ready for withdrawal |
| Paid | ETH credited to recipient's ledger |
| Withdrawn | ETH pulled by recipient |

## Billing and Metering

| Component | Description |
|-----------|-------------|
| Tenant quotas | Per-organization limits |
| API request usage | Request count and rate |
| Execution usage | Compute time consumed |
| Storage usage | Artifact storage |
| Plan entitlements | Feature access by tier |
| Usage summaries | Periodic reports |
| Billing periods | Monthly or custom |
| Budget alerts | Threshold notifications |
| Overages | Excess usage handling |
| Usage exports | Downloadable reports |
| Administrative adjustments | Audit-trailed changes |

## Sponsor Operations

| Operation | Description |
|-----------|-------------|
| Sponsor onboarding | Organization registration and approval |
| Program creation | Evaluation program setup |
| Budget management | Funding and allocation |
| Reporting | Participation, scores, costs, rewards |
| Pilot administration | Configurable limits and templates |

## API Metering

| Metric | Description |
|--------|-------------|
| API key scopes | Granular permissions |
| Request counting | Per-tenant request tracking |
| Rate limiting | Per-route rate limits |
| Usage tracking | Historical usage data |
| Budget alerts | Threshold notifications |

## Important Invariants

1. **Score/reward isolation** — Financial data cannot influence grading
2. **No floating-point arithmetic** — All monetary values use integer arithmetic (wei)
3. **Pull-based withdrawals** — No push payments
4. **Conservation invariant** — `balance == totalStakes + totalPending + escrowed`
5. **Fee transparency** — `FEE_BPS = 500` (5%), never 15%
