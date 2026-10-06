import { describe, expect, it } from "vitest";
import {
  applyEvent,
  attachCids,
  attachSignatures,
  breakWindowEndsIn,
  buildSnapshot,
  deadlineEndsIn,
  emptyModel,
  hall,
  hydrateTimestamps,
  listTrials,
  replay,
  weiToEth,
  type EventLike,
} from "../src/index.js";

const SPONSOR = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x2222222222222222222222222222222222222222";
const SKEPTIC = "0x3333333333333333333333333333333333333333";
const TRIALS = "0x4444444444444444444444444444444444444444";

function ev(
  eventName: string,
  args: Record<string, unknown>,
  blockNumber = 1n,
): EventLike {
  return {
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    address: TRIALS,
    eventName,
    args,
  };
}

/** The full happy path: trial → claim → run → break → verdict. */
function fullStory(): EventLike[] {
  return [
    ev("TrialCreated", {
      id: 1n,
      sponsor: SPONSOR,
      specCID: "0x" + "aa".repeat(32),
      testsCID: "0x" + "bb".repeat(32),
      reward: 10n ** 18n,
      bond: 2n * 10n ** 17n,
      deadline: 1_700_000_000n,
      breakWindow: 43_200n,
    }, 100n),
    ev("AgentRegistered", {
      agentId: 1n,
      operator: OPERATOR,
      runner: OPERATOR,
      metadataURI: "ipfs://manifest",
      stake: 10n ** 18n,
    }, 101n),
    ev("TrialClaimed", { id: 1n, agentId: 1n, bond: 2n * 10n ** 17n }, 102n),
    ev("RunSubmitted", { id: 1n, agentId: 1n, runHash: "0x" + "cc".repeat(32) }, 103n),
    ev("BreakFiled", {
      id: 1n,
      skeptic: SKEPTIC,
      proofCID: "0x" + "dd".repeat(32),
      stake: 10n ** 16n,
    }, 104n),
    ev("VerdictFinalized", { id: 1n, verdict: 1, agentPayout: 95n * 10n ** 16n }, 105n),
  ];
}

describe("applyEvent", () => {
  it("projects the full trial lifecycle", () => {
    const m = replay(fullStory());
    const t = m.trials.get(1)!;
    expect(t.sponsor).toBe(SPONSOR);
    expect(t.rewardWei).toBe(10n ** 18n);
    expect(t.bondWei).toBe(2n * 10n ** 17n);
    expect(t.agentId).toBe(1);
    expect(t.runHash).toBe("0x" + "cc".repeat(32));
    expect(t.breakSkeptic).toBe(SKEPTIC);
    expect(t.status).toBe("settled");
    expect(t.verdict).toBe("paid");
  });

  it("never mutates the model it is given", () => {
    const before = emptyModel();
    const after = applyEvent(before, fullStory()[0]!);
    expect(before.trials.size).toBe(0);
    expect(after.trials.size).toBe(1);
  });

  it("marks refunded verdicts distinctly from paid", () => {
    const m = replay([
      ev("TrialCreated", {
        id: 2n, sponsor: SPONSOR, specCID: "0xaa", testsCID: "0xbb",
        reward: 1n, bond: 1n, deadline: 1n, breakWindow: 1n,
      }),
      ev("VerdictFinalized", { id: 2n, verdict: 3, agentPayout: 0n }),
    ]);
    expect(m.trials.get(2)!.verdict).toBe("refunded");
  });

  it("ignores unknown events rather than throwing", () => {
    const m = replay([ev("SomethingNew", { id: 1n })]);
    expect(m.trials.size).toBe(0);
  });
});

describe("hydrateTimestamps", () => {
  it("replaces block numbers with real seconds", () => {
    const m = replay(fullStory());
    hydrateTimestamps(m, new Map([[100n, 1_699_000_000]]));
    expect(m.trials.get(1)!.createdAt).toBe(1_699_000_000);
  });

  it("leaves a timestamp alone when the block time is unknown", () => {
    const m = replay(fullStory());
    hydrateTimestamps(m, new Map());
    expect(m.trials.get(1)!.createdAt).toBe(100);
  });
});

describe("attachCids", () => {
  it("attaches the sponsor's CID text without touching the digests", () => {
    const m = replay(fullStory());
    attachCids(m, [{ trialId: 1, specCID: "bafySpec", testsCID: "bafyTests" }]);
    const t = m.trials.get(1)!;
    expect(t.specCID).toBe("bafySpec");
    expect(t.testsCID).toBe("bafyTests");
    expect(t.specDigest).toBe("0x" + "aa".repeat(32));
  });

  it("is what makes awaitingDisclosure false", () => {
    const m = replay(fullStory());
    expect(buildSnapshot(m, { now: 0 }).trials[0]!.awaitingDisclosure).toBe(true);
    attachCids(m, [{ trialId: 1, specCID: "s", testsCID: "t" }]);
    expect(buildSnapshot(m, { now: 0 }).trials[0]!.awaitingDisclosure).toBe(false);
  });

  it("ignores a disclosure for an unknown trial", () => {
    const m = replay(fullStory());
    expect(() => attachCids(m, [{ trialId: 999, specCID: "x" }])).not.toThrow();
  });
});

describe("attachSignatures", () => {
  it("carries the off-chain signature onto the run row", () => {
    const m = replay(fullStory());
    expect(m.runs.get(1)!.signature).toBeNull();
    attachSignatures(m, [{ trialId: 1, signature: "0xdead" }]);
    expect(m.runs.get(1)!.signature).toBe("0xdead");
  });
});

describe("countdowns", () => {
  it("counts down the run deadline while the trial is live", () => {
    // fullStory() ends in a verdict; use a trial that is still claimed
    const m = replay(fullStory().slice(0, 3));
    const t = listTrials(m)[0]!;
    expect(t.status).toBe("assigned");
    expect(deadlineEndsIn(t, 1_699_000_000)).toBe(1_000_000);
  });

  it("never returns a negative countdown", () => {
    const m = replay(fullStory().slice(0, 3));
    const t = listTrials(m)[0]!;
    expect(deadlineEndsIn(t, 1_900_000_000)).toBe(0);
  });

  it("stops the run countdown once settled", () => {
    const m = replay(fullStory());
    expect(deadlineEndsIn(listTrials(m)[0]!, 1_700_000_001)).toBeNull();
  });

  it("counts down the break window only while judging", () => {
    const m = replay(fullStory());
    const t = listTrials(m)[0]!;
    // status is settled, so no break countdown
    expect(breakWindowEndsIn(t, 1_700_000_000)).toBeNull();
  });
});

describe("hall", () => {
  it("excludes agents with no wins", () => {
    const m = replay(fullStory());
    m.agents.get(1)!.wins = 0;
    expect(hall(m)).toHaveLength(0);
  });

  it("ranks by wins, then survived, then fewest slashes", () => {
    const m = replay(fullStory());
    m.agents.set(2, { ...m.agents.get(1)!, id: 2, wins: 3, survived: 0, slashes: 0 });
    m.agents.set(3, { ...m.agents.get(1)!, id: 3, wins: 3, survived: 2, slashes: 1 });
    m.agents.get(1)!.wins = 5;
    const order = hall(m).map((e) => e.agentId);
    expect(order).toEqual([1, 3, 2]);
  });
});

describe("weiToEth", () => {
  it("renders whole and fractional amounts exactly", () => {
    expect(weiToEth(0n)).toBe("0");
    expect(weiToEth(10n ** 18n)).toBe("1");
    expect(weiToEth(95n * 10n ** 16n)).toBe("0.95");
    expect(weiToEth(1n)).toBe("0.000000000000000001");
  });

  it("never uses floating point, so no rounding error is possible", () => {
    expect(weiToEth(3333333333333333333n)).toBe("3.333333333333333333");
  });
});

describe("buildSnapshot", () => {
  it("produces a JSON-serialisable payload", () => {
    const m = replay(fullStory());
    const snap = buildSnapshot(m, { now: 1_699_000_000_000 });
    expect(() => JSON.stringify(snap)).not.toThrow();
    expect(snap.trials[0]!.rewardEth).toBe("1");
    expect(snap.trials[0]!.bondEth).toBe("0.2");
    expect(snap.counts.settled).toBe(1);
    expect(snap.counts.all).toBe(1);
  });

  it("uses the alloy registry for lock state when given", () => {
    const m = replay(fullStory());
    const snap = buildSnapshot(m, {
      now: 0,
      alloyState: (id) => ({ locked: id === 1, tokenUri: `data:.../${id}` }),
    });
    expect(snap.agents[0]!.alloyLocked).toBe(true);
    expect(snap.agents[0]!.tokenUri).toContain("/1");
  });
});
