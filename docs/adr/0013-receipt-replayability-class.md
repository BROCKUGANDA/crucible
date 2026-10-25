# ADR-0013: A receipt names what a stranger can re-derive, not just that it was checked

- **Status:** accepted (2026-10-25)
- **Decides:** every verdict carries a **replayability class** — `artifact-replayable`,
  `generation-attested`, or `undecided` — derived from which phase of verification decided it, and
  never from what it decided
- **Amends:** nothing. It narrows the word "verified", which `/claims`, `/hall` and the receipts
  currently use for two different achievements.
- **Constrains:** any future change to `ArgusVerdict`, the rubric fallback, or the model manifest —
  a verdict whose class cannot be decided from the report alone is a verdict that cannot be published.

## Context

`Argus` has always known the difference and never said it. `VerifyReport` carries
`phase: "deterministic" | "rubric" | "abstain"` (`packages/argus/src/argus.ts:65`) and an optional
`rerun` of the suite's own results (`:67`), and the class of a claim follows straight from that:

- The deterministic phase decides by re-executing the pinned suite and checking signatures and
  hashes. Anyone given the same bytes reaches the same answer, forever. That is what the product
  sentence promises.
- The rubric phase is reached only when phase 1 cannot decide (`argus.ts:235` — "Phase 1 could not
  decide (partial suite). Only then is the rubric consulted"). Its answer comes from a model, at a
  temperature, against an endpoint.
- An abstain is not a verdict at all, and `ballotFor` already refuses to turn one into a seal.

The gap is not philosophical. A model can be deprecated, its temperature jittered, or its endpoint
updated under a run that already happened, and no amount of re-running reproduces a generation. So
two commitments that read identically in the seat's log — `breakWins=true because <reason>` — can
mean "anyone can re-derive this" and "a model judged this", and the receipt said nothing about
which. The distinction is also the one a buyer asks about first, and the one a lab can exploit by
quietly regenerating a favourable verdict.

## Decision

1. **The class is derived from the phase, and only from the phase.** `replayabilityOf(report)` in
   `apps/juror/src/policy.ts` maps `deterministic → artifact-replayable`, `rubric →
   generation-attested`, `abstain → undecided`. Keying it on the verdict would be the tempting
   wrong implementation: it would label a rubric's "the agent was right" as reproducible and a
   deterministic hash mismatch as an opinion, and the class would then carry no information a buyer
   could use.
2. **It is recorded where the vote is recorded.** The seat's `commit` action line now reads
   `breakWins=… because … [artifact-replayable] — n seat(s) sealed` (`operator.ts:276-283`), so the
   class survives in the durable audit trail beside the transaction hash rather than living only in
   a type.
3. **The second axis is the index's, and stays there.** Whether a cold observer can *obtain* the
   suite today is `awaitingDisclosure` in the read model — a property of the disclosure log, not of
   this seat's report. A verdict can be `artifact-replayable` in method and still un-fetchable in
   practice until the suite is revealed; the two facts are reported separately rather than fused
   into one optimistic word.
4. **The on-chain field is a named change with a cost, not an implication.** Putting the class on
   the vote means adding it to the commit digest, which changes what `ArgusCourt`/`commitVote`
   hash and what the escrow reveals. `crucible-contracts/contracts/CrucibleTrials.sol` is deployed
   and currently holds 10.04 ETH against its books; a funded escrow is not upgraded as a side effect
   of a read-model change. Until that migration is explicitly authorised, the class is the seat's
   record and the receipt's claim, and the site must not imply it is enforced by the chain.

## Rejected

- **Deriving it from the verdict, or from `rerun?.length`.** The first is a restatement of the
  outcome. The second is close but wrong: the deterministic phase also fails early on a hash or
  signature mismatch (`argus.ts:92`, `:106`, `:125`, `:136`, `:149`) with no re-run at all, and those
  verdicts are exactly as re-derivable as a green suite — a stranger recomputes the digest.
- **A boolean `verified`.** It would read as "yes" for the rubric case, which is the dishonesty this
  ADR exists to prevent.
- **Re-running the suite at read time to decide the class.** Cost falls on the reader, and the
  question "what decided this" is about the past, not about whether the bytes are still obtainable.
- **Classifying an abstention as `generation-attested`.** There is no verdict to attest.

## Consequences

Two commitments that look alike in the log no longer are. A buyer, a regulator, or a rival can ask
the only question that survives a model deprecation — *could someone else reach this?* — and get a
stored answer. Expect the `generation-attested` share to be small in v1, where a run is a patch
against a pinned Forge suite, and to grow with every rubric-decided family the arena admits; if it
grows silently, that is the signal this record exists to make visible.

## Verification

- `apps/juror/test/policy.test.ts` — four cases: each phase maps to its class, and the
  phase-not-verdict rule is asserted as two pairs with identical verdicts and opposite classes.
- `apps/juror/test/operator.test.ts` — two cases through the real pass: a deterministic report
  records `[artifact-replayable]`, and a rubric report records `[generation-attested]` and *not* the
  other label.
- Mutation-proven three ways, each turning the suite red: the call replaced by a literal
  `artifact-replayable` in `operator.ts`; `replayabilityOf` made constant; and the function keyed on
  `report.verdict` instead of `report.phase`.
- Not yet proven, and named: the class is not on-chain, and the disclosure axis is not yet joined to
  it in the API snapshot. Both are decisions with a cost attached, not oversights.
