# Crucible — staged investor narrative

**Status:** narrative framework, not a commitment.  
**Principle:** the large market opportunity is the conclusion of a credible argument, not a substitute for one. Lead with evidence of one completed sponsor trial; scale only after it is verified.

This document stages how Crucible should be presented as evidence accumulates. It is the commercial counterpart to the technical evidence package (`docs/evidence/template.md`) and the release gates (ADR-0020).

---

## Stage 1 — Today: product development

**What to say:** Crucible is building an on-chain proving ground for AI agents. The demonstration exercises sponsor-funded trial logic, agent staking, signed evidence, independent challenges and settlement on a local development chain.

**What is true and checkable:**
- Chain: local Anvil, chain id 31337; contracts unaudited; nothing here is a legal, financial, or regulatory control (README, live-site disclaimer).
- Native ETH escrow, `FEE_BPS = 500` = 5% deducted from the agent payout, 20% agent bond, 1% break stake, 2-of-3 Argus (ADR-0001, ADR-0003).
- Pull-only settlement: `_settle` credits a pull ledger; the recipient calls `withdraw()` separately. No push-with-try/catch (ADR-0003).
- Conservation invariant: `address(trials).balance == totalStakes + totalPending + escrowed` (`test/Invariants.t.sol:188`).
- No privileged minter/settler role; `finalize` and `reclaimExpired` are permissionless and revert when already settled (AGENTS.md).
- 2752 tests (2423 TS + 329 Foundry); per-contract coverage gate; `npm run verify:all` is the one-command CI (AGENTS.md).
- `npm run demo` replays the full loop on a fresh local chain: deploy, two agents, four trials, one slashed, every agent linked to an ERC-8004 identity (README "For judges").

**What is NOT true and must not be said:**
- Not an independently audited production financial protocol.
- Not USDC, not Base, not a 15% fee, not Privy, not `POST /v1/verify` — that external PRD was explicitly rejected (ADR-0001).
- Not commercial revenue: test ETH, demo activity and unclaimed treasury credits are not revenue (memo §8).
- Not "mainnet-ready": the mainnet preflight refuses to pass until audit, legal, genesis, timelock and monitoring sign-offs exist (ADR-0020).

**The honest ask at this stage:** fund the first sponsor trial, or fund the audit that makes a capped real-money pilot possible.

---

## Stage 2 — Next: sponsor validation

**What to say:** A selected sponsor commits to a defined challenge. Crucible demonstrates the complete sponsor-to-settlement experience, produces an evidence package, and collects feedback on whether the result was commercially useful.

**The first sponsor trial's lifecycle (memo §3):**
1. Sponsor commitment — challenge, benchmark, evaluation conditions, reward, completion criteria.
2. Trial creation — spec and tests pinned; sponsor reviews reward, bond, fee and deadline.
3. Funding — escrow receives the approved reward; sponsor gets a transaction reference.
4. Agent participation — an independent agent claims with its own wallet and bond.
5. Execution — agent works in the controlled sandbox; runner records artifact, evidence, logs.
6. Verification — Crucible checks the submitted artifact and signature against the pinned spec, suite and trial identity.
7. Independent scrutiny — skeptic window; Argus 2-of-3 if challenged.
8. Settlement — contract reaches its documented outcome; credits recorded for agent, sponsor, skeptic, treasury.
9. Withdrawal and reconciliation — participants withdraw credits; sponsor receives the settlement record; treasury withdrawal independently verified.

**The evidence package (§5):** 12 items from sponsor agreement to treasury reconciliation, classified public/confidential, every on-chain claim re-verifiable from a receipt or contract getter. See `docs/evidence/template.md` and the test/demo example at `docs/evidence/example-testnet.md`.

**What this proves:** Crucible can take a sponsor from a problem definition to a verifiable, economically settled result — not a dashboard claim, but transactions, evidence and financial records.

**Commercial signal that matters:** one sponsor who pays for one trial, receives a valuable and verifiable outcome, and comes back to fund another (memo §8). Sponsor repeat rate is the first product-market-fit metric.

---

## Stage 3 — After security review: controlled production pilot

**What to say:** An independently audited and approved Ethereum deployment accepts a capped amount of real sponsor funding. A selected group of sponsors and agents participates under defined operating controls.

**Preconditions (ADR-0020 release gates 1–12; all required, none optional):**
1. External audit of the exact deploy commit; every critical/high finding closed or accepted by a named risk owner.
2. Treasury Safe verified: address, chain ID, Safe version, owners, threshold, modules, recovery procedure.
3. Owner Safe verified: on-chain `owner()` equals the approved Owner Safe; deployer EOA retains no authority.
4. Immutable destination check: `treasury()` equals the approved address for every enabled escrow.
5. Withdrawal rehearsal: testnet lifecycle credits the treasury; a Safe transaction calls `withdraw()`; independently verified.
6. Outcome matrix: Paid / Slashed / Refunded reconcile all credits with no double-credit or invented fee.
7. Ledger invariant: every state transition preserves conservation; a mismatch is a release blocker.
8. Operational monitoring: treasury credit, withdrawals, settlement lag, indexer sync, keeper heartbeats, named on-call.
9. Legal and company readiness: entity, counsel, terms, privacy, jurisdiction signed.
10. Progressive exposure: named genesis cohort, low ETH epoch cap; raising the cap needs a clean epoch and release approval.
11. Mainnet preflight: refuses unsigned/incomplete sign-offs, wrong chain, incorrect fees, wrong treasury/owner, non-Safe treasury, missing code, invalid threshold, unverified bytecode.
12. Founder release approval: no mainnet funding or cap increase merely because an ADR or PR exists.

**What stays unchanged in the pilot:** native ETH only, `FEE_BPS = 500` legacy / `ARENA_FEE_BPS = 1500` Arena (kept distinct, ADR-0019), no token, no bridge, no ERC-20 on the escrow, no `withdrawTo` or arbitrary recipient.

**The cap:** selected through a documented risk assessment, not chosen to look commercially impressive (memo §4).

---

## Stage 4 — Commercial expansion

**What to say:** Only after repeated usage and commercial evidence does the larger marketplace and network-effect thesis become the centre of the investment story.

**What to measure (memo §8):**
- Sponsors committing real challenges — actual demand
- Funded trials — willingness to pay
- Successful trial completion rate — product reliability
- Independent agent participation — marketplace health
- Independent challenges — evaluation credibility
- Settlement completion rate — financial and protocol reliability
- Sponsor repeat rate — product-market fit
- Time from trial posting to settlement — operational efficiency
- Cost per completed trial — unit economics
- Realised protocol revenue — monetisation
- Cost of acquiring and servicing sponsors — commercial scalability

**What not to present as traction:** demo activity, test ETH, projected escrow volume, unclaimed treasury credits, or a 15%/USDC pivot that was rejected (ADR-0001).

**When the narrative changes:** once one sponsor pays, one agent completes, one skeptic independently tests, and one investor sees the audit, deployment controls, transaction evidence and accounting reconciliation. Then — and only then — the conversation shifts from "what Crucible might do" to "what Crucible has done."

---

## What this narrative is not

- Not a valuation ask. `docs/business/valuation-and-raise.md` is a research-backed proposal, not the ask; the founder alone sets amount, instrument and valuation.
- Not a guarantee of safety. Crucible does not certify an AI agent as safe or legally compliant (memo §2).
- Not a substitution of future scale for present evidence. The large opportunity is the conclusion, not the argument.

## Related

- `docs/business/investor-faq.md` — 60-second answers: why on-chain, revenue, no token, risks, how to verify.
- `docs/business/plan.md` — problem, money loop, model, moat, traction, honest limits.
- `docs/evidence/template.md` — the 12-item evidence package.
- `docs/adr/0020-company-treasury-safe-and-mainnet-release-gate.md` — release gates 1–12.
- `docs/adr/0001-agent-proving-ground.md` — the rejected USDC/Privy/15% pivot.
