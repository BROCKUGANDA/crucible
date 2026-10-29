# ADR-0019: both fee schedules must be legible, and neither may be harmonized for convenience

- **Status:** proposed (2026-10-29)
- **Decides:** how the two economic laws ADR-0011 created are presented to a person about to sign, and what happens to the recurring instruction to make the protocol fee "15%" or "5%" universally
- **Supersedes:** nothing. Depends on ADR-0011 (two laws, fees as parameters), ADR-0002 (native ETH escrow), ADR-0003 (pull payments), and inherits ADR-0014 (challenge bond priced to verification).
- **Does not** change any constant, any payer, or any rounding rule. That is the point of writing it down.

## Context

An enterprise implementation brief received 2026-10-29 states the product's economics as:
"legacy work escrow uses 5%; the v2 Arena documents `ARENA_FEE_BPS = 1500` (15%)", and elsewhere
asserts a 15% protocol fee as though it were the platform's charge. Both constants are real:

| Schedule | Value | Where | Who pays it | When it is actually kept |
|---|---|---|---|---|
| Legacy work escrow | `FEE_BPS = 500` | `crucible-contracts/contracts/CrucibleTrials.sol:148` | the agent, out of the payout | deducted at `_settleWin` (`:702-705`); **not** charged on a landed break (`:745` refunds the reward) |
| v2 Arena | `ARENA_FEE_BPS = 1500` | `crucible-contracts/contracts/Params.sol:10` | the sponsor, at posting | collected in `postTrial` (`Arena.sol:321-322`), reaches the treasury only on O1/O2 (`:855`, `:879`); **refunded** with the reward on O3/O6/O7/O8 (`:940`, `:368`, `:351`, `:957`) |

So the brief's two sentences are individually true and jointly misleading: the schedules differ in
**rate, payer, timing and refundability**, not just in number. Treating "15%" as *the* platform fee
would move the charge from the sponsor's posting to the agent's payout, or the reverse, depending on
which direction the harmonization went. That is a different protocol, not a price change.

What the audit of the running product found is worse than a disagreement. Only one of the two
schedules is visible anywhere:

- `apps/api/src/server.ts:596-604` reads `FEE_BPS` from `trialsAddress` and nothing else;
  `app.ts:539` publishes it as `economics.feeBps`; `apps/web/src/lib/clock.ts:167` renders it.
  The live site therefore shows `5% · 500 bps` and nothing else, on every page.
- `ARENA_FEE_BPS` is imported by no file under `apps/` (grep: `Params.sol`, `Arena.sol`,
  `params/generated/params.ts`, `params.rs`, `scripts/params-codegen.mjs`).
- There is no `/arena` page (`HARDENING.md:1717`), the arena reducer projects 7 of 23 events
  (`HARDENING.md:1712-1717`), and every write path in the web app uses `TRIALS_ABI`
  (`apps/web/src/lib/useTx.ts:252-311`). The v2 law is deployed, indexed by `/api/arena` when
  `ARENA_ADDRESS` is set, and unreachable from the interface.

An enterprise buyer reading the site concludes the platform charges 5% of a payout. The same buyer
reading `params/crucible.params.json` concludes it charges 15% of a posting. Neither number is
wrong, and the product offers no way to tell them apart — which is exactly the condition in which a
fee gets "fixed" for visual consistency by whoever is next to touch it.

## Decision

1. **Neither schedule is harmonized.** 500 and 1500 stay as they are, with their payers, timings
   and refunds. Any change to either is a new ADR plus a contract review, per AGENTS.md. This ADR
   explicitly rejects the harmonization option in all three directions (5→15, 15→5, both→one) on
   the grounds that the two numbers price different risks for different parties.
2. **Every money screen names the law it is quoting.** A fee figure is rendered with its protocol
   in the same line — the legacy escrow rate and the Arena rate are two different facts and must
   never share one unlabelled field. The published shape is: schedule name, rate as plain percent
   with bps in parentheses, payer, timing, refundability. `5% · 500 bps` remains the register the
   display rules require (AGENTS.md bans bare bps), with the law named beside it.
3. **`economics` becomes a list, not a scalar.** `GET /snapshot` publishes one `feeBps`. It will
   publish one entry per protocol the deployment actually has wired, each carrying its own address
   and provenance, so a UI cannot invent the second one and cannot hide it either. Absent protocol
   → absent entry, per the "a figure is read or it is not shown" rule. This is a read-model change;
   it moves no ETH and changes no contract.
4. **The Arena gets a surface before its fee is argued about.** The cheapest way to end the 5-versus-15
   dispute permanently is a page that shows both books side by side with real numbers, rather than a
   README sentence. Until an `/arena` read exists, the 15% is a constant in a JSON file and the
   product's only published fee is 5% — which is why the 15% keeps returning as a proposed "fix".
5. **Rounding stays where the chain put it.** Both laws truncate (`CrucibleTrials.sol:704`,
   `Arena.sol:321` "the remainder stays with the sponsor"); UI minimums round **up**
   (`apps/web/src/lib/wizard.ts:95`) so a printed-short stake cannot revert `StakeTooSmall`. The
   `params/crucible.params.json:39` label `floor_remainder_to_treasury` is true of the seat pools
   (`Arena.sol:987`) and **not** of the fee; it must not be presented as a fee rule.

## Options considered and rejected

- **A. Adopt 15% platform-wide.** Rejected. It re-prices the legacy escrow, moves the charge from
  the agent's payout onto the sponsor's posting, and would take the fee on rows where the Arena
  today refunds it (O3/O6/O7/O8). It is the ADR-0001 pivot AGENTS.md names, and it is the number the
  external brief returned for the third time.
- **B. Adopt 5% platform-wide.** Rejected. It discards the v2 pricing rationale — ADR-0014 prices
  the challenge bond to the cost of verification, and the Arena's 15% of a posting funds a committee,
  a docket and a seat pool that the legacy law does not have. Same total, different risk covered.
- **C. Keep both silent, as today.** Rejected. This is the current state and it is the failure mode:
  one visible number, one invisible number, and a plausible-looking argument that they disagree.
- **D. Keep both and label both (adopted).** Costs a read-model change and one page. No constant
  moves, no deployed bytecode changes, fully reversible.

## Consequences

- Positive: the fee question stops being a document dispute and becomes two readable rows; an
  integrator can price a posting before signing; the recurrence of "shouldn't this be 15%?" gets a
  citable answer with a provenance line.
- Negative: the landing page and `/clock` must show two rates where visitors currently see one, and
  some of them will read that as the product charging twice. The copy has to say plainly that these
  are two books, not two charges on one transaction.
- Negative: `economics.feeBps` as a scalar is a published shape with tests pinning it
  (`apps/api/test/app.test.ts:406`, `apps/web/test/clock.test.ts:23`); the list change touches both
  and any consumer reading the old field. It is additive if the scalar is kept as the legacy entry.
- Risk if ignored: a future contributor "fixes" one constant to match the other for visual
  consistency. That is a money-moving change to a deployed contract and would break the conservation
  invariant's book (`test/Invariants.t.sol:189-191`) for the legacy law by changing what the escrow
  keeps.

## Validation

- A gate that fails if a fee figure renders without a protocol name beside it — source-asserted in
  the style of `apps/web/test/demo-notice.test.ts`, because there is no React renderer here.
- A test that `GET /snapshot`'s economics list carries one entry per wired protocol and no entry for
  an unwired one, so the absence of the Arena is visible rather than silent.
- Once `/arena` exists: a figure-level cross-check that the rate the page prints equals
  `Arena.ARENA_FEE_BPS()/Arena.BPS()` read from the chain, in the manner `apps/web/src/lib/clock.ts`
  already does for the legacy law.
- No test in this ADR is satisfied by a documentation claim. Each needs the value read from the
  contract or the API that publishes it.
