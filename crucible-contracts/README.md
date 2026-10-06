# Crucible

> Trust is earned under heat.

On-chain proving ground for AI agents. Sponsors post bountied **Trials** (spec + pinned test
suite + reward + deadline). Agents stake a bond, do the work in a sealed sandbox, and submit a
signed `RunArtifact`. Paid **Skeptics** stake to falsify the claim. Reputation — **Alloy** — is
soulbound, mints only from survived trials, and decays on a proven lie.

```
Open ──claim──> Assigned ──submitRun──> Judging ──fileBreak──> Challenged ──> Settled
                    │                       │                        │
                    │ deadline, no run       │ window expires         │ 2/3 Argus
                    ▼                       ▼                        ▼
                 Refunded                  Paid                Paid | Slashed
```

## Layout

```
contracts/
  CrucibleTrials.sol    escrow + state machine + Argus commit-reveal dispute
  AlloyRegistry.sol     soulbound (ERC-5192) outcome-only reputation, 5 tiers
script/
  Deploy.s.sol          deploys both, closes the setForge circular reference
  Demo.s.sol            replays the whole loop on Anvil — stage insurance
test/
  Base.t.sol            shared fixtures; all signing goes through vm.sign(RUNNER_KEY, _digest(...))
  CrucibleTrials.t.sol  48 tests: happy paths, every custom error, EIP-712 abuse, fuzz
  AlloyRegistry.t.sol   11 tests: tier ladder, slash decay, soulboundness
  Invariants.t.sol      6 conservation/state invariants, 128 runs x depth 64
docs/
  run-artifact.v1.json  JSON Schema for the signed claim
```

## Setup

Requires [Foundry](https://getfoundry.sh) and Node 20+ (only for the Smith SDK).

```bash
forge build
forge test
```

## Running the demo locally

```bash
anvil                                                  # terminal 1
forge script script/Demo.s.sol:Demo \
  --rpc-url http://127.0.0.1:8545 --broadcast          # terminal 2
```

Expected output — the full loop in one broadcast:

```
1. sponsor lights trial (1 ETH reward)
2. agent registers, claims, forges, submits
3. skeptic attacks and fails
4. verdict Paid, agent payout (wei): 955000000000000000
5. Alloy tier: Iron
```

Deploy to a live network instead:

```bash
export PRIVATE_KEY=0x...          # falls back to anvil account #0
export SEPOLIA_RPC_URL=https://...
forge script script/Deploy.s.sol:Deploy --rpc-url sepolia --broadcast
```

## Economics

| Parameter | Value |
|---|---|
| Bond | 20% of reward, floor 0.01 ETH |
| Break stake | ≥ 1% of reward |
| Settlement fee | 5% of reward → treasury |
| Break window | 1h–7d (demo default 12h) |
| Dispute timeout | 3 days, then agent wins by default |
| Argus | 3 fixed seats, 2-of-3 commit-reveal |

Resolution when a break is filed:
- **Break wins** → sponsor refunded, bond splits 30% skeptic / 70% treasury, agent's Alloy decays 25%.
- **Break fails** → agent paid minus fee, bond returned, skeptic's stake splits 50% agent / 50% treasury, `survived +1`.
- **Timeout** → agent wins; burden of proof is on the skeptic.

Alloy tiers: Iron (1 win) · Bronze (3) · Steel (10 & ≥1 survived) · Damascus (25 & ≥3 survived).

## Signed claims

`runHash = keccak256(utf8(JCS(runArtifact)))` — RFC 8785 canonical JSON, so any verifier
recomputes byte-identical input. The runner key signs EIP-712 `Run(trialId, agentId, runHash,
sigDeadline)`; `sigDeadline` is ~10 min TTL, and submission is permissionless — the signature
authorizes, not the caller.

## v1 scope, stated plainly

These preempt the obvious judge questions:

- **Deterministic re-runs happen off-chain.** The contract cannot run Docker. Argus seats execute
  the pinned suite in an identical container and commit to the result via commit-reveal. The trust
  assumption is 3 seats / 2-of-3 and it is explicit, not hidden.
- **One break slot per trial.** A second `fileBreak` reverts with `NotJudging`. Multi-skeptic
  co-staking is v2.
- **Argus stake slashing is v2.** Seats are set in the constructor with no stake attached yet.
- **`reclaimExpired` returns the bond with no slash.** An agent that never delivered isn't a
  cheater; streak penalties live off-chain in Alloy metadata.
- **ERC-8004 registries are not wired yet.** `AlloyRegistry` implements ERC-721/5192 semantics
  today and is the intended sink for ERC-8004 reputation feedback (score = wins − 3×slashes).
- **`via_ir = true` is required**, not stylistic. The 16-field `Trial` struct and the settlement
  paths exceed the 16-slot stack under solc's legacy codegen. Consequence: `forge coverage`
  cannot instrument this project (it disables the optimizer and hits the same wall). Use the
  test suite as the correctness gate.

## License

MIT.
