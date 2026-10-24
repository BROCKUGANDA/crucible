import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ChainLog, ChainLogWire } from "../src/index.js";
import {
  MOMENT_ORDER,
  momentInfo,
  reduceReplay,
  speakableFrames,
  toChainLog,
} from "../src/index.js";

const fixture = (name: string): ChainLog[] => {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  const wires = JSON.parse(readFileSync(path, "utf8")) as ChainLogWire[];
  return wires.map(toChainLog);
};

/** The order the fixture is stored in is the order a chain wrote it, so the expected beats are
 *  readable as a sentence rather than as an index into a table nobody checks. */
const BEATS = [
  "posted",
  "claimed",
  "submitted",
  "broken",
  "disputed",
  "voting",
  "voting",
  "voting",
  "voting",
  "settled",
];

describe("the frame reducer", () => {
  const paid = reduceReplay(7, fixture("paid-with-break.json"));

  it("folds a settled trial into one frame per beat, in chain order", () => {
    expect(paid.frames.map((f) => f.moment)).toEqual(BEATS);
    expect(paid.frames.map((f) => f.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(paid.incomplete).toBe(false);
    expect(paid.summary.verdict).toBe("paid");
  });

  it("carries the payout the chain emitted and the fee that follows from it", () => {
    expect(paid.summary.rewardWei).toBe("900000000000000000");
    expect(paid.summary.payoutWei).toBe("855000000000000000");
    // 0.9 ETH reward, 5% house: the legacy law, and the subtraction the chain itself made.
    expect(paid.summary.feeWei).toBe("45000000000000000");
    const last = paid.frames[paid.frames.length - 1]!;
    expect(last.books.payoutWei).toBe("855000000000000000");
    expect(last.actor).toBeNull(); // VerdictFinalized names no actor; the page must not borrow one
  });

  it("keeps the running books so the money flow can be drawn without re-reading logs", () => {
    const byMoment = new Map(paid.frames.map((f) => [f.index, f]));
    expect(byMoment.get(0)!.books.rewardWei).toBe("900000000000000000");
    expect(byMoment.get(1)!.books.bondWei).toBe("180000000000000000");
    expect(byMoment.get(3)!.books.breakStakeWei).toBe("45000000000000000");
    expect(byMoment.get(2)!.digests.runHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(byMoment.get(3)!.digests.proofCID).toMatch(/^0x[0-9a-f]{64}$/);
    // the panel counts what the logs proved, and nothing else
    expect(byMoment.get(5)!.panel).toEqual({ committed: 1, revealed: 0, forBreak: 0 });
    expect(byMoment.get(9)!.panel).toEqual({ committed: 2, revealed: 2, forBreak: 0 });
  });

  it("names the actor the log carried, for the beat that has one", () => {
    expect(paid.frames[0]!.actor).toBe("0x1111111111111111111111111111111111111111");
    expect(paid.frames[3]!.actor).toBe("0x2222222222222222222222222222222222222222");
    expect(paid.frames[5]!.actor).toBe("0x3333333333333333333333333333333333333333");
  });

  it("reports a slash as an unknown fee rather than a zero one", () => {
    const slashed = reduceReplay(8, fixture("slashed.json"));
    expect(slashed.summary.verdict).toBe("slashed");
    expect(slashed.summary.payoutWei).toBe("0"); // the chain really did pay nothing
    expect(slashed.summary.feeWei).toBeNull(); // and no fee question was ever asked
    expect(slashed.frames[0]!.books.feeWei).toBeNull();
  });

  it("ignores logs from other trials instead of failing on them", () => {
    const mixed = [...fixture("paid-with-break.json"), ...fixture("slashed.json")];
    const replay = reduceReplay(7, mixed);
    expect(replay.frames).toHaveLength(10);
    expect(replay.frames.every((f) => f.source.event !== "Unknown")).toBe(true);
  });

  it("is replay-safe: a duplicated log is one frame, and arrival order is not chain order", () => {
    const logs = fixture("paid-with-break.json");
    const doubled = [...logs, ...logs];
    expect(reduceReplay(7, doubled).frames).toHaveLength(10);

    const scrambled = [...logs].reverse();
    const replay = reduceReplay(7, scrambled);
    expect(replay.frames.map((f) => f.moment)).toEqual(BEATS);
    expect(replay.replayHash).toBe(reduceReplay(7, logs).replayHash);
  });

  it("says so when the index never saw the trial being posted", () => {
    const logs = fixture("paid-with-break.json").slice(1); // no TrialCreated
    const replay = reduceReplay(7, logs);
    expect(replay.incomplete).toBe(true);
    expect(replay.frames).toHaveLength(9);
    // and the money it can still see stays visible rather than being invented
    expect(replay.summary.rewardWei).toBeNull();
    expect(replay.summary.feeWei).toBeNull();
  });
});

describe("the moment detector", () => {
  const paid = reduceReplay(7, fixture("paid-with-break.json"));

  it("speaks the beats that carry a turn, and stays quiet on a panel's seals", () => {
    const spoken = speakableFrames(paid);
    expect(spoken.map((f) => f.moment)).toEqual(["posted", "claimed", "submitted", "broken", "disputed", "settled"]);
    expect(paid.summary.speakable).toBe(spoken.length);
    expect(MOMENT_ORDER.filter((k) => !momentInfo(k).speakable)).toEqual(["voting"]);
  });

  it("never puts the builder's vocabulary where a visitor reads", () => {
    // AGENTS.md bans the vocabulary of the forge at the action: no wei, no chain ids, no
    // event names, no hex digests in the prose. The digests live in the frame's fields.
    const banned = ["wei", "31337", "anvil", "bytes32", "gas", "0x"];
    const words = paid.frames.flatMap((f) => [f.what, momentInfo(f.moment).label]);
    for (const word of words) {
      for (const term of banned) {
        expect(word.toLowerCase()).not.toContain(term);
      }
      expect(word).not.toMatch(/^[A-Z][a-z]+(Filed|Opened|Submitted|Finalized|Created|Claimed)$/);
    }
  });

  it("frames every beat with plain words and a hash that covers the money", () => {
    const first = paid.frames[0]!;
    expect(first.what).toBe("The trial was posted.");
    expect(first.frameHash).toMatch(/^[0-9a-f]{64}$/);

    // Same log, different amount: the hash must move, or a stored line could not prove which
    // frame it spoke about and a replay could be edited under its own caption.
    const logs = fixture("paid-with-break.json");
    const tampered = logs.map((l) => ({
      ...l,
      args: { ...l.args, reward: l.eventName === "TrialCreated" ? "100000000000000000" : l.args.reward },
    }));
    const tamperedReplay = reduceReplay(7, tampered);
    expect(tamperedReplay.frames[0]!.frameHash).not.toBe(first.frameHash);
    expect(tamperedReplay.replayHash).not.toBe(paid.replayHash);
  });
});

describe("the pinned trace", () => {
  it("reproduces the golden replay hash of the paid fixture", () => {
    const paid = reduceReplay(7, fixture("paid-with-break.json"));
    // Pinned from a measured run: any change to the frame shape, the words, or the books moves
    // it. This is the number a stored commentary line points at, so it is not free to drift.
    expect(paid.replayHash).toBe("0398e7606b79d04fedd1876937dd6552c21ee7a16be7b59bdd40fb5011b90a5a");
    expect(paid.frames[0]!.frameHash).toBe("e417efa81d739aab3e8e3db9a5f8a465a4da6cb5f314100aba25ed283877145f");
  });
});
