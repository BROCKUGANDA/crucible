# ADR-0003: Pull payments and one-time settlement

- Status: Accepted
- Date: 2026-10-21

## Context

Settlement pays an agent, a sponsor, a skeptic and the treasury. Pushing ETH
from the settlement call would make every recipient a reentrancy surface and
would let one reverting recipient block a verdict. The contract also needs a
single, auditable point where a trial becomes final.

## Decision

`CrucibleTrials` never pushes ETH. Settlement credits a pull ledger
(`credit[address]`), and each recipient calls `withdraw()` in a separate
transaction. `_settle` writes `Settled` before any credit or external call, and
reverts `AlreadySettled` on a second attempt. `withdraw()` is guarded by
`nonReentrant` and clears the credit before the call.

`CrucibleHall` is a separate contract with its own push-based settlement; it is
not part of this escrow and must not be used to infer `CrucibleTrials`
semantics.

## Consequences

- A payout takes two transactions: settlement, then `withdraw`.
- The web app must expose the withdrawal. It does, via the header credit
  control; the builder is `buildWithdraw()` and the route is `withdraw()`.
- A recipient that cannot receive ETH does not block the verdict; their credit
  remains claimable.
- The conservation invariant is `balance == free stake + pending credit +
escrow`.

## Alternatives considered

- **Push payments with a try/catch per recipient.** Rejected: more external
  calls in the settlement frame, more gas, and a failed push needs its own
  credit fallback anyway.
- **Payable fallback / `selfdestruct` force-feed.** Not a payment mechanism;
  the ledger remains the source of truth.

## Evidence

- `CrucibleTrials.sol` — `withdraw`, `_settle`, `_settleWin`, `_settleSlash`.
- `test/CrucibleTrials.t.sol` — `test_Withdraw_PullPattern`,
  `test_Withdraw_RevertNothing`, `test_Unstake_ThenWithdraw`.
- `test/Invariants.t.sol` — conservation invariants.
