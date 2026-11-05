# Treasury implementation inventory

**Date:** 2026-11-05  
**Baseline inspected:** `develop` at `46b61649b204eeeaa33402de5fb51b2adb8fca71`  
**Purpose:** Path-accurate T0 inventory for `treasury-security-release-gate.md`.  
**Scope:** Read-only repository inspection. No runtime code changed.

## 1. Critical finding: deployment currently binds treasury to the deployer EOA

File: `crucible-contracts/script/Deploy.s.sol`

The current deployment path constructs the escrow with:

```solidity
trials = new CrucibleTrials(vm.addr(pk), address(alloy), _argusSeats());
```

The first constructor argument is the treasury. `vm.addr(pk)` is the address derived from the deployment private key. This means the current script routes treasury credits to the deployer EOA, not to a separate company Safe.

The contract constructor stores a non-zero treasury and has no treasury setter. The API reads the public `treasury()` getter. The deployment script therefore needs a reviewed change before production: require an explicit, validated treasury address for production deployments, pass it into the constructor, and record it in deployment evidence. Local development behavior must remain explicit and safe; do not silently default a production deployment to the deployer.

**This is a release blocker.** Do not use the existing deployment script for a production treasury deployment until this is addressed, reviewed and tested.

## 2. What already exists

### Contract

File: `crucible-contracts/contracts/CrucibleTrials.sol`

- Constructor accepts `treasury_`, rejects zero and stores the treasury.
- Treasury is publicly readable through `treasury()`.
- Successful paid settlement credits `credit[treasury]` with the 5% legacy fee.
- A failed skeptic challenge credits the treasury its share of the skeptic stake.
- A successful skeptic challenge credits the treasury its specified share of the agent bond.
- `withdraw()` reads `credit[msg.sender]` and transfers only to `msg.sender`.
- The contract emits `Withdrawn(address indexed to, uint256 amount)`.
- Settlement uses pull credits; no treasury transfer is pushed during settlement.

### API

File: `apps/api/src/server.ts`

- Reads `TRIALS_ADDRESS` and `ALLOY_ADDRESS` as required addresses.
- Uses a public viem client; no treasury private key is present in the inspected initialization path.
- Reads the public `treasury()` getter and then `credit(treasury)`.
- Exposes the treasury credit through the snapshot/economics read model.
- Retries a treasury read on the alloy sweep clock.
- On a transient read error, retains the last successful treasury credit; there is no freshness timestamp in the inspected treasury-credit value. A production financial surface therefore needs explicit last-success block/time and stale status before calling this a current balance.

### Indexer

Files:
- `packages/indexer/src/scribe.ts`
- `packages/indexer/src/model.ts`
- `packages/indexer/src/api.ts`

- The trial event allowlist includes `VerdictFinalized`, `StakeWithdrawn` and `Withdrawn`.
- Settlement payout and fee projection is derived from the chain's settlement event, not from a duplicated TypeScript fee constant.
- The inspected API economics model includes paid-out ETH, fee ETH, volume, paid settlement count, fee basis points and current treasury credit.
- No dedicated treasury double-entry ledger or end-to-end Safe withdrawal reconciliation was identified in the inspected read model.
- Existing repository decisions describe an in-memory indexer and no EVM reorg rollback. A durable, reorg-aware financial projection requires an ADR; do not slip a database into the current ADR-0008 architecture without review.

### Web wallet

Files:
- `apps/web/src/components/Wallet.tsx`
- `apps/web/src/lib/wagmi.ts`

- The application has end-user wallet connection and chain switching.
- The inspected wallet path is a user wallet connector, not a Safe treasury approval/withdrawal workflow.
- The frontend deployment config exposes trial and Alloy contract addresses; it does not establish a treasury Safe binding.
- No treasury Safe proposal/threshold/receipt lifecycle was identified in these inspected files.

### Mainnet release gate

Files:
- `scripts/mainnet-preflight.mjs`
- `docs/mainnet/audit-signoff.json`
- `docs/mainnet/legal-signoff.json`
- `docs/mainnet/genesis-cohort.json`
- `docs/mainnet/timelock.json`
- `docs/mainnet/monitoring.json`

- The preflight checks the existing sign-off files, frozen v1 fee parameter and a mainnet RPC chain ID.
- It does not currently verify an approved treasury Safe address, compare it with the deployed contract's `treasury()`, prove Safe owner threshold, or require a successful Safe withdrawal rehearsal.
- Existing sign-off templates are unsigned. The runbook says preflight is intentionally red until real evidence exists.

## 3. Concrete implementation tasks derived from the inventory

| Slice | Files / surface | Required change | Dependency |
|---|---|---|---|
| T1 deployment treasury input | `Deploy.s.sol`, `scripts/deploy-network.mjs`, deploy tests | Explicit production treasury address; validate non-zero/checksum; pass as constructor arg; local dev behavior explicit | ADR/review of deployment interface |
| T2 deployment evidence | deploy manifest + mainnet preflight | Record chain ID, treasury Safe, escrow address and commit; compare on-chain `treasury()` with approved manifest | T1 |
| T3 API freshness | `apps/api/src/server.ts`, API tests | Publish treasury address, credit, block number/hash, last-success timestamp and stale/unknown state; do not silently present last good read as current | T2 |
| T4 event accounting | indexer and new ADR | Durable, idempotent event projection including settlement and withdrawal events; explicit canonicality/reorg rollback/replay | ADR-0008 architecture decision |
| T5 Safe withdrawal UX | web app and Safe integration | Propose `withdraw()` through Safe, show exact target/function/value, observe threshold approvals, confirm receipt/event and credit delta | T1/T2; supported Safe integration confirmed |
| T6 reconciliation | API/indexer/monitoring | Reconcile contract invariant, treasury credit and actual withdrawal receipts; alert and block new intake on mismatch | T4 |
| T7 release preflight | mainnet preflight and runbook | Require treasury binding proof, Safe configuration, successful withdrawal rehearsal, reconciliation and on-call readiness | T2–T6 |

## 4. Exact stop conditions discovered

1. The current deployment script routes treasury to `vm.addr(pk)`; do not deploy it to mainnet for company revenue collection as-is.
2. The contract has no treasury setter. A misconfigured deployed treasury cannot be repaired by changing an API environment variable.
3. Existing treasury credit read is useful telemetry but not proof that a Safe can withdraw, nor a complete accounting ledger.
4. Existing indexer event ingestion is not a durable reorg-aware financial accounting system.
5. Existing mainnet preflight does not bind the contract treasury to an approved Safe.
6. No Safe withdrawal execution or end-to-end receipt verification was established by this read-only inspection.

## 5. Verification boundary

This inventory is a source inspection, not a test run. No Foundry tests, API tests, browser tests, Safe transaction simulations, fork tests or mainnet preflight were run as part of T0. The implementation agent must run the repository-mandated verification commands after each code slice and report the exact results. No deployment or merge was performed.
