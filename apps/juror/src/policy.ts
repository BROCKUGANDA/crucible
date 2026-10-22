import type { Address, Hex } from "viem";
import type { VerifyReport } from "@crucible/argus";
import { seatKey } from "@crucible/indexer";

/**
 * The seat's decision rules, as pure functions over a view of one dispute.
 *
 * This is the half of the service that moves money, and it is deliberately free of viem, of
 * the filesystem and of the clock it is handed. Same reason `packages/warden/src/policy.ts`
 * exists: "may this seat seal, and may it unseal" has to be readable and falsifiable without
 * a chain, because the failure it prevents — a seat that commits an abstention, or reveals
 * into a dispute it could still lose — is not visible in any log until it is on chain.
 */

/** The `Status` word `commitVote` and `revealVote` both require (`CrucibleTrials.sol:75-81`). */
export const STATUS_CHALLENGED = 3;

/** The zero word `commitVote` uses for "this seat has never sealed" (`d.commits[msg.sender] != bytes32(0)`). */
export const NO_COMMIT: Hex = `0x${"00".repeat(32)}`;

/**
 * The two timing rules of the dispute, read off the chain at boot rather than mirrored here.
 *
 * `commitVote` reverts unless `block.timestamp < openedAt + COMMIT_WINDOW`, `revealVote` is
 * not time-gated at all, and `ARGUS_THRESHOLD` of the seals settles the trial. Both are
 * `public constant`, so they are readable — and a service that hardcoded them would keep
 * enforcing yesterday's window against a chain that had moved.
 */
export interface SeatConstants {
  commitWindowSec: number;
  threshold: number;
  /**
   * Slack before the window closes, in seconds.
   *
   * Not a reorg allowance: a cost allowance. The pass that decides to seal has to re-execute
   * the pinned suite in a container BEFORE it can know what to seal, and that run is the
   * slowest thing in the process (`DEFAULT_SANDBOX.timeoutSec` is 900). Starting a fifteen-
   * minute job with ninety seconds left on the window produces a verdict nobody can post —
   * so the gate refuses to start it. `main.ts` derives this from the sandbox budget it
   * actually configured, plus a minute for the rest of the pass.
   */
  marginSec: number;
}

/** Everything the rules need about one dispute, already read. */
export interface DisputeView {
  trialId: number;
  /**
   * The seat this view was read for.
   *
   * Part of the view rather than a parameter of each rule because the two lists the rules ask
   * about are per-seat facts: "am I among the sealed?" and "am I among the revealed?" are only
   * answerable against the address the chain read was made with, and a rule that took the seat
   * separately could be handed a different one than the view was built from.
   */
  seat: Address;
  /** `Trial.status`, read from the chain — the index's `challenged` label is a projection of a log, this is the word */
  status: number;
  /** `_disputes[id].openedAt`, unix seconds, read from the chain */
  openedAt: number;
  /** every seat that has sealed, lowercased — the event projection, because the chain cannot enumerate them */
  committed: string[];
  /** every seat that has unsealed, lowercased */
  revealed: string[];
  /** this seat's commitment word as the chain holds it; `NO_COMMIT` when it has never sealed */
  seatCommit: Hex;
  /** this seat's reveal flag as the chain holds it */
  seatRevealed: boolean;
}

export type CommitGate =
  /** run the suite: a decisive verdict may be sealed */
  | { act: "verify"; closesAt: number }
  /** do nothing this pass, for a reason worth logging */
  | { act: "hold"; reason: string }
  /** stop asking about this trial: sealing is no longer possible, and retrying is a self-inflicted DoS */
  | { act: "forfeit"; reason: string };

/**
 * May this seat still form a verdict it could post?
 *
 * The order is the one that saves work: a seat that has already sealed must not spend fifteen
 * minutes in a container to discover it can post nothing, and a closed window must not be
 * tested at all.
 *
 * Precondition, enforced by the caller: this is asked only of a trial the seat holds no salt
 * for. The operator's commit loop skips any seal it still holds — those belong to `gateReveal`
 * — so a commitment the chain reports here can only be one this seat cannot open. That is the
 * destroyed-vote case below, and it is permanent, which is why it is a `forfeit` and not a
 * `hold`: the seat must stop asking rather than poll a guaranteed revert.
 */
export function gateCommit(d: DisputeView, k: SeatConstants, nowSec: number): CommitGate {
  const closesAt = d.openedAt + k.commitWindowSec;
  if (d.status !== STATUS_CHALLENGED) {
    return { act: "hold", reason: `trial ${d.trialId} is not Challenged on chain (status ${d.status})` };
  }
  // Checked before the commitment below, because a revealed seat has a commitment too, and the
  // two have opposite meanings: one is a vote that counted, the other is a vote that got stuck.
  if (d.seatRevealed || d.revealed.includes(seatKey(d.seat))) {
    return {
      act: "forfeit",
      reason: "this seat already revealed on this trial, so its vote is counted and needs nothing further",
    };
  }
  if (d.seatCommit !== NO_COMMIT) {
    return {
      act: "forfeit",
      reason:
        "this seat has a commitment on chain with no stored salt, so its vote can be neither opened nor " +
        "replaced (commitVote reverts AlreadyCommitted, CrucibleTrials.sol:559) — restore the seat state " +
        "file, or accept that this seat is silent on this trial",
    };
  }
  // A window that has already closed is forfeit, not a condition to poll: `commitVote` will
  // revert `CommitClosed` for the rest of the chain's life, and an unbounded retry against a
  // guaranteed revert is a load bug, not a waiting strategy.
  if (nowSec >= closesAt) {
    return {
      act: "forfeit",
      reason: `the commit window closed at ${closesAt} and this seat sealed nothing`,
    };
  }
  // Still open, but too close to spend the bench's whole budget on it.
  if (nowSec + k.marginSec >= closesAt) {
    return {
      act: "hold",
      reason: `only ${closesAt - nowSec}s left of the commit window, less than the ${k.marginSec}s a re-run costs`,
    };
  }
  return { act: "verify", closesAt };
}

/** True only when the pass can still post what it is about to compute. Checked after the run. */
export function windowStillOpen(d: DisputeView, k: SeatConstants, nowSec: number): boolean {
  return d.status === STATUS_CHALLENGED && nowSec < d.openedAt + k.commitWindowSec;
}

export type RevealGate =
  | { act: "reveal"; breakWins: boolean }
  | { act: "hold"; reason: string }
  /** the seal is finished with — open or dead, it must leave the store or the loop spins on it */
  | { act: "drop"; reason: string };

/**
 * May this seat unseal?
 *
 * Three conditions, and the middle one is the product: ADR-0004's anti-collusion rule says a
 * seat does not reveal until at least `ARGUS_THRESHOLD` seats have sealed, so no seat can read
 * a peer's verdict and copy it. That count is only knowable from the `VoteCommitted` logs
 * (`_disputes` is private and neither view enumerates holders), so the gate consumes the
 * index's projection and a lagging index simply means waiting — which is harmless, because
 * `revealVote` is not time-gated and a seat that sealed on time is never rushed.
 */
export function gateReveal(
  d: DisputeView,
  seat: string,
  sealed: { breakWins: boolean } | null,
  k: SeatConstants,
): RevealGate {
  const me = seatKey(seat);
  if (d.status !== STATUS_CHALLENGED) {
    // Revealing now reverts `NotChallenged`, forever: the dispute is over and this seat's
    // vote is dead. Drop it, or every pass re-attempts a tx that can only revert.
    return { act: "drop", reason: `trial ${d.trialId} left Challenged (status ${d.status}) with this seal unopened` };
  }
  if (d.seatRevealed || d.revealed.includes(me)) {
    return { act: "drop", reason: "this seat already revealed — the salt is public now and worthless here" };
  }
  if (!sealed) {
    // Nothing to open. Either the commit never landed (the seal was written before the tx and
    // the process died in between) or it belongs to a dispute this view says we are not in.
    if (d.seatCommit === NO_COMMIT) {
      return { act: "drop", reason: "no commitment on chain matches this seat's stored seal" };
    }
    return { act: "hold", reason: "this seat has sealed on chain but the salt is not in the store" };
  }
  if (d.seatCommit === NO_COMMIT) {
    // The order matters, and this branch is the reason: `state.ts` writes the salt BEFORE the
    // transaction, so a pass that died between the two leaves a stored seal with nothing on
    // chain. Keeping it is not caution — the commit loop skips any trial this seat holds a seal
    // for, so the seat would stay silent on a trial it never actually voted on, forever.
    return {
      act: "drop",
      reason:
        "a salt is stored but the chain holds no commitment from this seat, so the commit never " +
        "landed — forget the seal and let this seat verify the trial again",
    };
  }
  if (d.committed.length < k.threshold) {
    return {
      act: "hold",
      reason: `waiting for ${k.threshold} seats to seal; ${d.committed.length} have, per the logs`,
    };
  }
  return { act: "reveal", breakWins: sealed.breakWins };
}

export type Ballot = { vote: "abstain" } | { vote: "seal"; breakWins: boolean };

/**
 * The verdict-to-vote mapping, and the reason it is a function instead of a ternary.
 *
 * `abstain` is not a weak opinion, it is the report saying "I could not check", and the design
 * pays the agent when the committee cannot decide (`CrucibleTrials.sol:594` — after
 * `DISPUTE_TIMEOUT` of no quorum, `finalize` settles in the agent's favour: the burden of
 * proof is on the skeptic). A seat that mapped abstention onto `breakWins: false` to "have
 * its say anyway" would be converting its own outage into a vote against the skeptic, which
 * is the fraud the whole commit-then-reveal shape exists to prevent. So silence is the honest
 * action, and it is expressed here by not producing a ballot at all.
 */
export function ballotFor(report: VerifyReport): Ballot {
  switch (report.verdict) {
    case "break-wins":
      return { vote: "seal", breakWins: true };
    case "agent-wins":
      return { vote: "seal", breakWins: false };
    case "abstain":
      return { vote: "abstain" };
    default: {
      // Unreachable against the declared union, and kept as a compile-time tripwire: a verdict
      // added to `ArgusVerdict` must be decided here rather than defaulted somewhere.
      const verdict: never = report.verdict;
      throw new Error(`no ballot for an unknown verdict: ${String(verdict)}`);
    }
  }
}
