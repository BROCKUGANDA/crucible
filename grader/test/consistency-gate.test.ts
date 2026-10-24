import { describe, expect, it } from "vitest";
import {
  CONSISTENCY_RETESTS,
  CONSISTENCY_THRESHOLDS,
  DEFAULT_THRESHOLDS,
  Arena,
} from "../src/eval/arena.js";
import type { Artifact, ModelAdapter, Verdict } from "../src/eval/types.js";

function artifacts(n: number): Artifact[] {
  return Array.from({ length: n }, (_, i) => ({
    claimHash: `0x${i}`,
    payload: { index: i },
    expectedVerdict: "PASS",
    suite: "smoke",
  }));
}

interface CountingAdapter extends ModelAdapter {
  calls(): number;
}

/** A model that wobbles: its verdict flips on every successive draw. */
function flakyAdapter(id: string): CountingAdapter {
  let calls = 0;
  return {
    id,
    calls: () => calls,
    async grade() {
      calls += 1;
      const verdict: Verdict = calls % 2 === 0 ? "VOID" : "PASS";
      return { verdict, confidence: 0.7, latencyMs: 5, promptVersion: "v1" };
    },
  };
}

/** A model that answers identically every time. */
function stableAdapter(id: string): CountingAdapter {
  let calls = 0;
  return {
    id,
    calls: () => calls,
    async grade() {
      calls += 1;
      return { verdict: "PASS", confidence: 0.9, latencyMs: 5, promptVersion: "v1" };
    },
  };
}

const SUITES = { smoke: () => artifacts(3) };

/**
 * Gate 424 asked for "same artifact × 20 runs, agreement ≥ 98%". Before this the arena could not
 * fail it for two independent reasons, and the second one is the instructive one: the retest loop
 * called `gradeCached`, whose key was `(claimHash, modelId, promptVersion)`, so draws 2..20 were
 * answered from the cache without reaching the model and agreement was 1.0 by construction. A gate
 * that reports perfect stability while making one call is worse than no gate — it retires the
 * question.
 */
describe("the retest loop actually re-grades", () => {
  it("makes one call per draw, not one per artifact", async () => {
    const arena = new Arena();
    const adapter = stableAdapter("counting-stable");
    await arena.runSmoke([adapter], SUITES, 5, CONSISTENCY_THRESHOLDS);
    expect(adapter.calls()).toBe(15); // 3 artifacts × 5 draws
  });

  it("still spends only once per artifact when a run asks for a single draw", async () => {
    const arena = new Arena();
    const adapter = stableAdapter("counting-single");
    await arena.runSmoke([adapter], SUITES, 1, CONSISTENCY_THRESHOLDS);
    expect(adapter.calls()).toBe(3);
  });

  it("records the draws it took, so the scorecard says how much evidence a row is", async () => {
    const arena = new Arena();
    const adapter = stableAdapter("counting-draws");
    const card = await arena.runSmoke([adapter], SUITES, CONSISTENCY_RETESTS, CONSISTENCY_THRESHOLDS);
    expect(card.rows[0]!.draws).toBe(CONSISTENCY_RETESTS);
    expect(card.rows[0]!.consistency).toBe(1);
    expect(card.rows[0]!.disqualified).toBe(false);
  });
});

describe("the agreement gate can disqualify", () => {
  it("fails a wobbling model and names agreement in the reason", async () => {
    const arena = new Arena();
    const adapter = flakyAdapter("flaky");
    const card = await arena.runSmoke([adapter], SUITES, CONSISTENCY_RETESTS, CONSISTENCY_THRESHOLDS);
    const row = card.rows[0]!;

    expect(row.consistency).toBeLessThan(0.98);
    expect(row.disqualified).toBe(true);
    expect(row.disqualifyReason).toMatch(/agreement/);
    expect(row.disqualifyReason).not.toMatch(/false-pass|latency/);
  });

  it("fails a gated stage that drew once — absence of evidence is not a pass", async () => {
    const arena = new Arena();
    const adapter = stableAdapter("gated-once");
    const card = await arena.runSmoke([adapter], SUITES, 1, CONSISTENCY_THRESHOLDS);
    const row = card.rows[0]!;

    expect(row.consistency).toBe(1); // the vacuous number, now not accepted as a pass
    expect(row.disqualified).toBe(true);
    expect(row.disqualifyReason).toMatch(/not measured: 1 draw of 20 required/);
  });

  it("leaves an ungated stage alone, so smoke does not disqualify for cost", async () => {
    const arena = new Arena();
    const adapter = flakyAdapter("ungated-flaky");
    const card = await arena.runSmoke([adapter], SUITES, 1, DEFAULT_THRESHOLDS);
    const row = card.rows[0]!;

    expect(row.disqualified).toBe(false);
    expect(row.disqualifyReason).toBeUndefined();
  });

  it("still puts false-pass ahead of agreement, since dollars outrank wobble", async () => {
    const arena = new Arena();
    const bleed = {
      id: "bleeds",
      async grade() {
        return { verdict: "PASS", confidence: 0.9, latencyMs: 5, promptVersion: "v1" };
      },
    } satisfies ModelAdapter;
    const suites = {
      smoke: () =>
        artifacts(3).map((a, i) => ({ ...a, expectedVerdict: (i === 0 ? "VOID" : "PASS") as Verdict })),
    };
    const card = await arena.runSmoke([bleed], suites, CONSISTENCY_RETESTS, CONSISTENCY_THRESHOLDS);
    const row = card.rows[0]!;

    expect(row.falsePassRate).toBeGreaterThan(0);
    expect(row.disqualified).toBe(true);
    expect(row.disqualifyReason).toMatch(/false-pass rate/);
  });
});
