# ADR-0014: A frivolous break is priced in reward, but it is paid for in someone else's compute

- **Status:** accepted (2026-10-25)
- **Decides:** the dispute flow's griefing exposure is measured and recorded here; the fix is a
  verification-cost floor carried by the **arena**, and the funded v1 escrow is not touched by this
  decision
- **Amends:** nothing. It puts a number on a hole `AGENTS.md`'s money rules do not currently cover.
- **Reads with:** ADR-0011 (the arena is the place parameters are allowed to change), ADR-0013 (what
  a seat's verification actually costs to run).

## Context

An outside review asked whether the skeptic market can be grieved — frivolous breaks filed to delay
settlement or to burn the platform — and whether "challenge laundering" (fake breaks that fail on
purpose to farm reputation) is possible. Both questions are answerable from this tree, and the
answers are opposite.

The mechanics, read off the contract rather than from a description of it:

| Fact | Where | Value |
| --- | --- | --- |
| Minimum break stake | `CrucibleTrials.sol:147` `BREAK_STAKE_DEN = 100`, enforced at `:562` | 1% of the reward |
| Who may not break | `:560` `SelfBreak` | the sponsor and the agent's own operator |
| One break per trial | `:558` `status != Judging` reverts | a second filing cannot exist |
| Commit window | `:171` `COMMIT_WINDOW = 24 hours` | seats must re-run inside it |
| Dispute timeout | `:154` `DISPUTE_TIMEOUT = 3 days` | settlement may wait this long |
| A failed break's stake | `:715-716` | **entirely** split 50% to the agent's operator, 50% to the treasury |
| What a seat spends | `apps/juror/src/policy.ts:36-41`, `DEFAULT_SANDBOX.timeoutSec = 900` | up to 15 minutes of container per seat, per break |

**Laundering is already closed, and by arithmetic rather than by a check.** A colluding pair —
address B breaking agent A's trial — cannot gain: B's stake is not returned on a failed break, A's
operator receives half of it and the treasury the rest, so the pair is **net −0.5% of the reward**
for the exercise, and `SelfBreak` already stops the cheapest version where one address plays both
sides. Nothing needs adding.

**Griefing is live, and it is mispriced in one specific way: the units.** The bond is a fraction of
the *reward*, while the harm it causes is a *fixed* quantity — three seats each spinning a sandbox
for up to fifteen minutes, and a settlement window extended by hours to three days. At the top of
the market the deterrent works: a 10 ETH trial costs a griefer 0.1 ETH. At the floor the contract
actually enforces (`MIN_BOND` implies rewards from 0.05 ETH up), a break costs **0.0005 ETH** to
consume 45 minutes of three seats' compute and freeze a trial for a day or more. The bond scales
with the stake at risk; the cost it imposes does not scale at all.

## Decision

1. **The v1 escrow is not changed by this ADR.** `CrucibleTrials.sol` is deployed and its balance is
   reconciled to the wei against `totalStakes + totalPending + escrowed` on every deploy
   (`scripts/assert-deployment.sh`, ADR-0003's pull ledger). Changing a money parameter on a funded
   contract is a migration with its own authorisation, not a documentation follow-up.
2. **The arena carries the fix, where parameters are already allowed to move.** ADR-0011 made the
   v2 fees parameters rather than literals; the same place holds the floor. The rule to implement is
   `max(reward × SKEPTIC_STAKE_MIN_BPS, K × seat_verification_cost)` — the bond stops being a pure
   fraction of reward and gains a term denominated in the thing the break actually spends. `K` is a
   decision to be measured against a real bench run, not picked here.
3. **The exposure is published, not held quietly.** The ratio above — cost to grieve one trial at
   the floor, against the seat-minutes it buys — belongs on `/assay` beside the fee and the slash
   split, computed from the same constants the contract reports, so a reviewer reaches the number
   without reading this file.
4. **A seat that cannot afford the verification refuses to start, and says so.** That rule already
   exists (`policy.ts:36-41`: the gate will not begin a fifteen-minute job with ninety seconds left
   on the window). It is the seat's own protection against the fixed-cost half of this asymmetry, and
   this ADR records it as load-bearing rather than incidental.

## Rejected

- **Raising the flat percentage.** It multiplies the harm to honest skeptics — who are the mechanism
  — by the same factor it multiplies the griefer's cost, and leaves the unit error exactly where it
  is: a number denominated in reward, paying for someone else's compute.
- **Whitelisting or staking skeptics per trial.** Permissionless opposition is the product's premise;
  `/claims` says skeptics are "paid to attack", not "invited to attack". A gate here buys the
  deterrent at the price of the mechanism's central claim.
- **Slashing a failed break beyond its stake.** The losing skeptic already forfeits everything they
  posted. Anything harsher prices honest false positives — a skeptic who reasonably doubts and is
  wrong — and would suppress exactly the attempts the surviving-attack rate is measured from.
- **"Fixing" it by shortening `DISPUTE_TIMEOUT`.** The delay is not the harm; the seat-minutes are.
  Shortening the window moves the harm onto honest panels that need the time.

## Consequences

The floor of the market stays griefer-cheap until the arena's parameter exists, and this record says
so while the site is live with 10.04 ETH on the escrow. The mitigation that does exist today is
operational, not economic: seats refuse late jobs, one break per trial is enforced by the state
machine, and the money a griefer spends goes to the party they attacked and to the treasury rather
than back to them.

## Verification

- Every constant above is cited to a line in `crucible-contracts/contracts/CrucibleTrials.sol` and
  read from the deployed contract by `scripts/assert-deployment.sh` at each deploy (it asserts
  `settlement fee (bps) = 500`, the bond denominator, the Argus threshold and the minimum bond).
- The laundering arithmetic is checkable from `:715-716` alone: the losing stake is not returned.
- **Not yet proven, and named:** no test pins the *ratio* itself, because there is no bench figure
  for a seat's verification cost on the deployed box — that measurement is the precondition for
  choosing `K`, and it is listed as open work rather than assumed. The `/assay` row is likewise not
  yet written.
