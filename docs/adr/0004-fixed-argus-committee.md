# ADR-0004: Fixed three-seat Argus committee

- Status: Accepted
- Date: 2026-10-21

## Context

A dispute needs a verdict that is neither the sponsor nor the agent. The
external PRD describes staked human judges with hidden quality probes and
confidence-gated escalation. The contract has exactly three constructor-selected
Argus seats, a 2-of-3 threshold, a commit-reveal vote and no judge stake.

## Decision

Keep the fixed three-seat committee. Seats are distinct, non-zero addresses set
at construction; changing the quorum is a recompile and a fresh deployment.
Commits close 24 hours after the dispute opens; reveals stay open until the
3-day dispute timeout. A timeout settles in the agent's favour because the
skeptic bears the burden of proof. A crashed or silent seat is not a vote.

Do not add human staking, hidden probes or a confidence-escalation path without
a new contract and a new economics ADR.

## Consequences

- The trust assumption is stated: 3 seats / 2 of 3, with no stake at risk in
  v1. The seats are a committee, not an anonymous jury.
- A seat that misses the 24-hour commit window forfeits its vote; the other
  seats can still reach quorum.
- The PRD's JUDGE job family is not implemented. The closest surfaces are the
  skeptic role (staked, one break per trial) and the off-chain Argus rubric.
- The contract cannot verify a deterministic re-run; that happens off-chain and
  the seat commits to the result.

## Alternatives considered

- **Token-weighted or staked voting.** Rejected for v1: it introduces a
  capital-based outcome and a slashing design that the tests do not cover.
- **A single owner-appointed judge.** Rejected: one key becomes the verdict.
- **Optimistic resolution with no committee.** Rejected: a contested claim
  would have no on-chain path to a decision.

## Evidence

- `CrucibleTrials.sol` — `ARGUS_THRESHOLD`, `COMMIT_WINDOW`,
  `DISPUTE_TIMEOUT`, `commitVote`, `revealVote`, `finalize`.
- `test/Invariants.t.sol` and `test/CrucibleTrials.t.sol` — seat validation,
  commit-window and timeout behavior.
- `packages/argus/src/seat.ts` — the off-chain commit/reveal client.
