# Engram locker: disabled until a custodial design is audited

**Status:** Accepted · **Date:** 2026-11-25 · **Code:** `crucible-contracts/contracts/EngramLocker.sol`

## Context

The first `EngramLocker` recorded locks without moving tokens. Any caller could create a
lock record naming another wallet, so the contract claimed custody it did not have. This is
finding F14 in `SECURITY_ASSESSMENT.md` ("took/returned no tokens, strand risk").

## Decision

`EngramLocker` is disabled. `lock`, `unlock` and their views are kept as a stable ABI, but
`lock` and `unlock` always revert with `LockerDisabled`, and the constructor emits
`LockerDisabledNotice`. `testLockDisabled` and `testUnlockDisabled` in
`crucible-contracts/test/EngramLocker.t.sol` enforce this.

The locker stays disabled for mainnet until a replacement is designed, implemented and
independently audited. That replacement must:

- take custody by transferring tokens into the contract, and verify the received balance;
- authorise each lock against the token owner, so no caller can lock another wallet's tokens;
- keep per-owner accounting that matches the contract's token balance;
- prevent duplicate withdrawal;
- accept only explicitly approved token standards and defend against malicious token behaviour;
- define an emergency recovery policy.

## Consequences

- No lock feature is offered to users. Any UI that implies locking must be removed or
  marked unavailable.
- Re-enabling requires a new ADR that supersedes this one, plus a fresh contract review.
