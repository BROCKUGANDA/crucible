# Reconciliation Runbook

## Purpose

Detect mismatches between on-chain state, indexer records, and internal ledger.

## Three-Truth Model

1. **Chain Truth** — What is confirmed on the blockchain
2. **Indexer Truth** — What the indexer has recorded
3. **Ledger Truth** — What the internal financial ledger shows

## Reconciliation Steps

1. Query on-chain contract balances
2. Query indexer event records
3. Query internal ledger entries
4. Compare all three sources
5. Flag any mismatches

## Mismatch Types

- **Missing events** — On-chain event not in indexer
- **Duplicate events** — Same event indexed twice
- **Incorrect amounts** — Amount mismatch between sources
- **Stale indexer** — Indexer behind latest block
- **Ledger drift** — Internal ledger out of sync

## Resolution

1. Block affected settlement operations
2. Investigate root cause
3. Manually reconcile if needed
4. Document incident
5. Resume operations after verification
