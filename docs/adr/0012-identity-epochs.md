# ADR-0012: Identity epochs — what a handover may erase, and what it may not

- **Status:** accepted (2026-10-24)
- **Decides:** how "if the identity behind it changes hands, a new epoch starts from zero" becomes
  true, when the only place a handover can be seen is a third-party registry the escrow asks about
  once, at link time
- **Amends:** ADR-0011 §Decision 1's "nothing in `crucible-contracts/contracts/` changes" — read
  there as freezing the **economic law** (fee, splits, windows), which stays frozen and
  machine-checked. This ADR changes the **reputation book**, which is a different object.
- **Supersedes:** nothing. `/.well-known/crucible.json`'s caveat "there is no identity epoch" and
  `/claims` row `VI-6`'s `absent` are retired by this decision, in the same commit that ships it.

## Context

Gate 748 asks for "epochs on identity transfer" and gate 775 for "agent profile, credential,
epochs". The promise the site makes beside them is `VI-6`: *if the identity behind it changes hands,
a new epoch starts from zero.* Until today the sentence was false in a specific, checkable way:

- `CrucibleTrials.linkIdentity` (line 359) proves the caller owns the ERC-8004 identity **once**, at
  the moment of linking, and stores `identityOf[agentId]`.
- `AlloyRegistry._ensure` (line 119) binds `ownerOf[agentId] = operator` **only when it is still
  zero**. Every later call sees a non-zero owner and changes nothing.

So the chain records who an agent's identity belonged to when it was linked and never asks again. An
identity sold outright — which ERC-8004 permits, on the identity registry, without touching either of
our contracts — keeps carrying its seller's wins, its seller's tier and its seller's slashes. The
credential is soulbound, which is the point of it, and that is exactly the case the soulbound token
does not cover: the token cannot move, but the identity it scores can change hands.

Two things pull against each other, and both are real:

1. **A buyer should not inherit a punishment they did not earn.** A Damascus agent whose record took
   a slash hands a fresh buyer a tier that describes somebody else's history.
2. **A seller should not be able to wash a record.** If a handover zeroes the book, the way to clear
   a landed break is to sell the identity to yourself for a block.

## Decision

1. **A handover is observed, never declared.** At settlement the escrow reads
   `IIdentityOwnership(identityRegistry).ownerOf(identityOf[agentId])` and passes what it sees to the
   registry as the agent's current *holder*. There is no `transferEpoch` the operator can call: a
   self-declared handover is the washing machine in decision 2's shape.
2. **The read fails open, and that is deliberate.** Unwired registry, unlinked agent, a revert, a
   short return, a zero address — all resolve to "the operator stands, no epoch change". This is the
   same policy `_publishWin` already states at line 754: *a third-party registry must never be able
   to block a verdict.* A stuck settlement cannot be undone; a missed epoch transition is corrected
   at the next settlement, and `EpochStarted` makes it visible when it lands.
3. **What resets is the window.** On a handover the current window — `wins`, `survived`, `slashes` —
   goes to zero and the tier recomputes, which puts the new holder at `Unforged` to re-earn from
   there. The 25% slash decay keeps operating on the window, so a slash earned in the new epoch
   behaves exactly as one does today.
4. **What never resets is the truth.** `epoch` counts up and does not count down. `lifetimeWins` and
   `lifetimeSlashes` accumulate across every epoch. `ownerOf[tokenId]` stays the original mint
   recipient — the token does not move, so rows `H-5` and `H-6` ("no one can buy, borrow, or fake",
   "no approval surface to lend") stay true and `locked()` keeps returning true for a minted token.
   And the transition itself is an event with both addresses in it.
5. **The credential says so, on its own.** `tokenURI` carries `epoch`, `epochStartedAt`,
   `lifetimeWins` and `lifetimeSlashes` beside the window figures, so a reader holding only the NFT —
   no API, this deployment, or any trust in us — can see that the window is short *because it is
   new*, not because the agent is clean. Decision 2's abuse is answered this way: not by making the
   reset impossible, which would punish the buyer, but by making it **legible**.
6. **Standing counts the current epoch only**, and reports what it left out. `computeStanding` takes
   `epochStartedAt` (the chain's own `block.timestamp` for the transition, stored in the record) and
   excludes outcomes settled before it — counted in `excludedPreEpoch`, never silently dropped. This
   is the same rule as `excludedNoSettlementTime`: a figure a reader cannot reconstruct is not a
   figure worth publishing.
7. **`Record` grows by appending.** The struct goes from four fields to eight, in the order
   `wins, survived, slashes, tier, epoch, lifetimeWins, lifetimeSlashes, holder, epochStartedAt`
   (nine with the timestamp; the first four keep their positions). `abi-drift.test.ts` parses
   `struct Record` out of the Solidity source and asserts the ABI's `records()` outputs match it
   field for field, and a second test pins the first four names, so a widened struct reddens the
   suite until every reader is updated. That gate is the reason appending is safe and reordering is
   not.

## Rejected

- **A `startEpoch` the operator calls.** Self-declared, so it is a reset button: sell to a fresh
  address, or to yourself, and the window is clean on your own schedule. The observed version costs
  the seller a real transaction on a real registry whose ownership they no longer hold afterwards.
- **Refusing to reset, and publishing one lifetime book instead.** That is today's behaviour, and it
  is what the site's promise denies. It also makes the buyer's tier a function of a stranger's
  history, which is the thing reputation is supposed to describe.
- **Moving `ownerOf` to the new holder.** That is a transfer. The credential's whole claim is that it
  cannot move, and `test_AlloyRegistry` plus rows `H-5`/`H-6` and the ERC-5192 `locked()` answer all
  rest on it.
- **Decaying the window by time instead.** Already built, orthogonal, and no substitute: a 45-day
  half-life does not distinguish an agent that changed hands yesterday from one that has been quiet.
- **Wrapping the identity read in `try/catch` at the call site.** `staticcall` + a length check is
  the shape the file already uses for optional plumbing, and it keeps `_settleWin`'s stack frame
  inside the 16-slot limit the `Trial` struct already presses against.

## Consequences

- `AlloyRegistry` and `CrucibleTrials` both change, so the escrow must be **redeployed**. On the demo
  box that means a chain reset; the deployer is deterministic, so both contracts land at the same two
  addresses and the host `.env` and the baked web bundle stay valid — only the bytecode moves.
- `records(agentId)` returns more than it did. Every reader is updated in the same commit, and the
  drift gate is what proves none was missed.
- A slashed agent can now hand its identity over and start clean in the window. The mitigation is
  decision 4 and 5 — the epoch number, the lifetime book and the event trail are all published — and
  the honest limit of that mitigation is stated here rather than discovered later: **an epoch makes a
  washed record visible; it does not make washing impossible, and nothing in this design punishes
  the attempt**, because the attempt is also the legitimate case.
- `VI-6` on `/claims` moves from `absent` to `enforced`, and the gate that requires at least three
  `absent` rows has to be cleared by the next promise that is genuinely unkept, not by relabelling a
  different one.

## Verification

- Foundry: a handover zeroes the window, drops the tier to `Unforged`, bumps `epoch`, keeps the
  lifetime totals and leaves `ownerOf` where it was; an unwired registry and an unlinked agent both
  settle without touching the epoch; a registry that reverts, returns short, or answers zero fails
  open and still settles the trial; `recordSlash` after a handover decays the new window, not the old
  one. `test_FeeBpsIsFiveHundredNotFifteenHundred` is untouched — the economic law this ADR does not
  change stays machine-checked.
- TypeScript: the standing filter excludes pre-epoch outcomes and counts them; the API publishes
  `epoch`, `epochStartedAt` and the lifetime book; `abi-drift` forces the widened `records()` and the
  new `EpochStarted` event in both directions.
- Mutation-proved, named in `HARDENING.md`: which assertion dies when the reset is removed, when the
  lifetime totals are reset too, when the identity read is made to block settlement, and when the
  epoch filter is dropped from the standing computation.
