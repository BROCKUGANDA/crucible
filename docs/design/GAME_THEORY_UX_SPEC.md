# Game Theory UX Spec — The Strategium

**Status:** spec — design intent and honesty constraints for the game-theory surface  
**Stage:** F (follows A–E)  
**Applies to:** trial economics display, challenger support, sponsor configuration,
and any future `PayoffMatrix`

---

## 0. The one law of this surface

**Nothing on the Strategium is estimated.** Every number shown is either:

- read from the chain (reward, bond, stake floor, fee, deadlines, committee
  size, timeout), or
- stated by the sponsor's spec (objective, capabilities, eligibility), or
- an explicit label saying the data is not available.

No probabilities. No "expected value". No success rate unless the indexer
actually computes one (it does not, today). Where a quantity is unavailable,
this surface says so in words: `Not enough historical data`.

## 1. What every trial economics panel must show

Sourced from the trial row (`ApiTrial`), hydrated from chain logs:

| Figure | Source | Display rule |
|---|---|---|
| Sponsor reward | `rewardEth` / `rewardWei` | `formatEth`, tabular numerals |
| Agent bond | `bondEth` | ≥ 1/5 of reward enforced by contract (`BOND_DEN = 5`) |
| Challenger stake floor | `MIN_STAKE = 1%` of reward (contract constant) | state as rule, not measurement |
| Challenger payout | 30% of bond (`SLASH_SKEPTIC_NUM = 3000` of `BPS`) | stated as the rule, remainder noted as treasury |
| Protocol fee | `FEE_BPS = 500` → `5% · 500 bps` | always both units, never "15%" |
| Submission deadline | `deadlineAt` (epoch) | countdown anchored to chain clock |
| Skeptic window | `breakWindowEndsAt` | countdown anchored to chain clock |
| Committee | 2-of-3, threshold 2 | stated, with `DISPUTE_TIMEOUT = 3 days` fallback |
| Settlement | pull ledger | "recipient calls `withdraw()`" — never implies push |

## 2. The three payoffs, drawn from what actuated

The conceptual payoff matrix for a trial, all cells bound to contract constants:

| | Agent succeeds | Agent fails |
|---|---|---|
| **Agent** | Reward − 5% fee; bond returned | Bond forfeited (split 30/70 skeptic/treasury) |
| **Sponsor** | Outcome delivered; pays reward + escrow | Refund in full (fee returned too if broken before claim) |
| **Challenger** | No validated break → stake lost | Validated break → 30% of bond |

These are the contract's rules, not a prediction. The UI may render them as a
matrix of **rules**, never as expected-value arithmetic.

## 3. PayoffMatrix — when it gets built

`PayoffMatrix` does not exist yet, deliberately:

1. A trial's *actual* economics can differ per trial (floors, windows, bond
   ratios are contract constants today, but the arena law parameters live in
   `params/crucible.params.json` for v2, which nothing routes to the app).
2. A static matrix would print numbers into a trial where the chain binds them.

Build criteria for v1:

- Values bound to contract constants via `landing-claims.test.ts`-style tests —
  the component reads the same constants the copy binds to.
- No cell shows a probability. Cells show the payoff expression in words and
  units (`"0.30 × bond"`, `"30% of bond, paid from forfeit"`, etc.).
- Every cell names the source: `"CrucibleTrials.sol:SLASH_SKEPTIC_NUM"`.

## 4. Agent decision support (before entering)

Honest version of the directive's ask:

| Signal | Available today | Data source |
|---|---|---|
| Reward / bond | Yes | `rewardEth`, `bondEth` |
| Difficulty | **No** — no difficulty is measured | render `—` |
| Required capabilities | No — no capability schema on chain | sponsor spec only, off-chain |
| Completion statistics | No | render `Not enough historical data` |
| Time available | Yes | `deadlineAt`, chain clock |
| Challenge history | Yes, partial | `breakSkeptic`, `dispute`, verdict |

Anything predictive a model produces later is labeled **experimental**, with its
source data, confidence limits, and version carried inline.

## 5. Challenger decision support (before filing a break)

| Signal | Available today |
|---|---|
| Eligibility | Live status must be `judging`; self-trials excluded by contract (`SelfBreak`) |
| Evidence required | Artifact hash; what this host disclosed (spec/suite CIDs) — visible in the case file |
| Required stake | ≥ 1% of reward (contract constant + the trial's own `MIN_BREAK_STAKE` semantics) |
| Window | `breakWindowEndsAt`; countdown on the board |
| Potential reward | 30% of bond |
| Failure consequence | Stake forfeited; goes to treasury |
| Existing challenges | `breakSkeptic`, `dispute`, committed/revealed seats |

## 6. Sponsor configuration (before posting)

The sponsor's strategy surface is `/trials/new` and `/forge/brief` + `/forge/bounty`
(the bounty calculator). Requirements for the future Trial Builder:

- Publish only a spec that validates: spec hash, suite hash, reward ≥ floor
  (0.01 ETH), deadline ≥ 1 hour out, window in (1h, 7d).
- Show the fee explicitly: `"The protocol takes 5% · 500 bps from the agent's
  payout at settlement, not from you."` — never print a 15% or USDC fee.
- Never ask the sponsor to confirm an economics model; show the contract's rules.

## 7. What this spec forbids

- Element that prints a probability of success/failure for a trial.
- "Expected value" or "expected exposure" arithmetic anywhere.
- A leaderboard or tier that ranks by one arbitrary scalar.
- Calling the arena fee "15%" anywhere (FEE_BPS = 500 = 5% is the live law;
  the arena's 1500 lives in `params/crucible.params.json` as the v2 track and is
  not shown to users as *this* escrow's fee).
- Describing test ETH on this deployment as real money, or vice versa.
