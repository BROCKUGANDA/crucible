# Runbook: contracts deploy and verify

## Local demo

```bash
npm install
npm run demo
```

`scripts/demo.mjs` starts Anvil, deploys `AlloyRegistry` and `CrucibleTrials`,
seeds two agents and four trials, runs the loop, and leaves the node up. The
seed is a **broadcast**, not a mock.

## Deploy manually

```bash
cd crucible-contracts
forge build
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" --broadcast
```

The deploy order matters: `AlloyRegistry` first, `CrucibleTrials` second,
then `setForge(address(trials))` once. `ReputationBridge` and the ERC-8004
Identity Registry are optional; wire them with the owner setter and verify the
addresses before relying on reputation.

## Verify the live chain

```bash
# From the repo root, with the deployment's .env loaded by compose:
crucible-contracts/scripts/assert-deployment.sh
```

It reads the live contract and fails if the fee, bond rule, committee, roles or
money invariant differ from the documented values. Run it after every deploy
and after any change to the deployment environment.

Also check:

- `trials.owner()` is the intended owner (a multisig on a real chain).
- `trials.treasury()` is the intended treasury, not zero.
- Alloy's `forge` is the `CrucibleTrials` address.
- The three Argus seats are the intended, distinct keys.
- `FEE_BPS() == 500`, `BOND_NUM/BOND_DEN == 1/5`,
  `BREAK_STAKE_DEN == 100`, `ARGUS_THRESHOLD == 2`.

## Test gate

```bash
npm run contracts:test          # 135 total: 131 pass, 4 fork tests skipped
MAINNET_RPC_URL=... forge test --fork-url "$MAINNET_RPC_URL" \
  --match-contract ForkTests   # run the four for real
```

`forge coverage` needs `--ir-minimum`; the repository's script handles it. Do
not quote a coverage number from a run without it.

## Before real value

This demo is not an audited escrow. Before a chain with value:

1. Professional audit and a response to every finding.
2. Owner as a multisig; deployer key handed over or destroyed.
3. Treasury as a multisig or a documented address.
4. Three independently held Argus seats, with an operational rotation plan.
5. A decision on the asset (ADR-0002 is ETH-only), price/legal treatment and
   withdrawal operations.
6. A runbook for a contract bug: there is **no pause and no upgrade**. The only
   recovery is a new deployment and a community/operator decision.

## Incident checks

- A stuck trial: `getTrial`, `disputeOf`, `finalize`; a window may still be
  open.
- A disputed trial: check `openedAt`, `COMMIT_WINDOW`, `DISPUTE_TIMEOUT`, and
  the revealed votes. A timeout settles for the agent by design.
- A wrong payout: preserve the transaction and logs; do not attempt a contract
  "fix" by sending funds. The ledger is the record.
- A compromised owner key: unwire the optional registries if needed; the owner
  cannot move escrowed funds.
