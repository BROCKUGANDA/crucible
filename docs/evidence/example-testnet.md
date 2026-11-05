# Sponsor Trial Evidence Package — Example (test/demo only, NOT real money)

**Project:** Crucible — On-Chain Proving Ground for AI Agents  
**Chain:** local Anvil (chain id 31337) — worthless test ETH  
**Trial IDs:** 1–4 (from `scripts/Demo.s.sol` seed)  
**Status:** EXAMPLE — populated from the local Anvil demo; addresses and hashes are deterministic on a fresh Anvil but have no real value  
**Date generated:** 2026-11-05  

---

⚠️ **This is a demonstration on a local development chain. The contracts are unaudited and nothing here is a real-money commercial settlement.** Per memo §4, a capped real-money Ethereum pilot follows only after an independent audit and the ADR-0020 release gates. Do not cite this example as evidence of commercial traction.

---

## 1. Sponsor agreement and trial brief

| Field | Content | Classification |
|---|---|---|
| Sponsor | demo sponsor (Anvil genesis account #6) | Confidential (demo) |
| Trial brief | four identical trials: solve the pinned `counter` fixture; acceptance = suite passes | Confidential (demo) |
| Acceptance test | pinned Forge suite in `crucible-contracts/fixtures/trials/counter` | Confidential (demo) |
| Redacted brief for publication | "counter reconciliation challenge; suite pass = success" | Public |

**Notes:** demo spec/suite digests come from `SeedContent.SPEC_HASH` / `SeedContent.TESTS_HASH`, pinned through `scripts/seed-content.mjs`. Four trials share one fixture; they differ by what the agents claimed and how they settled, not by what was asked.

---

## 2. Funded-trial transactions

All four trials: reward = 1 ETH (10⁻¹⁸ wei), created by the sponsor, `createTrial{value: 1 ether}`.

| Trial | Tx hash | Block | Status |
|---|---|---|---|
| 1 | `<createTrial-tx-1>` | `<block>` | funded |
| 2 | `<createTrial-tx-2>` | `<block>` | funded |
| 3 | `<createTrial-tx-3>` | `<block>` | funded |
| 4 | `<createTrial-tx-4>` | `<block>` | funded |

**Contract address:** `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` (`CrucibleTrials`, deterministic on fresh Anvil per README)  
**Treasury:** deployer address (demo); on production this must be the approved Treasury Safe (ADR-0020)  
**Verification:** `cast tx <hash>`; cross-check `TrialCreated` events in the indexer snapshot (`/snapshot`, `/trials/:id`).

---

## 3. Contract address and verified source

| Field | Content |
|---|---|
| `CrucibleTrials` address | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| `AlloyRegistry` address | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| Bytecode verification | `cast code <addr>` vs `forge inspect deployedBytecode` (CBOR stripped) — recorded in HARDENING.md |
| Source commit | `git rev-parse HEAD` at demo run |
| `FEE_BPS` | 500 (5%) — `test_FeeBpsIsFiveHundredNotFifteenHundred` |
| Compiler | pinned Foundry v1.8.5 (`scripts/run-forge.mjs`) |

---

## 4. Specification and test digests

| Field | Content |
|---|---|
| Spec digest | `SeedContent.SPEC_HASH` (pinned fixture `crucible-contracts/fixtures/trials/counter`) |
| Tests digest | `SeedContent.TESTS_HASH` |
| Pinning process | `scripts/seed-content.mjs` via `ContentService`; resolves each digest back out of the store |
| Digest-pinned rule | changing one byte of the fixture changes the keccak digest already committed on chain |

---

## 5. Agent claim transactions

Demo agents: A and B (Anvil genesis accounts #4, #5), each stakes 1 ETH bond (20% of 5 ETH would exceed; demo uses 1 ETH reward → 0.2 ETH bond; the script uses 1 ETH for both reward and bond for simplicity — see `_forgeAgent`).

| Trial | Agent | Tx hash | Bond |
|---|---|---|---|
| 1 | A | `<claim-tx-1>` | `<bond>` |
| 2 | B | `<claim-tx-2>` | `<bond>` |
| 3 | B | `<claim-tx-3>` | `<bond>` |
| 4 | A | `<claim-tx-4>` | `<bond>` |

**Runner key:** `0xA11CE` (demo synthetic key, signs EIP-712 digests only, never funds transactions)

---

## 6. Signed run artifacts

Demo run hashes are synthetic (`keccak256("RunArtifact{all-pass}")`, `{fails-suite}`, `{quiet}`), NOT real runner output — recorded honestly in `Demo.s.sol`: "A demo hall therefore has resolvable demands and synthetic answers."

| Trial | Agent | Run hash | Signature | Verdict |
|---|---|---|---|---|
| 1 | A | `keccak256("RunArtifact{all-pass}")` | runner-signed | Paid (withstood break) |
| 2 | B | `keccak256("RunArtifact{all-pass}")` | runner-signed | Paid (withstood break) |
| 3 | B | `keccak256("RunArtifact{fails-suite}")` | runner-signed | Slashed (break landed) |
| 4 | A | `keccak256("RunArtifact{all-pass}")` | runner-signed | Paid (uncontested, window closed) |

**EIP-712 parity:** `packages/smith-sdk/test/eip712-parity.test.ts` confirms SDK digest == contract digest; reordering a struct field turns five tests red.

---

## 7. Test execution evidence

| Trial | Suite result | Deterministic re-run | Rubric used? |
|---|---|---|---|
| 1 | pass | yes | no |
| 2 | pass | yes | no |
| 3 | fail (agent's run fails the suite) | yes | no |
| 4 | pass | yes | no |

**Note:** demo evidence is synthetic. A real sponsor trial substitutes actual Argus re-run output from `packages/argus`.

---

## 8. Skeptic and Argus records

Demo skeptic: Anvil genesis account #7. Demo Argus seats: genesis accounts #1, #2, #3 (2-of-3).

| Trial | Break filed? | Skeptic stake | Argus votes | Outcome |
|---|---|---|---|---|
| 1 | yes | 1% of reward | seat 1: reject; seat 2: reject | 2-of-3 → agent wins |
| 2 | yes | 1% of reward | seat 1: reject; seat 2: reject | 2-of-3 → agent wins |
| 3 | yes | 1% of reward | seat 1: accept; seat 2: accept | 2-of-3 → agent slashed |
| 4 | no | — | window closed (silence) | agent wins by timeout |

**Dispute timeout:** 3 days (`DISPUTE_TIMEOUT`); silence settles for the agent (trial 4).  
**Related code:** `fileBreak`, `commitVote`, `revealVote`, `finalize`; ADR-0004 fixed Argus committee.

---

## 9. Settlement transactions

| Trial | Settler | Verdict | Credits (agent / skeptic / treasury) |
|---|---|---|---|
| 1 | relayer (permissionless) | Paid | agent: reward − 5% fee; skeptic: stake returned + 50% of failed break; treasury: 5% fee + 50% of failed break |
| 2 | relayer | Paid | same split |
| 3 | relayer | Slashed | agent: bond slashed (70% treasury / 30% skeptic); sponsor: full reward refunded |
| 4 | relayer | Paid (timeout) | agent: reward − 5% fee; bond returned |

**Settlement is pull-only:** each recipient calls `withdraw()` separately (ADR-0003). `finalize` reverts `AlreadySettled` if repeated (idempotency).

---

## 10. Withdrawal transactions

| Trial | Party | Tx hash | Amount |
|---|---|---|---|
| 1 | agent A | `<withdraw-1>` | reward − fee |
| 1 | skeptic | `<withdraw-1b>` | stake + 50% break |
| 1 | treasury | `<withdraw-1c>` | fee + 50% break |
| 3 | treasury | `<withdraw-3>` | 70% of slashed bond |
| … | … | … | … |

**Rule:** no `withdrawTo`, no backend sweeper (ADR-0020 §3). Treasury Safe calls `withdraw()` for its own credit only.

---

## 11. Treasury reconciliation

| Item | Amount | Basis |
|---|---|---|
| Protocol fees (trials 1, 2, 4) | 5% × 1 ETH × 3 | 500 bps deducted from agent payouts |
| Failed-break treasury share (trials 1, 2) | 50% × 1% × reward each | skeptic stake split 50/50 agent/treasury |
| Slashed-bond treasury share (trial 3) | 70% of bond | landing break split 30% skeptic / 70% treasury |
| Conservation invariant | `balance == stakes + credits + escrow` | `invariant_balanceConservation` (Invariants.t.sol:170) |

**Gas is not protocol revenue** — never enters escrow accounting.  
**Related code:** `RewardMath.sol`; `test/RewardFlowInvariant.t.sol`; ADR-0020 §5.

---

## 12. Sponsor feedback

| Item | Content (demo) |
|---|---|
| Outcome useful? | yes — demonstrates end-to-end loop on local Anvil |
| Limitations observed | run hashes synthetic (no real agent execution); keys from published dev mnemonic; no clock travel for `finalize` on fresh chain (see `Demo.s.sol` `_paidUncontested` note) |
| Recommendations | run `npm run agent:live` for real agent execution against a real model before any real-money pilot |
| Repeat intent | demo only; no real sponsor |

---

## Packaging rules (from template)

1. One directory per trial: `docs/evidence/<chain>-<trial-id>/`.
2. Public index only publishes public rows; confidential items stay off the public index.
3. No fabricated numbers: unknown renders `—`, never `0`.
4. Every on-chain claim must be re-verifiable from a receipt or contract getter.

---

## What this example is NOT

- Not an audit report — internal gates only (HARDENING.md, slither, coverage).
- Not commercial revenue — test ETH on local Anvil.
- Not a safety guarantee — contracts unaudited; Crucible does not certify agents.
- Not the Colosseum pitch package (`docs/business/pitch/submission-package.md`).
