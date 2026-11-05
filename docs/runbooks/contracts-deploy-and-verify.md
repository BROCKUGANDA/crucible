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
TREASURY_ADDRESS=0x... OWNER_SAFE_ADDRESS=0x... \
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" --broadcast
```

Prefer `npm run deploy:network -- --env <local|testnet|production> [--dry-run]`, which asks the
node for its `eth_chainId` before it will run the command above, refuses a chain that disagrees
with the environment named, and refuses to sign with Anvil's published account #0 anywhere but a
loopback demo node. `Deploy.s.sol` now reverts without a key unless `ALLOW_ANVIL_DEV_KEY=1` is set
deliberately: a chain-id check *inside* the script cannot be the guard, because `forge script
--rpc-url` evaluates the script in a local EVM that reports 31337 whatever node it points at —
measured with forge 1.8.5 on 2026-10-29, and the reason the interrogation lives outside.

For the production script, `TREASURY_ADDRESS` must be the deployed company Treasury Safe and `OWNER_SAFE_ADDRESS` must be the deployed company Owner Safe. Both must have contract code; the script has no EOA/deployer fallback. The new `CrucibleTrials` constructor stores these exact addresses, and no later owner/treasury transfer exists. The deploy order remains `AlloyRegistry` first, `CrucibleTrials` second, then `setForge(address(trials))` once. `ReputationBridge` and the ERC-8004 Identity Registry are optional; wire them with the Owner Safe and verify the addresses before relying on reputation. The local `npm run demo` uses a separate Demo script and is not production evidence.

## Verify the live chain

```bash
# From the repo root, with the deployment's .env loaded by compose:
EXPECTED_TREASURY_ADDRESS="$TREASURY_ADDRESS" EXPECTED_OWNER_ADDRESS="$OWNER_SAFE_ADDRESS" REQUIRE_EXPECTED_CUSTODY=1 crucible-contracts/scripts/assert-deployment.sh
```

It reads the live contract and fails if the fee, bond rule, committee, roles or
money invariant differ from the documented values. Run it after every deploy
and after any change to the deployment environment.

Also check:

- `trials.owner()` equals `OWNER_SAFE_ADDRESS` and `trials.treasury()` equals `TREASURY_ADDRESS` exactly. Strict custody mode also checks that both destination addresses have contract code.
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
2. Owner and treasury as independently verified multisigs; the deployer EOA must not remain the owner.
3. A complete Safe withdrawal rehearsal proving treasury credit reaches the approved Treasury Safe.
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
