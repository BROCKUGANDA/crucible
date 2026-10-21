# Crucible contract specification

Status: implemented and tested; **not audited**. This document describes the
contracts as they exist in this repository, not a target design. Where the
implementation and an external product document disagree, this file and the
tests are authoritative.

Solidity 0.8.26. Foundry. Contracts live in `crucible-contracts/contracts/`.
The run-artifact JSON Schema is `crucible-contracts/docs/run-artifact.v1.json`.

## 1. Scope

| Contract               | Responsibility                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CrucibleTrials.sol`   | Escrow, trial state machine, EIP-712 run signatures, break stakes, Argus commit-reveal, pull-payment ledger.                                                         |
| `AlloyRegistry.sol`    | Soulbound, outcome-only reputation. One token per Crucible agent; tiers; 25% win decay on a slash.                                                                   |
| `ReputationBridge.sol` | Optional ERC-8004 Reputation Registry write-out. A registry outage never blocks a verdict.                                                                           |
| `CrucibleHall.sol`     | Separate on-chain leaderboard with its own staking, identity handles and settlement. It is not part of the escrow state machine and is not used by `CrucibleTrials`. |

The demo is native ETH on a local Anvil chain. There is no USDC, ERC-20,
EIP-2612 permit, pause, upgrade path or admin recovery. See §14.

## 2. Actors and authority

| Actor              | Authority                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sponsor            | Creates a trial and escrows the reward. May reclaim an expired trial that never produced a run. Cannot break its own trial. Cannot claim its own trial directly. |
| Agent operator     | Registers one agent per address, sets the runner key, claims a trial, stakes the bond, unstakes free stake, links an ERC-8004 identity.                          |
| Runner key         | Signs `Run(trialId, agentId, runHash, sigDeadline)`. Anyone may relay the signed run.                                                                            |
| Skeptic            | Files one break per trial while the break window is open, staking at least 1% of the reward. Cannot be the sponsor or the agent operator.                        |
| Argus seat         | One of exactly three constructor-selected addresses. Commits and reveals a dispute vote. Has no stake in v1.                                                     |
| Anyone             | May call `finalize` after the relevant window, `withdraw` their own credit, and `ReputationBridge.backfill` for a settled trial.                                 |
| Deployer (`owner`) | May wire or unwire the optional reputation bridge and identity registry. Holds no funds and cannot settle a trial.                                               |
| Treasury           | Receives the settlement fee and the burned portion of a slash. It is a destination, not a permission.                                                            |

## 3. State machine

```
Open ──claimTrial──> Assigned ──submitRun──> Judging ──fileBreak──> Challenged
  │                     │                       │                        │
  │ deadline passes     │ deadline passes       │ break window closes    │ 2-of-3 votes
  ▼                     ▼                       ▼                        ▼
Refunded             Refunded                 Paid                    Paid | Slashed
(no agent)           (bond returns)        (silence = accept)      (or timeout → Paid)
```

- `Open → Assigned` only through `claimTrial` before the deadline.
- `Assigned → Judging` only through a runner-signed `submitRun` before the deadline.
- `Judging → Challenged` only through `fileBreak` inside `runAt + breakWindow`.
- `Judging → Settled` through `finalize` after the window; the agent wins.
- `Challenged → Settled` on the second agreeing reveal, or through `finalize`
  after `DISPUTE_TIMEOUT` (3 days); the agent wins on a timeout.
- `Open|Assigned → Settled (Refunded)` through `reclaimExpired` after the deadline.
- Settlement is terminal. `_settle` reverts `AlreadySettled`; no function returns
  a trial to an earlier state.

## 4. Data

### 4.1 `Trial`

| Field                        | Meaning                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `sponsor`                    | The address that funded the reward.                                                                            |
| `specCID`, `testsCID`        | `bytes32` commitments to the pinned spec and suite. Non-zero on creation; the human-readable CID is off-chain. |
| `reward`                     | ETH escrowed by the sponsor (`uint128`).                                                                       |
| `bond`                       | `bondFor(reward)`, moved from the agent's free stake at claim.                                                 |
| `timestamps`                 | Packed `createdAt                                                                                              | deadline<<64 | breakWindow<<128 | runAt<<192`. Read via `createdAtOf`, `deadlineOf`, `breakWindowOf`, `runAtOf`. |
| `agentId`                    | Claiming agent, or 0.                                                                                          |
| `runHash`                    | `keccak256(utf8(JCS(RunArtifact)))`, set by `submitRun`.                                                       |
| `breakProofCID`              | Skeptic evidence commitment, set by `fileBreak`.                                                               |
| `breakSkeptic`, `breakStake` | The one skeptic and their staked ETH.                                                                          |
| `status`                     | `Open`, `Assigned`, `Judging`, `Challenged`, `Settled`.                                                        |
| `verdict`                    | `None`, `Paid`, `Slashed`, `Refunded`.                                                                         |

The packed timestamps are not cosmetic: a 16-field struct overflowed the
16-slot stack on ABI return under the legacy codegen used by `forge coverage`.
Accessors are the supported read path.

### 4.2 `Agent`

| Field         | Meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `operator`    | The address that registered the agent. One agent per operator. |
| `runner`      | The key that signs run artifacts. Rotatable by `setRunner`.    |
| `metadataURI` | Capability manifest.                                           |
| `stake`       | **Free** stake, not including bonds currently in escrow.       |
| `active`      | Number of live claimed trials.                                 |

### 4.3 `Dispute`

`openedAt`, an informational `revealStarted`, `votesBreak`, `votesAgent`, and
per-seat `commits` / `revealed` mappings. Seats are exactly
`ARGUS_THRESHOLD + 1 = 3`, validated at construction as distinct and non-zero.

## 5. Constants and economics

| Constant                                | Value           | Meaning                                                                                       |
| --------------------------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| `MIN_BOND`                              | 0.01 ETH        | Minimum agent registration stake and minimum reward.                                          |
| `BOND_NUM / BOND_DEN`                   | 1 / 5           | Bond = 20% of reward, floored at `MIN_BOND`.                                                  |
| `BREAK_STAKE_DEN`                       | 100             | Break stake ≥ 1% of reward.                                                                   |
| `FEE_BPS`                               | 500             | 5% settlement fee, **deducted from the agent's payout**. The sponsor pays exactly the reward. |
| `SLASH_SKEPTIC_NUM`                     | 3,000           | 30% of the bond to a winning skeptic; 70% to treasury.                                        |
| `MIN_RUN_WINDOW`                        | 1 hour          | Minimum time from creation to deadline.                                                       |
| `MIN_BREAK_WINDOW` / `MAX_BREAK_WINDOW` | 1 hour / 7 days | Allowed skeptic window.                                                                       |
| `COMMIT_WINDOW`                         | 24 hours        | Time after a dispute opens for Argus seats to commit.                                         |
| `DISPUTE_TIMEOUT`                       | 3 days          | After this, `finalize` settles in the agent's favour.                                         |
| `ARGUS_THRESHOLD`                       | 2               | Two agreeing reveals settle a dispute.                                                        |
| `MAX_REWARD`                            | 1,000 ETH       | Per-trial fat-finger cap.                                                                     |
| `MAX_TOTAL_ESCROWED`                    | 10,000 ETH      | Whole-contract cap, enforced on `createTrial`, `claimTrial` and `fileBreak`.                  |

### Settlement outcomes

**Paid (no break, or break failed, or timeout):**
`agent credit += reward - fee`, `treasury credit += fee`, bond returned to free
stake, `totalPending += reward`. If a break was filed and failed, the skeptic's
stake is split 50% to the agent and 50% to treasury; the skeptic recovers
nothing.

**Slashed (break wins):**
sponsor is refunded the full reward (no fee), skeptic receives their stake plus
30% of the bond, treasury receives the other 70% of the bond. The agent loses
the bond and is paid nothing. Alloy decays wins by 25%.

**Refunded (expired without a run):**
sponsor receives the full reward. If the trial had been claimed, the bond
returns to the agent's free stake. No fee.

All settlement paths credit balances. They never push ETH. `withdraw()` is the
only function in `CrucibleTrials` that calls `{value:}`.

## 6. Function reference

### Sponsor

`createTrial(specCID, testsCID, deadline, breakWindow) payable → id`

- Requires non-zero CIDs, `msg.value >= MIN_BOND`, `msg.value <= MAX_REWARD`,
  `escrowed + msg.value <= MAX_TOTAL_ESCROWED`, `deadline >= now + MIN_RUN_WINDOW`,
  and `breakWindow` in `[MIN_BREAK_WINDOW, MAX_BREAK_WINDOW]`.
- Stores the trial with `bond = bondFor(msg.value)`, adds the reward to
  `escrowed`, emits `TrialCreated`.
- `specCID` and `testsCID` are `bytes32` commitments. The off-chain CID text is
  not stored by the contract.

`reclaimExpired(id)`

- Requires `status` is `Open` or `Assigned` and the deadline has passed.
- Sets `Settled / Refunded`, refunds the reward to the sponsor, returns the bond
  to the agent if the trial had been claimed, emits `VerdictFinalized`.
- Permissionless: anyone can trigger the sponsor's refund.

### Agent

`registerAgent(metadataURI, runner) payable → agentId`

- Requires a non-zero runner, `msg.value >= MIN_BOND`, and no existing agent
  for `msg.sender`.
- Stores free stake, emits `AgentRegistered`.

`setRunner(agentId, runner)`

- Operator only; runner must be non-zero. Emits `RunnerSet`.

`claimTrial(id)`

- Requires `Open`, before the deadline, a registered agent, and
  `free stake >= bond`.
- **Rejects `agent.operator == trial.sponsor` with `SelfClaim`.** This closes
  the direct reputation-farming path; a sponsor using a second wallet is Sybil
  behaviour that a `msg.sender` check cannot solve.
- Enforces `MAX_TOTAL_ESCROWED`.
- Moves the bond from free stake into escrow, increments `active`, sets
  `Assigned`, emits `TrialClaimed`.

`unstake(agentId, amount)`

- Operator only; `0 < amount <= free stake`.
- Moves free stake to the operator's credit ledger and emits
  `StakeWithdrawn`. A second transaction (`withdraw`) sends the ETH.

`submitRun(id, runHash, sig, sigDeadline)`

- Requires `Assigned`, non-zero `runHash`, before the trial deadline and
  `sigDeadline`.
- Recomputes the EIP-712 digest and requires the signer to be the agent's
  current `runner`. High-`s` signatures are rejected.
- Permissionless relay: any caller may submit; the signature authorises it.
- Sets `runHash`, `runAt`, `Judging`, emits `RunSubmitted`.

`linkIdentity(agentId, identityAgentId)`

- Operator only; identity id must be non-zero.
- If an Identity Registry is wired, `ownerOf(identityAgentId)` must be the
  operator. A registry revert blocks the link; a wrong link is worse than a
  retry.
- Records `identityOf[agentId]` and emits `IdentityLinked`.

### Skeptic

`fileBreak(id, proofCID) payable`

- Requires `Judging`, non-zero proof, inside `runAt + breakWindow`,
  `msg.value >= reward / 100`, `msg.value <= uint128.max`, and
  `escrowed + msg.value <= MAX_TOTAL_ESCROWED`.
- `msg.sender` must not be the sponsor or the agent operator (`SelfBreak`).
- One break slot per trial. Sets `Challenged`, records the stake, opens the
  dispute, emits `BreakFiled` and `DisputeOpened`.

### Argus

`commitVote(id, commit)`

- Only a constructor-selected seat. Requires `Challenged`, before
  `openedAt + COMMIT_WINDOW`, and no existing commit by that seat.
- `commit = keccak256(abi.encodePacked(id, breakWins, salt))`.

`revealVote(id, breakWins, salt)`

- Only a seat with a matching commit that has not revealed.
- Tallies the vote. At two agreeing votes, `_settle` runs immediately.
- Reveals stay open until `DISPUTE_TIMEOUT`; the commit deadline is on the
  clock so one seat cannot disenfranchise the other two by revealing first.

### Anyone

`finalize(id)`

- `Judging` and the break window has closed → settle in the agent's favour
  (silence is acceptance).
- `Challenged` and `DISPUTE_TIMEOUT` has passed → settle in the agent's favour
  (the burden of proof is on the skeptic).
- Permissionless.

`withdraw()`

- Sends the caller's entire credit balance. Reverts when zero. `nonReentrant`.
- The credit is cleared and `totalPending` reduced before the external call.

### Owner

`setReputationBridge(address)`, `setIdentityRegistry(address)`

- Deployer only. Zero is allowed and unwires the optional integration.
- The owner holds no funds and has no trial authority.

### Views

`getTrial`, `getAgent`, `bondFor`, `createdAtOf`, `deadlineOf`,
`breakWindowOf`, `runAtOf`, `disputeOf`, `disputeVote`, `identityOf`,
`settledOutcome`.

`settledOutcome(id)` returns `(settled, verdict, agentId, survivedBreak)`. It is
the canonical source for `ReputationBridge.backfill`; a caller cannot choose the
value.

## 7. EIP-712 run signatures

```
Domain: name="Crucible", version="1", chainId, verifyingContract
Type:   Run(uint256 trialId,uint256 agentId,bytes32 runHash,uint64 sigDeadline)
```

The runner key signs the typed data. `submitRun` rebuilds the digest, rejects
`v` values other than 27/28 and high-`s` signatures, and compares the recovered
address to `agents[agentId].runner`. The signature is bound to the trial, agent,
run hash and expiry; replaying the same run is not possible because the trial
has already left `Assigned`.

The run artifact itself is canonicalised with RFC 8785 JCS before hashing. The
schema and the hashing rules are in `crucible-contracts/docs/run-artifact.v1.json`
and `packages/smith-sdk`.

## 8. Reputation

### AlloyRegistry

- `recordWin(agentId, operator, survivedBreak)` and `recordSlash(agentId, operator)`
  are callable only by the `forge` address, set once at construction.
- First write mints `tokenId == agentId` to the operator and emits
  `Transfer(0, operator, tokenId)` and `Locked(tokenId)`.
- Tiers: Unforged (0), Iron (1 win), Bronze (3), Steel (10 wins & ≥1 survived),
  Damascus (25 wins & ≥3 survived).
- A slash increments `slashes` and decays `wins` by 25%.
- `locked(tokenId)` returns true for a minted token. There are no transfer or
  approval functions, so an Alloy cannot move. The contract emits ERC-721-style
  `Transfer` and ERC-5192 `Locked` events, but **does not implement
  `supportsInterface` / ERC-165 and is not a complete ERC-721**. Integrators
  must not treat it as one.

### ReputationBridge

- `reportWin` / `reportSlash` are restricted to `CrucibleTrials`.
- The subject is `identityOf[crucibleAgentId]`, not the Crucible id. If no
  identity is linked, the bridge emits `FeedbackSkipped` and writes nothing.
- Values: paid quiet win `+500`, paid after surviving a break `+750`, slash
  `-400`, on a 0–1000 scale with one decimal. Tags: `crucible` / `verdict`.
- If the optional registry is missing or reverting, settlement still lands: the
  calls from `CrucibleTrials` are low-level and their failure is deliberately
  ignored. `reportedTrial[trialsId]` is set before the registry call, in the same
  transaction: a reverting call rolls it back, and a reentrant registry sees it
  and cannot publish the same trial twice. A second successful write is rejected.
- `backfill(trialsId, agentId)` is permissionless but **canonical**: it reads
  `settledOutcome`, requires the trial to be settled and the agent to match,
  rejects a refund, derives the value itself, and rejects an already-reported
  trial. It cannot mint arbitrary reputation.

## 9. Invariants

The Foundry invariant suite drives the contract through a handler and asserts:

1. `address(this).balance == totalStakes + totalPending + escrowed`.
2. `escrowed` never exceeds the contract balance.
3. `totalPending` never exceeds the contract balance.
4. Every trial's bond equals `bondFor(reward)`.
5. Every settled trial has a terminal verdict.
6. Every Alloy tier is in `[0, 4]`.

The harness uses separate sponsor/operator/skeptic/Argus actors, so the
self-claim guard does not distort the conservation paths.

## 10. Events

`TrialCreated`, `AgentRegistered`, `RunnerSet`, `TrialClaimed`, `RunSubmitted`,
`BreakFiled`, `DisputeOpened`, `VoteCommitted`, `VoteRevealed`,
`VerdictFinalized`, `StakeWithdrawn`, `Withdrawn`, `ReputationBridgeSet`,
`IdentityRegistrySet`, `IdentityLinked`.

The indexer treats `VerdictFinalized` as the settlement receipt: `agentPayout`
is the chain's own arithmetic, not a re-derivation. `RunnerSet` and
`StakeWithdrawn` are projected into `AgentRow` free stake and runner identity.

## 11. Errors

The full list is in `CrucibleTrials.sol`. The groups that matter operationally:

- **Lifecycle:** `NotOpen`, `NotAssigned`, `NotJudging`, `NotChallenged`,
  `NotFinalizable`, `NotReclaimable`, `AlreadySettled`, `DeadlinePassed`,
  `DeadlineNotPassed`, `WindowOpen`, `WindowClosed`, `DisputeUnresolved`.
- **Authority:** `NotOperator`, `NotArgus`, `NotOwner`, `SelfBreak`, `SelfClaim`.
- **Money/limits:** `RewardTooSmall`, `RewardTooLarge`, `EscrowCapExceeded`,
  `StakeTooSmall`, `NothingToWithdraw`, `TransferFailed`.
- **Signatures:** `BadSigner`, `BadSig`, `SigExpired`, `SigMalleable`.
- **Dispute:** `CommitMismatch`, `AlreadyCommitted`, `AlreadyRevealed`,
  `CommitClosed`.
- **Inputs:** `ZeroSpec`, `ZeroTests`, `ZeroRunner`, `ZeroRunHash`, `ZeroProof`,
  `ZeroTreasury`, `ZeroIdentity`, `BadWindow`, `BadDeadline`.

## 12. Test map

| File                          | Focus                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `test/CrucibleTrials.t.sol`   | Creation, claims, runs, breaks, settlement math, caps, self-dealing, pull payments.          |
| `test/ReputationBridge.t.sol` | Identity id-space, registry outage, skip semantics, canonical backfill, one-write-per-trial. |
| `test/AlloyRegistry.t.sol`    | Mint, tiers, decay, soulbound behavior, token URI.                                           |
| `test/CrucibleHall.t.sol`     | The separate on-chain hall.                                                                  |
| `test/Invariants.t.sol`       | Six conservation/terminal-state invariants.                                                  |
| `test/Fork.t.sol`             | Four ERC-8004 mainnet-fork tests; skipped without `MAINNET_RPC_URL`.                         |

Current counts: **135 tests** (131 passed, 4 fork tests skipped without a
mainnet fork). `forge fmt --check`, `forge test`, slither triage and
`forge coverage` are CI gates; coverage requires `--ir-minimum`.

## 13. Deployment and verification

- `script/Deploy.s.sol` deploys `AlloyRegistry`, then `CrucibleTrials`, then
  calls `setForge`. `script/Demo.s.sol` seeds four trials; `Extend.s.sol` adds
  claimable/open trials.
- `scripts/assert-deployment.sh` reads the live chain and fails the deploy if
  the fee, bond rule, committee, roles or money invariant differ from the
  documentation.
- The demo is ETH on Anvil. A real deployment must decide the chain, asset,
  treasury and owner (multisig) in a new ADR and a new contract review.

## 14. Known limits

- No professional audit, no formal verification, no pause, no upgrade path.
- Native ETH only; no USDC, ERC-20 or EIP-2612 permit.
- Fixed three-seat Argus committee with no stake. No human judge marketplace,
  hidden probes or confidence-gated escalation.
- The owner can wire/unwire the optional registries; the owner holds no funds.
- `AlloyRegistry` is soulbound by construction but does not declare ERC-165 /
  ERC-5192 / ERC-721 interfaces.
- The demo is local Anvil. See `HARDENING.md` for the current open items.
