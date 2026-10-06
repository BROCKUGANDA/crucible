# Foundry

Solidity 0.8.26. Two contracts, 64 tests including a 6-invariant conservation suite.

| Contract | Role |
|---|---|
| `CrucibleTrials.sol` | Escrow + state machine. `Open → Assigned → Judging → Challenged → Settled`, plus `Refunded` when a claimed trial never gets a run. EIP-712 signed run artifacts with permissionless relay, 2-of-3 Argus commit-reveal disputes, pull-payment ledger. |
| `AlloyRegistry.sol` | Soulbound ERC-721/5192 outcome-only reputation. Five tiers, 25% decay on a proven lie. No transfer functions exist, so an Alloy cannot move. |

## Layout

```
contracts/   CrucibleTrials.sol, AlloyRegistry.sol
script/      Deploy.s.sol, Demo.s.sol — the 90-second stage fallback
test/        Base.t.sol, CrucibleTrials.t.sol, AlloyRegistry.t.sol, Invariants.t.sol
docs/        run-artifact.v1.json — the JSON Schema for a signed claim
lib/         forge-std, vendored (not versioned) so the repo builds offline
```

## Running

```bash
forge build
forge test
```

## The demo

```bash
anvil                                                     # terminal 1
forge script script/Demo.s.sol:Demo \
  --rpc-url http://127.0.0.1:8545 --broadcast             # terminal 2
```

Or from the repo root: `npm run demo` — starts Anvil, deploys, replays the loop, and
leaves the node up.

## Economics

| Parameter | Value |
|---|---|
| Bond | 20% of reward, floor 0.01 ETH |
| Break stake | ≥ 1% of reward |
| Settlement fee | 5% of reward → treasury |
| Break window | 1h–7d (demo default 12h) |
| Dispute timeout | 3 days, then the agent wins |
| Argus | 3 fixed seats, 2-of-3 commit-reveal |

Resolution when a break is filed:

- **Break wins** → sponsor refunded; bond splits 30% skeptic / 70% treasury; Alloy decays 25%.
- **Break fails** → agent paid minus fee, bond returned; the skeptic's stake splits 50% agent / 50% treasury and they recover nothing.
- **Timeout** → agent wins; the burden of proof is on the skeptic.

Tiers: Iron (1 win) · Bronze (3) · Steel (10 & ≥1 survived) · Damascus (25 & ≥3 survived).

## Signed claims

`runHash = keccak256(utf8(JCS(runArtifact)))` over RFC 8785 canonical JSON, so any
verifier recomputes byte-identical input. The runner key signs
`Run(trialId, agentId, runHash, sigDeadline)`; `sigDeadline` is a ~10 minute TTL and
submission is permissionless — the signature authorises, not the caller.

## Deviations from the original spec

Each of these is a bug the tests caught, not a preference:

- **A failed break used to refund the stake to the skeptic.** The spec's own economics
  section ("Lose, and half your stake goes to them") and its `/bounties` copy say the
  opposite. Half now goes to the agent, half to treasury.
- **`Trial` packs four `uint64` timestamps into one `uint256`** (`createdAt |
  deadline<<64 | breakWindow<<128 | runAt<<192`), read via `createdAtOf`, `deadlineOf`,
  `breakWindowOf`, `runAtOf`. A 16-field struct overflows the 16-slot stack on ABI
  return. This also saves three storage slots per trial.
- **`via_ir = true` is required.** It follows from the above once the settlement paths
  are considered. Consequence: **`forge coverage` does not work here** — it disables
  the optimizer and hits the same stack limit. Four sites were fixed to get as far as
  possible (`_computeDomain`, `_settleWin`/`_settleSlash`, `_split`, `_uriHead`/
  `_uriStats`), but the constraint is structural. The test suite is the correctness
  gate; do not claim a coverage percentage.

## v1 scope, stated plainly

- **Deterministic re-runs happen off-chain.** The contract cannot run Docker. Argus
  seats execute the pinned suite in an identical container and commit to the result via
  commit-reveal. The trust assumption is 3 seats / 2-of-3, stated rather than hidden.
- **One break slot per trial.** A second `fileBreak` reverts `NotJudging`.
- **Argus stake slashing is v2.** Seats are set in the constructor with no stake.
- **`reclaimExpired` returns the bond with no slash.** An agent that never delivered
  isn't a cheater.
- **ERC-8004 registries are not wired.** `AlloyRegistry` implements ERC-721/5192
  semantics today and is the intended sink for ERC-8004 reputation feedback
  (score = wins − 3×slashes).

MIT.
