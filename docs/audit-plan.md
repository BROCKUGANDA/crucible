# External Audit Plan — Crucible

**Status:** plan (not a report). This document scopes the independent audit required before any
real-value deployment. It is not itself an audit, and nothing in HARDENING.md, scripts/audit-gate.mjs,
scripts/coverage-gate.mjs, or the test suite substitutes for one.

**Memo reference:** §7 "The audit plan should be a visible deliverable".  
**Contract law:** native ETH only, `FEE_BPS = 500` (5%), 20% agent bond, ≥1% skeptic stake, 2-of-3 Argus,
pull-only settlement. ADR-0001 rejects the USDC/Privy/15% pivot; ADR-0019 keeps the legacy 5% and v2 Arena
15% schedules distinct. ADR-0020/0021 (proposed) define the Treasury Safe / Owner Safe release gates.

---

## 1. What "independent audit" means here (and what it does not)

The following are **internal gates**, not an independent audit, and must not be described as one:

| Internal gate | What it proves | Why it is not an audit |
|---|---|---|
| `scripts/audit-gate.mjs` | npm advisories reconciled against npm's own summary, per-package severity ceilings | dependency hygiene only; no contract logic, no economics |
| `scripts/coverage-gate.mjs` | per-contract line/statement/branch floors from `forge coverage --ir-minimum` | test coverage of existing suites; says nothing about missing invariants or wrong economics |
| `crucible-contracts/test/*.t.sol` + `Invariants.t.sol` | state-machine behavior, conservation equality, fuzzed transitions | written by the same team that wrote the contracts; same assumptions, same blind spots |
| `crucible-contracts/docs/slither-triage.md` | static-analysis findings, each justified | static analysis, not exploitability; false positives and false negatives both possible |
| `test/Fork.t.sol` (ERC-8004, mainnet fork, opt-in) | real registry read/write against mainnet | integration with one external registry; not an audit of Crucible's escrow |

An independent audit is a review of the exact release commit by a party that did not write the code,
with a written report, named findings, severity ratings, named risk owners for any accepted finding,
and a requirement that post-audit contract changes restart audit scope.

---

## 2. The exact-release rule

**The audit applies to the exact release commit — nothing else.**

- The audited artifact is the deployed bytecode of `CrucibleTrials.sol` (and, if in scope,
  `Arena.sol`, `ArgusCourt.sol`, `VerificationReceipt.sol`, `AlloyRegistry.sol`,
  `ReputationBridge.sol`) at one specific git SHA, verified on-chain via `cast code` vs
  `forge inspect deployedBytecode` (CBOR metadata stripped), as recorded in HARDENING.md.
- `FEE_BPS = 500` must be read from the deployed contract at that commit, not assumed
  (`test_FeeBpsIsFiveHundredNotFifteenHundred`). A report that does not name the audited fee
  constant is auditing a different contract.
- **Any post-audit contract change restarts audit scope.** The same commit rule applies to
  scripts that deploy or assert the deployment (`Deploy.s.sol`, `assert-deployment.sh`,
  `seed-content.mjs`) and to the params codegen (`params/crucible.params.json`,
  `scripts/params-codegen.mjs`) because a changed parameter is a changed economics law.
- A report on an earlier commit cannot certify a changed deployment. This is explicit in ADR-0001
  and ADR-0019, and it is enforced by `mainnet-preflight.mjs`, which refuses wrong fees,
  wrong treasury, wrong owner, missing contract code, and unverified deployment bytecode.

---

## 3. Audit scope A — smart contracts (money)

The following rows are the audit scope for the escrow protocol. Each row names the contract area,
what the auditor must verify, and where the repo's own law lives so the audit has something to
check against.

| # | Area | What to verify | Repo law / evidence |
|---|---|---|---|
| A1 | Escrow accounting | `address(trials).balance == totalStakes + totalPending + totalEscrowed` holds at every state transition, including failed transitions and reverts | `test/Invariants.t.sol:188` `invariant_balanceConservation`; `contract-spec.md` §9 |
| A2 | Balance conservation | No ETH enters or leaves except through `createTrial`/`msg.value`, `claimTrial`, `fileBreak`, `withdraw`; no `receive()`, no passive ETH intake, gas never enters accounting | `CrucibleTrials.sol` payable functions; ADR-0002 |
| A3 | Agent bonds | Bond = 20% of reward, floor `MIN_BOND = 0.01 ETH`; bond moves into escrow at claim; returned to agent on paid/timeout; split on slash | `CrucibleTrials.sol` `BOND_NUM/BOND_DEN`; `RewardMath.sol`; `RewardFlowInvariant.t.sol` |
| A4 | Skeptic stakes | Break stake ≥1% of reward; on failed break, stake split 50% agent / 50% treasury; skeptic recovers nothing | `BREAK_STAKE_DEN = 100`; `CrucibleTrials.sol:715-716` |
| A5 | Settlement fee | `FEE_BPS = 500` = 5% deducted from agent payout at settlement; treasury credit = fee; sponsor pays exactly the reward | `FEE_BPS = 500`; `test_FeeBpsIsFiveHundredNotFifteenHundred` |
| A6 | Slash conditions | Break wins: sponsor refunded full reward (no fee); bond split 30% skeptic / 70% treasury; agent loses bond, paid nothing; Alloy decays 25% | `_settleSlash`; `SLASH_SKEPTIC_NUM = 3_000` |
| A7 | Settlement & withdrawal | Settlement credits a pull ledger; `withdraw()` reads `credit[msg.sender]`, clears it, sends ETH to `msg.sender` only; no `to` argument; settlement runs once; `finalize`/`reclaimExpired` revert when settled | ADR-0003; `credit[]` ledger; `withdraw()` |
| A8 | Refund conditions | Expired unclaimed trial: sponsor reclaims via `reclaimExpired`; deadline-passed unclaimed trial refunds reward to sponsor | `reclaimExpired`; state machine `contract-spec.md` §3 |
| A9 | Permissionless finalization | `finalize` and `reclaimExpired` callable by anyone; idempotent revert when already settled; warden retries per-trial so one bad trial never stops the others | ADR-0003; `packages/warden/src/warden.ts:18-21` |
| A10 | Argus commit/reveal | Exactly 3 constructor-verified, distinct, non-zero seats; `COMMIT_WINDOW` clock closes commitments (one seat cannot disenfranchise the other two); 2-of-3 threshold settles; no-show seat slashed once per seat per panel | ADR-0004; `ARGUS_THRESHOLD = 2` |
| A11 | Argus timeout | `DISPUTE_TIMEOUT = 3 days`; silence settles for the agent; burden of proof on the skeptic | `CrucibleTrials.sol` dispute timeout |
| A12 | Role / registry config | Owner can only set/unset optional reputation bridge and identity registry; owner cannot withdraw escrow or change immutable treasury; treasury is immutable constructor argument, zero address rejected, no setter | `CrucibleTrials.sol` constructor; ADR-0021 |
| A13 | Reentrancy / signatures | No external calls on settlement path; checks-effects-interactions ordering; EIP-712 run artifacts bound to trial/agent/run hash/deadline; high-`s` rejected; no replay of submitted run | `CrucibleTrials.sol` `submitRun`; `packages/smith-sdk` EIP-712 parity test |
| A14 | Boundary conditions | `MAX_REWARD = 1000 ETH` fat-finger cap; `MAX_TOTAL_ESCROWED = 10,000 ETH`; `MIN_RUN_WINDOW`/`MAX_BREAK_WINDOW`; zero CID, zero runner key, zero run hash, zero break proof all rejected | contract input guards |
| A15 | Economic attack scenarios | Skeptic griefing cost (1% stake, 50% forfeited on failed break); self-break blocked (`SelfBreak`); colluding pair nets −0.5% of reward; stranger ballot growth rejected (`NotSeat`) | `game-theory.md` §5; `CrucibleTrials.sol:560` `SelfBreak` |

**Deliverable A:** a written report naming every finding (fixed, accepted with named risk owner, or rejected), the audited commit SHA, and the deployed bytecode hash verified on-chain.

---

## 4. Audit scope B — application and infrastructure

The off-chain surfaces that touch the money path or the evidence path:

| # | Area | What to verify | Repo location |
|---|---|---|---|
| B1 | Wallet connection & tx handling | API holds no chain key; no route can move funds; all signing happens in the connected wallet via `useTx().send()` from gesture handlers only (no `useEffect` sends) | ADR-0006; `apps/api/src/app.ts`; `apps/web/src/lib/useTx.ts` |
| B2 | API authentication & authorization | SIWE challenge stored (never rebuilt), byte-identical replay on retry, `AUTH_SECRET` required (no default key), origin bound to config not request header, per-IP rate limiter on every request, bounded bodies (16 KiB) | `apps/api/src/auth.ts`; `apps/api/src/rate-limit.ts` |
| B3 | Agent identity & signature binding | Runner key signs EIP-712 `Run` digest; bound to trial/agent/run hash/deadline; `setRunner` required before `submitRun` (`NoRunner` otherwise); registry mints to caller (operator registers own identity) | `CrucibleTrials.sol` `RUN_TYPEHASH`; `packages/smith-sdk` EIP-712; ADR-0006 |
| B4 | Sandbox isolation & resource limits | Agent runs in sealed sandbox (`--network=none`, read-only rootfs, memory/CPU caps); egress allowlist enforced before any request; no `fs`/`child_process`/`net`/`tls`/`crypto` in harness module graph (gate 502) | `packages/forge-runner/src/sandbox.ts`; `packages/forge-runner/src/egress.ts`; `packages/harness/src/import-lint.ts` |
| B5 | Content integrity & availability | Spec/test bytes pinned through `ContentService`, digest→CID→bytes verified round-trip; digest-pinned fixtures; disclosure log maps keccak digest to CID | `scripts/seed-content.mjs`; `packages/cidstore`; `apps/api/src/content.ts` |
| B6 | Indexer reorg handling | Forward-only cursor, reorg replay, quiet-tail proof, bloom cross-check, atomic cursor write (temp+rename), stalled backfill detection | ADR-0010; `packages/indexer/src/scribe.ts` |
| B7 | Redis queue reliability & idempotency | Warden sweeps per-trial with independent retry; keeper submits permissionless lifecycle transactions; one bad trial never stops the rest | `packages/warden/src/warden.ts`; `apps/keeper/src/main.ts` |
| B8 | Database permissions & tenant isolation | Single-tenant in-memory indexer (ADR-0008); no cross-tenant reads; org membership (ADR-0022, proposed) derived from store per request, never trusted from client | `packages/indexer`; `packages/agent-security/src/org-store.ts` |
| B9 | Treasury administration | Treasury Safe withdraws only its own `credit[Safe]` via `withdraw()`; no `withdrawTo`, no backend sweeper, no arbitrary recipient; fee revenue classified by outcome type (fee vs failed-break share vs slash share) | ADR-0020 §3, §5; `CrucibleTrials.sol` |
| B10 | Secrets handling & incident response | No chain key in API; no secrets in git (gitleaks on full history); secrets in `.env`/host only; severity taxonomy + escalation paths + on-call naming | ADR-0006; `.gitleaks.toml`; `packages/agent-security/src/incident.ts` |

**Deliverable B:** written report with findings mapped to the rows above, plus the exact config hashes (`.env` shape without values, `params/crucible.params.json` hash, `params/generated/Params.sol` hash).

---

## 5. Audit scope C — operational readiness

| # | Area | Requirement | Repo status |
|---|---|---|---|
| C1 | Multisignature governance | Treasury and Owner are company-controlled Safes; 2-of-3 threshold for initial pilot; distinct owners, separate hardware-backed keys, independent recovery; no N-of-N; no multiple signer keys on one device/seed | ADR-0020 §1, §4 (proposed) |
| C2 | Timelock configuration | Documented timelock for any future privileged configuration changes; no privileged minter/settler role (deleted on purpose) | ADR-0020 (proposed); AGENTS.md |
| C3 | Backups & restoration tests | Documented backup/restore procedure; restoration tested; indexer cursor and content store included | ADR-0008 (in-memory — defer persistence decision) |
| C4 | RPC redundancy | Primary + fallback mainnet RPC; `eth_chainId` checked before any fork run; fallback tried only after primary fails; chain-id-1 endpoint that prunes the pinned block is not a fork endpoint | `scripts/run-fork-tests.mjs`; `.env.example` |
| C5 | Monitoring & alerting | Treasury-credit balance, withdrawal amount, unexpected Safe config changes, settlement lag, indexer sync errors, keeper/warden heartbeats, conservation — monitored with named on-call coverage | `mainnet-preflight.mjs` (proposed); HARDENING.md |
| C6 | Emergency trial-intake controls | Off-chain control to stop new trials without blocking existing participants' settlement or withdrawal rights; kill switch fails closed; settlement/withdrawal never blocked | `packages/agent-security/src/kill-switch.ts`; `apps/api/src/app.ts` middleware; `docs/runbooks/emergency-intake.md` |
| C7 | Signer-loss & recovery procedures | Key-loss handling, signer rotation, recovery path that does not require contract upgrade (immutable by design) | `docs/key-inventory.md` §"What changes on a real chain" |
| C8 | Documented mainnet release approval | Mainnet preflight refuses unsigned/incomplete sign-offs (audit, legal, genesis, timelock, monitoring); founder approval required; no deployment merely because an ADR or PR exists | `scripts/mainnet-preflight.mjs`; ADR-0020 §12 |

**Deliverable C:** an operational readiness checklist signed by named owners, plus the mainnet preflight output showing all gates pass (or are explicitly deferred with named owners and dates).

---

## 6. What the audit must NOT be asked to certify

Per ADR-0001 and ADR-0019, the audit scope **explicitly excludes**:

- **USDC / ERC-20 / ERC-721 / any token** on the escrow. Native ETH only.
- **15% fee.** Legacy fee is 500 bps (5%); the v2 Arena's 15% is a separate, parameterized schedule in `params/crucible.params.json` and is not in scope for the legacy audit unless Arena is separately approved for release.
- **15-minute fee or Privy / embedded wallets / `POST /v1/verify`.** These are the rejected external PRD (ADR-0001).
- **A pause, upgrade mechanism, or privileged recovery.** Immutability is deliberate; the production architecture uses multisig + timelock + off-chain intake control instead (ADR-0020).

---

## 7. Release gates required before real value (all required, none optional)

Per ADR-0020 §14, mirrored here so the audit plan references the enforcement point:

| # | Gate | Enforced by |
|---|---|---|
| G1 | External audit of the exact deploy commit; every critical/high finding closed or accepted by named risk owner; post-audit changes restart audit scope | `scripts/mainnet-preflight.mjs` |
| G2 | Treasury Safe verified: address, chain ID, canonical Safe version, owners, threshold, modules, guard, fallback handler, recovery procedure, independently checked | mainnet preflight |
| G3 | Owner Safe verified: deployed `owner()` equals approved Owner Safe; deployer proves Safe is constructor caller; no EOA retains authority | ADR-0021; mainnet preflight |
| G4 | Immutable destination check: `treasury()` equals approved address for every enabled escrow; mismatch or absent code fails closed | mainnet preflight |
| G5 | Withdrawal rehearsal: testnet lifecycle credits treasury; Safe transaction calls `withdraw()`; Safe receives exact credit (gas separate); independently verified | ADR-0020 §5 |
| G6 | Outcome matrix: Paid / Slashed / Refunded + Arena outcomes reconcile all credits with no double-credit, missing credit, or invented fee | `RewardFlowInvariant.t.sol`; contract-spec.md §5 |
| G7 | Ledger invariant: every state transition preserves exact conservation; mismatch is a release blocker and incident | `Invariants.t.sol:188` |
| G8 | Operational monitoring: treasury credit, withdrawals, settlement lag, indexer sync, keeper/warden heartbeats, conservation, named on-call | `scripts/mainnet-preflight.mjs` |
| G9 | Legal and company readiness: entity, counsel, terms, privacy, jurisdiction, product permissions reviewed and signed | — (human sign-off) |
| G10 | Progressive exposure: named genesis cohort, low ETH epoch cap; lowering immediate, raising requires clean epoch + documented review + release approval | ADR-0020 §10 |
| G11 | Mainnet preflight: refuses unsigned/incomplete sign-offs, wrong chain, incorrect fees, wrong treasury/owner, non-Safe treasury, missing code, invalid signer threshold, unverified bytecode | `scripts/mainnet-preflight.mjs` |
| G12 | Founder release approval: no production deployment, mainnet funding, or cap increase merely because an ADR or PR exists | ADR-0020 §12 |

---

## 8. Evidence standards

- **On-chain evidence:** every financial claim checkable from a transaction receipt or contract getter (`cast tx`, `cast call`, `cast code`).
- **Off-chain evidence:** audit report PDF, signed by the auditing firm; treasury Safe configuration screenshot/export; withdrawal rehearsal transaction hashes; preflight output log.
- **Unknown renders `—`, never `0`:** zero is a measurement; nothing is not (display rule, `apps/web/src/lib/ops.ts`, `clock.ts`).

---

## 9. What this plan is not

- Not an audit report. This plan scopes one; it does not perform one.
- Not commercial revenue. Test ETH, demo activity, and unclaimed treasury credits are not revenue (memo §8).
- Not a safety guarantee. Crucible is not an audited production financial protocol and does not certify an AI agent as safe or legally compliant (memo §2; `SECURITY.md`).

---

## Related

- `docs/adr/0020-company-treasury-safe-and-mainnet-release-gate.md` — release gates G1–G12
- `docs/adr/0021-explicit-owner-constructor-for-crucible-trials.md` — Owner Safe constructor
- `docs/adr/0001-agent-proving-ground.md` — rejected USDC/Privy/15% pivot
- `docs/adr/0003-pull-payments.md` — settlement never pushes ETH
- `docs/adr/0006-wallet-signed-api-no-chain-keys.md` — API holds no chain key
- `docs/adr/0011-crucible-v2-arena-edition.md` — separate v2 fee schedule (15%)
- `docs/adr/0019-both-fee-schedules-legible.md` — both fees remain distinct
- `docs/HARDENING.md` — internal verification register (not an audit)
- `scripts/audit-gate.mjs` — dependency gate (not an audit)
- `scripts/coverage-gate.mjs` — per-contract coverage floors (not an audit)
- `scripts/mainnet-preflight.mjs` — release gate enforcement (G1, G4, G11)
