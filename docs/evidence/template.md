# Sponsor Trial Evidence Package — Template

**Project:** Crucible — On-Chain Proving Ground for AI Agents  
**Chain:** local Anvil (chain id 31337) for the demonstration; testnet for a pilot; mainnet only after the ADR-0020 release gates  
**Fee:** FEE_BPS = 500 = 5%, native ETH only, pull-only settlement (ADR-0001, ADR-0003)  
**Status:** template — fill one package per completed sponsor trial  
**Contract spec:** `crucible-contracts/docs/contract-spec.md`

---

This package is the investor-grade evidence that one sponsor-funded trial ran end to end and every obligation settled correctly. It is produced by the **first completed sponsor trial**, then reused as the template for every later trial.

It deliberately separates **public blockchain evidence** (anyone can verify on chain or against the deployed contract source) from **confidential sponsor information** (shared only with authorised parties under the agreed access controls). Do not publish proprietary benchmark data or private execution artifacts merely to prove a trial happened.

Classification key:

- **Public** — on-chain transaction, contract address, published source, digest, or a redacted summary safe to publish.
- **Confidential** — sponsor agreement, benchmarks, private execution artifacts, unredacted sponsor feedback. Share only with authorised parties.

---

## 1. Sponsor agreement and trial brief

| Field | Content | Classification | How to verify |
|---|---|---|---|
| Sponsor | legal name / entity | Confidential | — |
| Trial brief | challenge, definition of success, acceptance test, deadline, budget | Confidential | sponsor sign-off |
| Acceptance test | measurable pass/fail criterion the pinned suite enforces | Confidential | re-run against spec digest |
| Redacted brief for publication | challenge class and outcome only, no proprietary detail | Public | compare against the confidential original |

**What it proves:** there was a real customer problem, not a hypothetical marketplace.  
**Where to find it:** sponsor agreement file (off chain); redacted copy in `docs/evidence/<trial-id>/`.

---

## 2. Funded-trial transaction

| Field | Content | Classification | How to verify |
|---|---|---|---|
| Transaction hash | `createTrial` broadcast | Public | block explorer / RPC `eth_getTransactionReceipt` |
| Contract address | deployed `CrucibleTrials` address | Public | `treasury()` getter matches the approved Safe |
| Reward (wei) | `msg.value` sent with `createTrial` | Public | transaction value field; equals agreed budget |
| Block number / timestamp | inclusion proof | Public | receipt |
| Sponsor address | `msg.sender` of `createTrial` | Public | receipt `from` field |

**What it proves:** the escrow received the approved reward before any agent could claim.  
**Where to find it:** transaction receipt; cross-check `TrialCreated` event in the indexer snapshot (`/snapshot`, `/trials/:id`).  
**Related code:** `crucible-contracts/contracts/CrucibleTrials.sol` `createTrial`; ADR-0002 native ETH escrow.

---

## 3. Contract address and verified source

| Field | Content | Classification | How to verify |
|---|---|---|---|
| `CrucibleTrials` address | deployed on the trial chain | Public | `crucible-contracts/script/Deploy.s.sol` output |
| Bytecode hash | deployed bytecode vs compiled artifact | Public | `cast code <addr>` vs `forge inspect CrucibleTrials deployedBytecode` (CBOR metadata stripped) |
| Source commit | git SHA of the exact release | Public | `git rev-parse HEAD`; tag the release |
| Compiler version | pinned Foundry forge version | Public | `forge --version`; `foundry.toml` |
| `FEE_BPS` | 500 (5%) | Public | `test_FeeBpsIsFiveHundredNotFifteenHundred` |

**What it proves:** which protocol handled the trial, at the exact release commit.  
**Where to find it:** `crucible-contracts/contracts/CrucibleTrials.sol`; HARDENING.md "Deployed bytecode was compared to the compiled artifact".  
**Rule:** a report on an earlier contract commit does not certify a changed deployment (ADR-0001 / ADR-0019).

---

## 4. Specification and test digests

| Field | Content | Classification | How to verify |
|---|---|---|---|
| Spec digest | `keccak256` of pinned spec bytes | Public | `TrialCreated.spec` event / read model |
| Tests digest | `keccak256` of pinned suite bytes | Public | `TrialCreated.tests` event / read model |
| Spec bytes | content-addressed fixture | Public | `crucible-contracts/fixtures/trials/<trial>/`; digest-pinned on chain |
| Suite bytes | content-addressed fixture | Public | same directory; `seed-content.mjs` pins through `ContentService` |

**What it proves:** what the sponsor committed to evaluating, immutably.  
**Where to find it:** fixtures directory; digest-pinned on-chain (changing one byte changes the keccak digest already published).  
**Related code:** `scripts/seed-content.mjs`; `crucible-contracts/script/SeedContent.sol`.

---

## 5. Agent claim transaction

| Field | Content | Classification | How to verify |
|---|---|---|---|
| Transaction hash | `claimTrial` broadcast | Public | receipt |
| Agent address | `msg.sender` of `claimTrial` | Public | receipt `from` field |
| Bond (wei) | 20% of reward, floor 0.01 ETH | Public | transaction value; `BOND_NUM/BOND_DEN` |
| Agent ID | returned by `claimTrial` | Public | event `TrialClaimed` |
| Runner key | registered for the agent | Public | `setRunner`; bound to agent |

**What it proves:** an independent agent committed its own wallet and bond to the task.  
**Where to find it:** receipt; `AgentRegistered` / `TrialClaimed` events.  
**Related code:** `registerAgent`, `claimTrial`, `setRunner`.

---

## 6. Signed run artifact

| Field | Content | Classification | How to verify |
|---|---|---|---|
| Run hash | agent-submitted artifact digest | Public | `submitRun`; `RunSubmitted` event |
| EIP-712 signature | bound to trial, agent, run hash, deadline | Public | recovered signer == runner key |
| Struct hash | trial id, agent id, run hash, deadline | Public | `trials.RUN_TYPEHASH()` parity test |
| Deadline | signature expiry | Public | `sigDeadline`; reject if past |
| `touchesTests` check | agent's diff does not touch pinned suite | Public | SDK guard; fails closed |

**What it proves:** what work the agent actually submitted, signed and bound before the deadline.  
**Where to find it:** `submitRun` receipt; `packages/smith-sdk` EIP-712 parity test (`eip712-parity.test.ts`) confirms SDK digest == contract digest.  
**Rule:** never submit red — a failing test hands 30% of the bond to a skeptic. The SDK refuses to sign it.

---

## 7. Test execution evidence

| Field | Content | Classification | How to verify |
|---|---|---|---|
| Suite result | pass / fail per pinned suite | Confidential | Argus re-run (`packages/argus`) |
| Re-run determinism | same suite, same input, same outcome | Confidential | reproducible build + seed |
| Rubric use | LLM rubric only when the suite cannot decide | Confidential | `packages/argus/src/rubric.ts`; deterministic evidence outranks the rubric |

**What it proves:** whether the required acceptance criteria were met.  
**Where to find it:** Argus verifier output; `test execution evidence` is confidential unless the sponsor agrees to publish.  
**Related code:** `packages/argus`; ADR-0005 deterministic evidence first.

---

## 8. Skeptic and Argus records

| Field | Content | Classification | How to verify |
|---|---|---|---|
| Break filed | skeptic stake (1% of reward) | Public | `fileBreak` receipt; `BreakFiled` event |
| Skeptic address | `msg.sender` of `fileBreak` | Public | receipt `from` |
| Commit/reveal | 2-of-3 Argus votes | Public | `VoteCommitted`, `VoteRevealed`, `VerdictFinalized` |
| Dispute timeout | 3 days (`DISPUTE_TIMEOUT`); silence settles for the agent | Public | `finalize` after window |
| Outcome | Paid / Slashed / Refunded | Public | `VerdictFinalized` event; read model |

**What it proves:** whether the claim was independently challenged and adjudicated under the protocol.  
**Where to find it:** trial page `/trials/:id`; Argus seats (six bonded in demo; three on legacy escrow).  
**Related code:** `fileBreak`, `commitVote`, `revealVote`, `finalize`; ADR-0004 fixed Argus committee.

---

## 9. Settlement transaction

| Field | Content | Classification | How to verify |
|---|---|---|---|
| Transaction hash | `finalize` / `reclaimExpired` broadcast | Public | receipt |
| Settler | permissionless; any funded account | Public | receipt `from` |
| Verdict | Paid / Slashed / Refunded | Public | `VerdictFinalized` |
| Credits | agent / skeptic / treasury splits | Public | `credit[]` ledger reads |
| Idempotency | reverts if already settled | Public | second `finalize` reverts `AlreadySettled` |

**What it proves:** how the contract resolved the trial, exactly once.  
**Where to find it:** receipt; settlement is pull-only (recipient calls `withdraw()` separately — ADR-0003).  
**Rule:** settlement never pushes ETH. `_settle` credits the pull ledger.

---

## 10. Withdrawal transactions

| Field | Content | Classification | How to verify |
|---|---|---|---|
| Agent withdrawal | agent calls `withdraw()` for own credit | Public | receipt; `Withdrawn(agent, amount)` |
| Sponsor refund | sponsor withdraws refunded reward | Public | receipt; `Withdrawn(sponsor, amount)` |
| Skeptic payout | skeptic stake returned or split | Public | receipt; `Withdrawn(skeptic, amount)` |
| Treasury withdrawal | Treasury Safe calls `withdraw()` for its credit | Public | Safe transaction; `Withdrawn(treasury, amount)` |

**What it proves:** the parties received their credits in separate transactions.  
**Where to find it:** `withdraw()` receipts; treasury Safe on-chain history.  
**Rule:** no `withdrawTo(address)`, no backend sweeper, no arbitrary recipient (ADR-0020 §3).

---

## 11. Treasury reconciliation

| Field | Content | Classification | How to verify |
|---|---|---|---|
| Protocol fee | 5% of reward, deducted from agent payout | Public | `credit[treasury]`; `Withdrawn` events |
| Failed-break treasury share | skeptic stake 50% treasury / 50% agent when break fails | Public | settlement logic |
| Slashed-bond treasury share | 70% of bond to treasury on landing break | Public | settlement logic |
| Conservation invariant | `balance == totalStakes + totalPending + escrowed` | Public | `invariant_balanceConservation` (Invariants.t.sol:170) |
| Gas note | network gas is not protocol revenue | Public | never enters escrow accounting |

**What it proves:** protocol revenue was correctly accounted for, by outcome type — not inferred as a flat percentage of all rewards.  
**Where to find it:** indexer economics (`packages/indexer/src/api.ts` `buildEconomics`); `/escrow/:wallet` per-wallet books.  
**Related code:** `RewardMath.sol`; `test/RewardFlowInvariant.t.sol`; ADR-0020 §5 accounting.

---

## 12. Sponsor feedback

| Field | Content | Classification | How to verify |
|---|---|---|---|
| Outcome useful? | yes/no + summary | Confidential | sponsor sign-off |
| Limitations observed | what the trial did and did not show | Confidential | sponsor interview |
| Recommendations | next trial scope, budget, difficulty | Confidential | sponsor |
| Repeat intent | sponsor willing to fund another trial | Confidential | sponsor |

**What it proves:** the outcome was commercially useful — the strongest early commercial signal (memo §8).  
**Where to find it:** sponsor interview record (off chain); redacted summary may be published with permission.  
**Rule:** publish only with the sponsor's explicit, appropriately redacted permission (memo §3).

---

## Packaging rules

1. **One directory per trial:** `docs/evidence/<chain>-<trial-id>/` containing this template filled in, plus links (not copies) to confidential files.
2. **Public index only:** publish the public rows (items 2, 3, 4, 5, 6, 8, 9, 10, 11 hashes and outcomes); keep confidential items off the public index.
3. **No fabricated numbers:** a figure is read or it is not shown. Unknown renders `—`, never `0`.
4. **Verify before shipping:** every on-chain claim in this package must be checkable by re-reading the transaction receipt or contract getter. If it cannot be re-verified, it does not belong in the package.

---

## Verification commands

```bash
# Re-read a funded trial on chain
cast tx <createTrial-hash> --rpc-url <RPC>

# Check conservation on the deployed escrow
forge test --match-test invariant_balanceConservation

# Verify deployed bytecode matches the artifact
cast code <trials-address>
forge inspect CrucibleTrials deployedBytecode

# Read the pull ledger before withdrawal
cast call <trials-address> "credit(address)(uint256)" <wallet>
```

---

## Appendix: what this package is NOT

- Not an audit report. Static analysis, coverage and the test suite are internal gates (HARDENING.md, slither-triage.md); they do not replace an independent external audit of the exact deploy commit (§7 of the memo; see `docs/audit-plan.md`).
- Not commercial revenue. Test ETH, demo activity and unclaimed treasury credits are not revenue (memo §8).
- Not a guarantee of safety. Crucible is not an audited production financial protocol and does not certify an AI agent as safe or legally compliant (memo §2).
- Not the Colosseum pitch package (`docs/business/pitch/submission-package.md`); that is for the hackathon submission. This package evidences one completed sponsor trial.
