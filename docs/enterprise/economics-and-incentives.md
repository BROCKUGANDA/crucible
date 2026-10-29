# Economics and incentives

**Date:** 2026-10-29 · **Baseline:** `develop` @ `9deb3f2`

This document states the protocol's economics as they are **in the tree**, with
the file that owns each number, and it separates what is live from what is
dormant. It is the input to any future pricing change. It does **not** propose
new constants.

---

## 1. The matrix: two schedules, not one

The single most common way to get this repository wrong is to read one
`FEE_BPS` and assume it is the product's fee. There are two schedules, they
have different bases, and one of them is dormant.

| | **Legacy `CrucibleTrials`** | **v2 `Arena`** | **Solana `work-escrow`** |
|---|---|---|---|
| **Status** | **Live** on the demo chain | **Dormant** — no UI, no deployment | **Not compiled** — no SBF toolchain on the build host |
| **Fee rate** | `FEE_BPS = 500` = **5%** | `ARENA_FEE_BPS = 1500` = **15%** | `FEE_BPS = 500` = **5%** (mirrors the legacy law) |
| **Where the number lives** | `CrucibleTrials.sol` (a `constant`), recorded in `contract-spec.md` §5 | `params/crucible.params.json` → `fee_bps: 1500` → codegen → `Params.sol` | mirrors the legacy law |
| **Who pays** | the **agent** — deducted from its payout | the **sponsor** — charged *on top of* the reward | mirrors the legacy law |
| **Basis** | `payout = reward − fee`; the sponsor pays exactly the reward | `fee = (reward × ARENA_FEE_BPS) / BPS`; sponsor pays `reward + fee` | mirrors the legacy law |
| **Rounding** | integer division; remainder stays with the agent | floor; **the remainder stays with the sponsor** (`Arena.sol:321`) | mirrors the legacy law |
| **Why** | ADR-0002: native ETH, no invoicing | ADR-0011: the external PRD's 15%, kept in *data* rather than adopted | mirrors the legacy law, per ADR-0011's deviation note |
| **Canonical spec** | `crucible-contracts/docs/contract-spec.md` §5 | `params/crucible.params.json` | `docs/solana-spec.md` |

**The 15% is not a bug and not a "fix".** ADR-0001 rejects implementing the
external PRD's economics; ADR-0011 keeps the v2 arena's own number **in data
with a recorded derivation**, so that a reviewer reading only the legacy code
still finds a coherent 5% protocol, and so the 15% is visible without being
adopted. The brief's instruction — "never silently harmonise these" — is
satisfied by the tree as it stands.

**The fragility worth naming.** `fee_bps: 1500` is one line in the
parameter file that is the single v2 source, and the codegen emits it into
`Params.sol`. The only thing preventing it from being what the product charges
is that the Arena has no UI and no deployment. That is a thin guard on a
number the brief cares about a great deal. See §6.

## 2. The live flow table (legacy escrow)

Every row is `contract-spec.md` §5, and every row is exercised by the Foundry
suite (`crucible-contracts/test/CrucibleTrials.t.sol`, 85 tests) with the
conservation invariant asserted across all of them.

| Outcome | Trigger | Agent | Skeptic | Treasury | Sponsor | Alloy |
|---|---|---|---|---|---|---|
| **Paid** | no break, or break failed, or timeout | `reward − fee`; bond returned to free stake | stake split 50% agent / 50% treasury; recovers nothing | `fee` | — | wins count |
| **Slashed** | break wins on 2-of-3 | loses the bond; paid nothing | their stake + **30%** of the bond | **70%** of the bond | refunded the **full** reward, **no fee** | **−25%** |
| **Refunded** | expired without a run | bond returned to free stake if claimed | — | — | the **full** reward | — |

**No settlement path pushes ETH.** All three credit balances; `withdraw()` is
the only function in `CrucibleTrials` that calls `{value:}` (ADR-0003).

**Conservation:** `address(trials).balance == totalStakes + totalPending +
escrowed`, asserted exactly (`test/Invariants.t.sol:170`). The invariant suite
drives the contract through a handler with separate sponsor / operator /
skeptic / Argus actors, and asserts six properties rather than one.

### 2.1 The constants

| Constant | Value | Meaning |
|---|---|---|
| `MIN_BOND` | 0.01 ETH | minimum agent registration stake, and minimum reward |
| `BOND_NUM / BOND_DEN` | 1 / 5 | bond = 20% of reward, floored at `MIN_BOND` |
| `BREAK_STAKE_DEN` | 100 | break stake ≥ 1% of reward |
| `FEE_BPS` | 500 | 5%, deducted from the agent's payout |
| `SLASH_SKEPTIC_NUM` | 3,000 | 30% of the bond to a winning skeptic; 70% to treasury |
| `MIN_RUN_WINDOW` | 1 hour | minimum creation → deadline |
| `MIN_BREAK_WINDOW` / `MAX_BREAK_WINDOW` | 1 hour / 7 days | allowed skeptic window |
| `COMMIT_WINDOW` | 24 hours | dispute opens → seats must commit |
| `DISPUTE_TIMEOUT` | 3 days | after which `finalize` settles for the agent |
| `ARGUS_THRESHOLD` | 2 | two agreeing reveals settle a dispute |
| `MAX_REWARD` | 1,000 ETH | per-trial cap |
| `MAX_TOTAL_ESCROWED` | 10,000 ETH | whole-contract cap |

### 2.2 The v2 arena's parameters

From `params/crucible.params.json` — the single v2 source, with generated
artifacts committed and a codegen drift check in CI (gate 732):

`fee_bps: 1500` · `agent_bond_min_bps: 2000` (20%) · `skeptic_stake_min_bps: 100` (1%) ·
`break_prize_bps: 3000` (30%) · `claim_timeout_forfeit_bps: 1000` (10%) ·
`seat_fee_bps: 50` · `seat_bond_min_multiple_of_fees: 5` · `seat_slash_bps: 2000` ·
`argus_seats: 3` · `argus_quorum: 2` · `max_argus_rounds: 2` ·
`vote_commit_window_seconds: 86400` · `vote_reveal_window_seconds: 86400` ·
`standing_half_life_days: 45` · `season_length_days: 42` ·
`rounding: "floor_remainder_to_treasury"`.

The **legacy law is frozen as data**: `legacy_fee_bps_v1_frozen: 500` and
`legacy_break_split_v1_frozen: 5000` are records of the v1 law, and codegen
must emit them unchanged.

Note the **v2 base difference**: the arena charges the sponsor `reward + fee`
and floors the remainder to the sponsor, whereas the legacy law takes the fee
out of the agent's payout. Same rate arithmetic, different payer. Any
comparison of the two must state which base it is comparing.

## 3. Where the money is read, and why that matters

This is the part most likely to be got wrong by an integrator, so it is
recorded here explicitly.

**The API does not carry the fee.** `apps/api/src/server.ts` reads `FEE_BPS`
off the deployed contract (`readProtocolFee`), because it is a `constant` and
the host should not carry a copy that can drift from the chain.

**The settlement amounts come from the chain's own logs.** `packages/indexer/src/api.ts:365-395`
derives the fee as the difference between the escrowed reward and the payout
in `VerdictFinalized(id, Paid, reward − fee)`. The comment records exactly why:
re-deriving from `FEE_BPS` needed a second chain read, and when that read
failed the books published a fee of **zero** and a payout of the **full**
reward — a number the chain never charged, published as though measured.

**Unknown is null, never zero.** A failed constant read leaves
`protocolFeeBps` null and the rate is published as unknown; the settled
amounts, which come from the logs, are unaffected. The API's own comment names
the failure: the code "left the books at zero **and** published it, as
`feeBps: 0` and a fee of '0' ETH, which reads as a measured fact. Zero is not
an absent fee; it is a claim that the protocol charges nothing."

**Consequence for the enterprise work.** There is deliberately **no
canonical fee constant** in TypeScript to promote. `packages/eval/src/gates.ts`
exports `FEE_BPS_CANONICAL = 500` as a *policy band* for the eval gates
(`FEE_BAND_MIN = 100`, `FEE_BAND_MAX = 1000`), not as the protocol's rate.
Promoting either to "the canonical model" would reintroduce the drift the
chain read removes. The canonical model is therefore **two typed schedules**,
and the consumer states which one it means.

## 4. What the protocol does not have yet

Named plainly, because the brief asks for a flow table over every outcome and
failure mode, and this is what the tree actually has.

| Situation | Behaviour today |
|---|---|
| Judge (Argus) outage | A seat that never commits simply does not vote; the quorum of 2 needs two agreeing reveals, and `DISPUTE_TIMEOUT` (3 days) settles for the agent. **A crashed judge is a non-vote, and it favours the agent** — which is a deliberate design (timeout favours the agent) but is *not* the same as "the judge abstained". |
| Provider outage | **Not modelled.** The grader's providers (`grader/src/adapter.ts` + `anthropic`/`google`/`openai-compat`/`stub`) have no enterprise-level fallback policy; a failed run is a failed run. |
| Chain reorg | The indexer has explicit cursor semantics (ADR-0010: "next block", with `head + 1` distinguished from caught-up) but **no reorg-aware rollback** is implemented. |
| Underfunded vault | `MAX_TOTAL_ESCROWED` (10,000 ETH) is enforced on `createTrial`, `claimTrial` and `fileBreak`. There is no vault-level solvency monitor. |
| Duplicate transaction | Reverts: `claimTrial` requires `Open`, `fileBreak` requires `Judging`, and settlement paths check the trial's terminal state. |
| Stale indexer | `packages/indexer` publishes a `ready` flag and the API surfaces it; there is no "settled but not yet indexed" SLA. |
| Emergency pause | **Not implemented.** `contract-spec.md` §14 lists a treasury/owner multisig as a requirement, not a shipped thing. There is no pause function in either contract. |
| Off-chain credit | **Does not exist.** The pull ledger is on-chain and conservative; there is no off-chain credit ledger, so there is nothing to reconcile against the chain for enterprise billing. |

## 5. The tier ladder as economics

Alloy tiers are **earned**, not purchasable — the registry is soulbound and
the contract has no transfer path.

Two different tier functions exist, and the difference matters.

**On-chain (`AlloyRegistry.sol`, the authority).** Tier is derived from the
current epoch's `wins` and `survived` counters:

| Tier | Name | Requirement |
|---|---|---|
| 0 | **Unforged** | no wins |
| 1 | Iron | 1 win |
| 2 | Bronze | 3 wins |
| 3 | Steel | 10 wins **and** ≥1 survived break |
| 4 | Damascus | 25 wins **and** ≥3 survived |

`recordWin` increments `wins` and `lifetimeWins`; a slash decays `wins` by
25% (`r.wins = (r.wins * 3) / 4`) — but **never** `lifetimeWins`, so a
permanent adverse settlement is not silently erased from the lifetime record.
`TIER_NAMES` in `smith-sdk/src/abi.ts` mirrors the contract's five names.

**Off-chain (`packages/eval/src/ratings.ts` — `tierFor`).** A *different*
function, over a Bayesian rating rather than a win count:
`conservative(r) = mu − 3σ`, and the tier is a threshold on that (`≥10 → 1`,
`≥20 → 2`, `≥30 → 3`, `≥40 → 4`). This is the **evaluation-side** tier —
how hard a task is offered to an agent — and it is deliberately not the
on-chain reputation tier. The two must not be conflated: one is earned
reputation that is soulbound and decays on slash; the other is a difficulty
band derived from fit.

**The missing frontier tier.** The brief asks for five levels ending in a
frontier tier with stronger isolation, higher review gates and enhanced audit.
The tree has **five tiers ending at Damascus** — Iron, Bronze, Steel, Damascus
plus the unearned **Unforged** at 0 — and no frontier tier. The `Tier = 0|1|2|3|4`
type admits no sixth value. Granting one changes what a run must satisfy, so
it needs its own slice and its own ADR; it is not a documentation gap.

**Standing decays; adverse settlements do not.** `decayRating(r, periods, halfLife)`
with `standing_half_life_days: 45` and `season_length_days: 42` handles stale
performance on the evaluation side. On the chain, a slash decays the epoch
window but leaves `lifetimeWins` intact — the requirement that a *permanent
adverse settlement record* is never silently erased is satisfied
structurally: settlement history is append-only in the chain and in the indexer
projection, and the tier is a separate derived layer.

## 6. What must not change without an ADR and a migration plan

1. **Either fee schedule.** The 5% and the 15% are separate products'
   economics; a change to either is a protocol change.
2. **The base of a schedule.** Legacy takes the fee from the agent's payout;
   the arena charges the sponsor. Changing a base changes who is paid what.
3. **Any rounding rule.** `floor_remainder_to_treasury` is data, and the
   arena floors the remainder to the *sponsor*. Rounding is where money
   silently appears.
4. **`MIN_BOND`, `MAX_REWARD`, `MAX_TOTAL_ESCROWED`.** Caps and floors.
5. **The bond and stake percentages** (20% / 1%) and the **30/70** split.
6. **The withdrawal path.** ADR-0003 rejected push settlement; settlement
   credits a pull ledger and `withdraw()` is the only `{value:}` call.

## 7. The sequence the brief asks for

The brief says not to set financial constants by intuition, and this document
agrees: **no pricing change is proposed here.** The order is:

1. **S1 — the evaluation manifest** (ADR-0017, implemented). It records
   *which* schedule priced a run. Everything statistical depends on being
   able to compare runs, and comparison needs the schedule identity.
2. **S2 — two typed schedules, one consumer API.** Not a constant: a typed
   description of each schedule (id, version, rate, base, rounding, payer,
   receiver) and a consumer that states which one it means. The rates stay
   where they are — on the chain, or in `params/crucible.params.json` — and
   the typed schedules *reference* them.
3. **S3 — adversary simulation.** Stake splitting, Sybil, bribery, spam
   challenges and farming are all perturbations of these constants; changing
   a constant before simulating it is how the mechanism breaks.
4. **S4 — pricing proposal.** With published assumptions, a published
   equilibrium intuition, and independent security / legal / economic review.

---

*Related: [`assessment.md`](assessment.md) §1.1 and §2.4,
[ADR-0011](../adr/0011-crucible-v2-arena-edition.md),
[ADR-0017](../adr/0017-evaluation-manifest.md),
[`contract-spec.md`](../../crucible-contracts/docs/contract-spec.md) §5.*
