# Withdrawal Rehearsal

## Purpose

Verify that pull-based withdrawals work correctly before mainnet deployment.

## Prerequisites

- Mainnet fork test environment in Foundry
- Deployed contract addresses
- Test wallet with ETH balance

## Rehearsal Steps

1. Deploy contracts to mainnet fork
2. Deposit ETH to escrow
3. Complete a trial and trigger settlement
4. Verify credit ledger entry created
5. Call `withdraw()` as the credited recipient
6. Verify ETH received by recipient
7. Verify conservation invariant holds

## Expected Results

- Withdrawal succeeds without reverts
- Recipient receives correct amount
- Conservation invariant: `balance == totalStakes + totalPending + escrowed`
- No push payments occur (pull-based only)

## Failure Criteria

- Any withdrawal revert
- Incorrect amount received
- Conservation invariant violation
- Push payment detected
