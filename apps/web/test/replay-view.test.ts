import { describe, expect, it } from "vitest";
import { reduceReplay, momentInfo, type ChainLog } from "@crucible/frame";

import { flowRows, orDash, railRows, triggerFor } from "@/lib/replay/view";

const TX = (c: string) => `0x${c.repeat(32)}` as const;
const SPONSOR = "0x1111111111111111111111111111111111111111";
const SKEPTIC = "0x2222222222222222222222222222222222222222";

const LOGS: ChainLog[] = [
  {
    blockNumber: 10n,
    transactionHash: TX("a1"),
    logIndex: 0,
    address: "0x5555555555555555555555555555555555555555",
    eventName: "TrialCreated",
    args: {
      id: 7n,
      sponsor: SPONSOR,
      specCID: TX("c3"),
      testsCID: TX("d4"),
      reward: 900000000000000000n,
      bond: 180000000000000000n,
      deadline: 1800000000n,
      breakWindow: 86400n,
    },
  },
  { blockNumber: 12n, transactionHash: TX("b2"), logIndex: 0, address: "0x55", eventName: "TrialClaimed", args: { id: 7n, agentId: 3n, bond: 180000000000000000n } },
  { blockNumber: 20n, transactionHash: TX("c3"), logIndex: 0, address: "0x55", eventName: "RunSubmitted", args: { id: 7n, agentId: 3n, runHash: TX("e5") } },
  { blockNumber: 22n, transactionHash: TX("d4"), logIndex: 0, address: "0x55", eventName: "BreakFiled", args: { id: 7n, skeptic: SKEPTIC, proofCID: TX("f6"), stake: 45000000000000000n } },
  { blockNumber: 23n, transactionHash: TX("e5"), logIndex: 0, address: "0x55", eventName: "DisputeOpened", args: { id: 7n } },
  { blockNumber: 24n, transactionHash: TX("f6"), logIndex: 0, address: "0x55", eventName: "VoteCommitted", args: { id: 7n, judge: "0x3333333333333333333333333333333333333333" } },
  { blockNumber: 30n, transactionHash: TX("07"), logIndex: 0, address: "0x55", eventName: "VerdictFinalized", args: { id: 7n, verdict: 1n, agentPayout: 855000000000000000n } },
];

const replay = reduceReplay(7, LOGS);

describe("the replay rail", () => {
  it("keeps one row per beat, with the frame's own hash as the caption id", () => {
    const rows = railRows(replay);
    expect(rows.map((r) => r.moment)).toEqual([
      "posted",
      "claimed",
      "submitted",
      "broken",
      "disputed",
      "voting",
      "settled",
    ]);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.frameHash))).toBe(true);
    expect(rows.map((r) => r.block)).toEqual([10, 12, 20, 22, 23, 24, 30]);
  });

  it("takes its words from the moment detector instead of keeping a copy", () => {
    const rows = railRows(replay);
    for (const row of rows) {
      expect(row.label).toBe(momentInfo(row.moment).label);
    }
  });

  it("binds each beat to Frenchy's existing pools and stays silent where there is no pool", () => {
    const byMoment = new Map(railRows(replay).map((r) => [r.moment, r.trigger]));
    expect(byMoment.get("posted")).toBe("escrow_opened");
    expect(byMoment.get("claimed")).toBe("work_posted");
    expect(byMoment.get("broken")).toBe("dispute_opened");
    expect(byMoment.get("disputed")).toBe("dispute_opened");
    expect(byMoment.get("settled")).toBe("verdict_pass");
    // no pool for a run arriving, and a vote seal is not worth an interruption
    expect(byMoment.get("submitted")).toBeNull();
    expect(byMoment.get("voting")).toBeNull();
  });

  it("names a verdict's outcome through the slash, not through the reward", () => {
    const slashed = reduceReplay(
      8,
      LOGS.map((l) =>
        l.eventName === "VerdictFinalized"
          ? { ...l, args: { id: 8n, verdict: 2n, agentPayout: 0n } }
          : { ...l, args: { ...l.args, id: 8n } },
      ),
    );
    const settled = slashed.frames.find((f) => f.moment === "settled")!;
    expect(triggerFor(settled)).toBe("verdict_fail");
  });
});

describe("the money flow", () => {
  it("lists only the beats that moved something, and says which way", () => {
    const rows = flowRows(replay);
    expect(rows.map((r) => r.moment)).toEqual(["posted", "claimed", "broken", "settled"]);
    expect(rows.map((r) => r.direction)).toEqual(["in", "in", "in", "out"]);
    expect(rows.map((r) => r.movedWei)).toEqual([
      "900000000000000000",
      "180000000000000000",
      "45000000000000000",
      "855000000000000000",
    ]);
  });

  it("credits the settlement for withdrawal instead of claiming a payment", () => {
    // ADR-0003: settlement never pushes ETH. A reader told money was sent will go looking for
    // a transfer that does not exist, so the wording is the fact under test here.
    const settled = flowRows(replay).find((r) => r.moment === "settled")!;
    expect(settled.movement).toMatch(/credited/i);
    expect(settled.movement).toMatch(/withdraw/i);
    expect(settled.movement.toLowerCase()).not.toMatch(/sent|paid out|transferred|pushed/);
  });

  it("leaves a name blank rather than borrowing one from the neighbour", () => {
    const rows = flowRows(replay);
    // the claim log names no address; the sponsor on the row above is not the claimer
    expect(rows.find((r) => r.moment === "claimed")!.who).toBeNull();
    expect(rows.find((r) => r.moment === "posted")!.who).toBe(SPONSOR);
    expect(rows.find((r) => r.moment === "broken")!.who).toBe(SKEPTIC);
    expect(rows.find((r) => r.moment === "broken")!.digest).toBe(TX("f6"));
  });

  it("reports no escrow total, because the logs do not carry one", () => {
    // VerdictFinalized emits only the agent's payout. Anything resembling a running balance here
    // would be arithmetic this projection never sourced.
    const rows = flowRows(replay);
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("escrowWei");
      expect(Object.keys(row)).not.toContain("runningTotalWei");
    }
  });
});

describe("the dash rule", () => {
  it("renders nothing as a dash, and zero as a number", () => {
    expect(orDash(null)).toBe("—");
    expect(orDash(undefined)).toBe("—");
    expect(orDash("")).toBe("—");
    expect(orDash("0")).toBe("0");
  });
});
