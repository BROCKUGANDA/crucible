import { describe, expect, it } from "vitest";
import type { ApiSnapshot } from "@crucible/indexer";
import { CROWD_SATURATION, deriveFacts } from "@/lib/scrub/arenaFacts";

/**
 * The scene's three data-driven facts, asserted against fixtures rather than trusted.
 *
 * Each of these is a claim a reader can act on: which way the last settlement went, how many
 * smiths are registered, what tier leads the hall. The failure mode this guards is the one
 * this project has already been hunted for six times — a plausible-looking empty answer that
 * reads as a measurement.
 */
function snapshot(over: Partial<ApiSnapshot>): ApiSnapshot {
  return {
    now: 1_700_000_000,
    trials: [],
    agents: [],
    hall: [],
    counts: { all: 0, open: 0, assigned: 0, judging: 0, challenged: 0, settled: 0 },
    ...over,
  } as ApiSnapshot;
}

function hallEntry(tier: number | null, settlements: { trialId: number; verdict: string; blockNumber: number }[]) {
  return {
    agentId: 1,
    tier,
    tierName: null,
    identity: null,
    settlements: settlements.map((s) => ({ ...s, txHash: "0xabc", payoutEth: "0.1", breakFiled: true })),
  } as unknown as ApiSnapshot["hall"][number];
}

/**
 * An economics block carrying only the fields a case names. Deliberately partial: the difference
 * between "the take is zero" and "nobody read the take" is one of the things asserted below, and
 * a fixture that filled every field would erase it.
 */
function economics(over: Partial<NonNullable<ApiSnapshot["economics"]>>): ApiSnapshot["economics"] {
  return over as ApiSnapshot["economics"];
}

describe("arena facts", () => {
  it("reports no facts at all before the index answers", () => {
    const facts = deriveFacts(null);
    expect(facts.trials).toBeNull();
    expect(facts.smiths).toBeNull();
    expect(facts.settled).toBeNull();
    expect(facts.seal).toBeNull();
    expect(facts.markBlock).toBeNull();
    expect(facts.take).toBeNull();
    expect(facts.mark).toBe("none");
    expect(facts.crowd).toBe(0);
  });

  it("does not turn a missing snapshot into zero", () => {
    // An empty arena and an unmeasured arena are different statements.
    expect(deriveFacts(snapshot({})).trials).toBe(0);
    expect(deriveFacts(undefined).trials).toBeNull();
  });

  it("takes the mark from the newest settlement by block, not from the top of the rank", () => {
    const facts = deriveFacts(
      snapshot({
        hall: [
          // Ranked first, but its last settlement is older.
          hallEntry(4, [{ trialId: 9, verdict: "paid", blockNumber: 100 }]),
          hallEntry(2, [{ trialId: 12, verdict: "slashed", blockNumber: 480 }]),
        ],
      }),
    );
    expect(facts.mark).toBe("slashed");
    expect(facts.markBlock).toBe(480);
  });

  it("settles nothing into a bronze seal", () => {
    const facts = deriveFacts(snapshot({ hall: [hallEntry(1, [])] }));
    expect(facts.mark).toBe("none");
    expect(facts.markBlock).toBeNull();
  });

  it("draws the crowd from registered smiths and stops rising when the ring is full", () => {
    const half = deriveFacts(snapshot({ agents: Array(CROWD_SATURATION / 2) }));
    expect(half.crowd).toBeCloseTo(0.5, 6);

    const over = deriveFacts(snapshot({ agents: Array(CROWD_SATURATION * 4) }));
    expect(over.crowd).toBe(1);
  });

  it("puts no numeral in the seal when no registry read backs it", () => {
    expect(deriveFacts(snapshot({ hall: [hallEntry(null, [])] })).seal).toBeNull();
    expect(deriveFacts(snapshot({ hall: [hallEntry(4, [])] })).seal).toBe("V");
    expect(deriveFacts(snapshot({ hall: [hallEntry(0, [])] })).seal).toBe("I");
  });

  it("counts trials and settlements from the snapshot's own counts", () => {
    const facts = deriveFacts(
      snapshot({
        counts: { all: 7, open: 2, assigned: 1, judging: 1, challenged: 1, settled: 2 },
        agents: Array(3),
      }),
    );
    expect(facts.trials).toBe(7);
    expect(facts.settled).toBe(2);
    expect(facts.smiths).toBe(3);
  });

  it("survives a payload with the arrays missing rather than throwing at the canvas", () => {
    const facts = deriveFacts({ now: 1 } as unknown as ApiSnapshot);
    expect(facts.crowd).toBe(0);
    expect(facts.mark).toBe("none");
    expect(facts.trials).toBeNull();
    // An absent `agents` array is not zero smiths, and the HUD has to be able to tell the two
    // apart: one is an empty arena, the other is an arena nobody looked at.
    expect(facts.smiths).toBeNull();
  });

  it("reads zero smiths as zero only when the array is really there", () => {
    expect(deriveFacts(snapshot({ agents: [] })).smiths).toBe(0);
  });

  it("names the metal on the treasury's take, not a bare decimal among counts", () => {
    // Every other HUD cell is a count. A take that prints as "0.05" is read as one more tally
    // for something nobody can say the unit of.
    const facts = deriveFacts(snapshot({ economics: economics({ feesEth: "0.05" }) }));
    expect(facts.take).toBe("0.05 ETH");
  });

  it("truncates the take instead of rounding it up", () => {
    // The same rule `api.ts` states for stakes: a figure the reader is shown must not exceed
    // the figure the chain holds.
    const facts = deriveFacts(
      snapshot({ economics: economics({ feesEth: "0.999999999999999999" }) }),
    );
    expect(facts.take).toBe("0.999 ETH");
  });

  it("leaves the take unmeasured when no economics came back", () => {
    // A HUD that renders "0 ETH" here is claiming the forge kept nothing, on the authority of a
    // snapshot that never said so. Null reaches the em dash; zero does not.
    expect(deriveFacts(snapshot({})).take).toBeNull();
    expect(deriveFacts(snapshot({ economics: economics({}) })).take).toBeNull();
  });

  it("renders a measured zero take as zero, distinct from the unmeasured one", () => {
    expect(deriveFacts(snapshot({ economics: economics({ feesEth: "0" }) })).take).toBe("0 ETH");
  });
});
