# ADR-0007: Reputation backfill is canonical and write-once per trial

- Status: Accepted
- Date: 2026-10-21

## Context

`ReputationBridge` writes outcomes into an optional ERC-8004 registry. A
registry can be down at settlement, and the contract deliberately ignores that
failure so a third-party outage never blocks a verdict. That leaves a gap: a
missed write needs a recovery path.

The first recovery path, `backfill(trialsId, agentId, value)`, accepted an
arbitrary `int128` from any caller and never checked that the trial existed or
had settled. Anyone could mint or slash reputation for any linked identity. That
contradicts the product's core claim: reputation mints only from outcomes.

## Decision

Backfill reads the canonical settled outcome from `CrucibleTrials`:
`settledOutcome(id) → (settled, verdict, agentId, survivedBreak)`.

`ReputationBridge.backfill(trialsId, agentId)`:

1. Rejects an unsettled trial (`TrialNotSettled`).
2. Rejects a mismatched agent (`AgentMismatch`).
3. Rejects a refund (`NothingToBackfill`).
4. Derives the value itself: `+750` paid-after-break, `+500` quiet paid,
   `-400` slashed.
5. Rejects a trial that already published successfully (`AlreadyReported`).

`reportedTrial[trialsId]` is set only after a successful registry write. A
skipped write (no linked identity) or a reverting registry leaves it false, so
a retry after linking an identity remains possible.

## Consequences

- Anyone can recover a missed write, but no one can choose its value.
- A trial can produce at most one successful reputation write, even if the
  registry is later replayed.
- An agent with no identity still gets `FeedbackSkipped` and no write; linking
  an identity later makes a backfill possible.
- Settlement still ignores bridge failures; the verdict is never blocked.

## Alternatives considered

- **Restrict backfill to the owner.** Rejected: the owner holds no trial
  authority, and recovery should not depend on a privileged key.
- **Keep the caller-supplied value and check settlement only.** Rejected: a
  settled trial does not make an arbitrary score correct.
- **No backfill at all.** Rejected: a temporary registry outage would
  permanently lose a real outcome.

## Evidence

- `crucible-contracts/contracts/ReputationBridge.sol` — `backfill`,
  `reportedTrial`, `_publish`.
- `crucible-contracts/contracts/CrucibleTrials.sol` — `settledOutcome`.
- `crucible-contracts/test/ReputationBridge.t.sol` — unsettled, wrong-agent,
  refunded, repeat and no-registry cases.
