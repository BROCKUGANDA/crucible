import { describe, expect, it } from "vitest";
import type { VerifyReport } from "@crucible/argus";
import {
  NO_COMMIT,
  STATUS_CHALLENGED,
  ballotFor,
  gateCommit,
  gateReveal,
  windowStillOpen,
  type DisputeView,
  type SeatConstants,
} from "../src/policy.js";

/**
 * The rules, alone.
 *
 * Each case here is a transaction the contract would otherwise have to reject. The gate is what
 * makes a seat polite on a shared node: `commitVote` reverts `NotArgus`, `NotChallenged`,
 * `CommitClosed` or `AlreadyCommitted`, `revealVote` reverts `CommitMismatch` or
 * `AlreadyRevealed`, and every one of those reverts costs gas and buys nothing.
 */

const SEAT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const PEER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const OPENED_AT = 1_800_000_000;

const K: SeatConstants = { commitWindowSec: 86_400, threshold: 2, marginSec: 960 };

function d(patch: Partial<DisputeView> = {}): DisputeView {
  return {
    trialId: 7,
    status: STATUS_CHALLENGED,
    openedAt: OPENED_AT,
    committed: [],
    revealed: [],
    seatCommit: NO_COMMIT,
    seatRevealed: false,
    ...patch,
  };
}

const rep = (verdict: VerifyReport["verdict"], phase: VerifyReport["phase"] = "deterministic"): VerifyReport =>
  ({ verdict, phase, steps: [], reason: "fixture" }) as VerifyReport;

describe("gateCommit", () => {
  it("asks for a verification when the trial is challenged, unsealed and inside the window", () => {
    const gate = gateCommit(d(), K, OPENED_AT + 60);
    expect(gate).toEqual({ act: "verify", closesAt: OPENED_AT + 86_400 });
  });

  it("holds rather than verifying a trial the chain no longer calls Challenged", () => {
    // The index says challenged; the chain says settled. The chain is right, and a commit here
    // reverts `NotChallenged`.
    expect(gateCommit(d({ status: 4 }), K, OPENED_AT + 60).act).toBe("hold");
  });

  it("forfeits on the exact boundary the contract uses", () => {
    // `block.timestamp >= openedAt + COMMIT_WINDOW` reverts, so the same second is already too
    // late — a gate that used `>` would post a doomed transaction on the boundary.
    expect(gateCommit(d(), K, OPENED_AT + 86_400).act).toBe("forfeit");
    expect(gateCommit(d(), K, OPENED_AT + 86_400 - 1)).toMatchObject({ act: "verify" });
  });

  it("holds when the window is open but cannot survive a re-run", () => {
    const gate = gateCommit(d(), K, OPENED_AT + 86_400 - 900);
    expect(gate.act).toBe("hold");
    expect(gate.act === "hold" && gate.reason).toContain("less than the 960s");
  });

  it("forfeits a commitment it cannot open, instead of polling a permanent revert", () => {
    // The destroyed-vote case: a commitment exists on chain and this seat holds no salt for it
    // (the caller only asks `gateCommit` of trials it holds nothing for). `AlreadyCommitted`
    // means the seat can neither replace the vote nor add one, so the answer is a permanent
    // stop, recorded and reported — not a hold that retries every thirty seconds.
    const gate = gateCommit(d({ seatCommit: `0x${"bb".repeat(32)}` }), K, OPENED_AT + 60);
    expect(gate.act).toBe("forfeit");
    expect(gate.act === "forfeit" && gate.reason).toContain("AlreadyCommitted");
  });

  it("re-checks the window after the slow half of the pass", () => {
    expect(windowStillOpen(d(), K, OPENED_AT + 86_399)).toBe(true);
    expect(windowStillOpen(d(), K, OPENED_AT + 86_400)).toBe(false);
    expect(windowStillOpen(d({ status: 4 }), K, OPENED_AT + 60)).toBe(false);
  });
});

describe("gateReveal", () => {
  const sealed = { breakWins: true };

  it("will not unseal before the quorum has sealed", () => {
    // ADR-0004. One seal is this seat's own; revealing into that is voting alone.
    const gate = gateReveal(d({ committed: [SEAT.toLowerCase()] }), SEAT, sealed, K);
    expect(gate.act).toBe("hold");
    expect(gate.act === "hold" && gate.reason).toContain("waiting for 2 seats to seal; 1 have");
  });

  it("unseals once two seats have sealed, which is the count that settles the trial", () => {
    const gate = gateReveal(d({ committed: [SEAT.toLowerCase(), PEER.toLowerCase()] }), SEAT, sealed, K);
    expect(gate).toEqual({ act: "reveal", breakWins: true });
  });

  it("counts seals, not reveals, so a peer's unopened commitment still counts", () => {
    // The point of the rule is that a seat cannot read a peer's *vote* — and a commitment is a
    // hash, so two seals are enough to make copying pointless. Requiring two reveals first
    // would deadlock the committee: nobody opens, nobody counts.
    const gate = gateReveal(
      d({ committed: [SEAT.toLowerCase(), PEER.toLowerCase()], revealed: [] }),
      SEAT,
      sealed,
      K,
    );
    expect(gate.act).toBe("reveal");
  });

  it("drops a seal for a dispute that is over", () => {
    expect(gateReveal(d({ status: 4 }), SEAT, sealed, K).act).toBe("drop");
  });

  it("drops a seal the chain already opened", () => {
    expect(gateReveal(d({ seatRevealed: true, committed: [SEAT.toLowerCase(), PEER.toLowerCase()] }), SEAT, sealed, K).act).toBe(
      "drop",
    );
    expect(
      gateReveal(
        d({ revealed: [SEAT.toLowerCase()], committed: [SEAT.toLowerCase(), PEER.toLowerCase()] }),
        SEAT,
        sealed,
        K,
      ).act,
    ).toBe("drop");
  });

  it("drops a stored seal with no commitment behind it", () => {
    // The salt was written, the commit never landed. Revealing reverts `CommitMismatch` forever,
    // and the seat must be free to verify the trial again from scratch.
    expect(gateReveal(d({ seatCommit: NO_COMMIT }), SEAT, sealed, K)).toMatchObject({ act: "drop" });
  });

  it("holds when the chain has a commitment the store cannot open", () => {
    // Unreachable from the operator's own loop, which never enters this path without a record —
    // and that is the reason it is written down rather than assumed. A caller that got the
    // ordering wrong would otherwise get a `drop` and lose the fact that a vote is stuck.
    expect(gateReveal(d({ seatCommit: `0x${"bb".repeat(32)}` }), SEAT, null, K).act).toBe("hold");
  });
});

describe("ballotFor", () => {
  it("maps break-wins to true, which is what the contract counts toward slashing", () => {
    expect(ballotFor(rep("break-wins"))).toEqual({ vote: "seal", breakWins: true });
  });

  it("maps agent-wins to false", () => {
    expect(ballotFor(rep("agent-wins"))).toEqual({ vote: "seal", breakWins: false });
  });

  it("produces no seal for an abstain, from either phase", () => {
    // The rule the whole product rests on: `abstain` means "I could not check", and a committee
    // that cannot decide is designed to pay the agent (`CrucibleTrials.sol:594`). Mapping the
    // abstention onto either side would convert this seat's outage into a vote.
    expect(ballotFor(rep("abstain", "abstain"))).toEqual({ vote: "abstain" });
    expect(ballotFor(rep("abstain", "rubric"))).toEqual({ vote: "abstain" });
  });

  it("never reports a seal for an abstain, in any spelling", () => {
    // The shape assertion a future refactor cannot quietly weaken: an abstain must not be
    // coercible into a ballot with a `breakWins` on it.
    const ballot = ballotFor(rep("abstain", "abstain"));
    expect("breakWins" in ballot).toBe(false);
  });
});
