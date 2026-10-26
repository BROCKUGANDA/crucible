import { describe, expect, it } from "vitest";
import {
  accuracy,
  buildScorecard,
  consistency,
  corpusEpochOf,
  falseFailRate,
  falsePassRate,
  kappa,
  killRate,
  mean,
  p95,
  scorecardLine,
  trustPageLine,
} from "../src/eval/scorer.js";
import { smokeSet, suiteEpoch } from "../src/eval/suites.js";
import type { EvalResult, ScorecardRow, SmokeThresholds } from "../src/eval/types.js";

const PASS = "PASS" as const;
const VOID = "VOID" as const;
const FAIL = "FAIL" as const;

/** The epoch of a real corpus, so the rows below carry a digest that describes something. */
const EPOCH = suiteEpoch(smokeSet());

function result(
  expected: typeof PASS | typeof VOID | typeof FAIL,
  actual: typeof PASS | typeof VOID | typeof FAIL,
  killed = false,
  latencyMs = 10,
): EvalResult {
  const correct = actual === expected;
  return {
    claimHash: `claim-${Math.random()}`,
    modelId: "stub",
    promptVersion: "v1",
    suite: "smoke",
    suiteEpoch: EPOCH,
    expected,
    actual,
    confidence: 0.5,
    correct,
    falsePass: actual === "PASS" && expected !== "PASS",
    falseFail: actual !== "PASS" && expected === "PASS",
    latencyMs,
    killed,
    // Every result says what it tested, or the scorer refuses to profile it — see `tiers.test.ts`.
    tier: "competence",
    difficulty: "routine",
  };
}

const thresholds: SmokeThresholds = { maxFalsePassRate: 0.01, maxP95LatencyMs: 20_000 };

describe("kappa", () => {
  it("returns 1 for perfect agreement", () => {
    const rs = [result(PASS, PASS), result(VOID, VOID), result(FAIL, FAIL)];
    expect(kappa(rs)).toBeCloseTo(1, 6);
  });

  it("returns 0 for chance-level agreement", () => {
    const rs = [
      result(PASS, PASS),
      result(PASS, VOID),
      result(VOID, PASS),
      result(VOID, VOID),
    ];
    expect(kappa(rs)).toBeCloseTo(0, 6);
  });

  it("is negative for anti-agreement", () => {
    const rs = [result(PASS, VOID), result(VOID, PASS)];
    expect(kappa(rs)).toBeLessThan(0);
  });

  it("handles empty input", () => {
    expect(kappa([])).toBe(0);
  });
});

describe("false-pass / false-fail", () => {
  it("counts false passes only when expected is not PASS", () => {
    const rs = [
      result(PASS, PASS), // correct
      result(VOID, PASS), // false pass
      result(FAIL, PASS), // false pass
      result(PASS, VOID), // false fail
    ];
    expect(falsePassRate(rs)).toBeCloseTo(2 / 4, 6);
    expect(falseFailRate(rs)).toBeCloseTo(1 / 4, 6);
  });

  it("returns 0 on empty input", () => {
    expect(falsePassRate([])).toBe(0);
    expect(falseFailRate([])).toBe(0);
  });
});

describe("accuracy / killRate", () => {
  it("computes accuracy", () => {
    const rs = [result(PASS, PASS), result(VOID, PASS), result(FAIL, FAIL)];
    expect(accuracy(rs)).toBeCloseTo(2 / 3, 6);
  });

  it("computes kill rate", () => {
    const rs = [
      result(PASS, PASS, true),
      result(VOID, VOID, false),
      result(FAIL, FAIL, true),
    ];
    expect(killRate(rs)).toBeCloseTo(2 / 3, 6);
  });
});

describe("consistency", () => {
  it("returns 1 when all retests agree", () => {
    const m = new Map([
      ["a", [PASS, PASS, PASS]],
      ["b", [VOID, VOID]],
    ]);
    expect(consistency(m)).toBe(1);
  });

  it("returns 0 when none agree", () => {
    const m = new Map([
      ["a", [PASS, VOID]],
      ["b", [PASS, VOID]],
    ]);
    expect(consistency(m)).toBe(0);
  });

  it("handles empty map", () => {
    expect(consistency(new Map())).toBe(0);
  });
});

describe("p95 / mean", () => {
  it("computes p95 and mean", () => {
    const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(p95(vals)).toBe(10);
    expect(mean(vals)).toBe(5.5);
    expect(p95([])).toBe(0);
    expect(mean([])).toBe(0);
  });
});

describe("buildScorecard + JSONL line", () => {
  it("builds a row and serializes to JSONL", () => {
    const rs = [result(PASS, PASS), result(VOID, PASS)];
    const row = buildScorecard(
      [
        {
          modelId: "stub",
          promptVersion: "v1",
          suite: "smoke",
          suiteEpoch: EPOCH,
          results: rs,
          perArtifactConsistency: new Map([
            ["c1", [PASS, PASS]],
            ["c2", [PASS, VOID]],
          ]),
          avgCostUsd: 0,
        },
      ],
      thresholds,
    );

    expect(row.rows.length).toBe(1);
    const r = row.rows[0];
    expect(r.modelId).toBe("stub");
    expect(r.falsePassRate).toBeCloseTo(0.5, 6);
    expect(r.disqualified).toBe(true); // false-pass 0.5 > 0.01
    expect(r.disqualifyReason).toContain("false-pass rate");
    // The row says which exam it scored. Without this, `suite: "smoke"` names a function, not a corpus.
    expect(r.suiteEpoch).toBe(EPOCH);
    expect(row.corpusEpoch).toBe(corpusEpochOf([r]));

    const line = scorecardLine(r);
    const parsed = JSON.parse(line) as ScorecardRow;
    expect(parsed.modelId).toBe("stub");
    expect(parsed.disqualified).toBe(true);
    expect(parsed.suiteEpoch).toBe(EPOCH);
  });
});

/**
 * `corpusEpoch` is the identity of the whole scorecard, and it is derived from the rows rather than
 * supplied beside them — a caller who could pass it could pass a wrong one.
 */
describe("corpusEpochOf", () => {
  function rowOf(modelId: string, suite: "smoke" | "full" | "adversarial", epoch: string): ScorecardRow {
    return buildScorecard(
      [{ modelId, promptVersion: "v1", suite, suiteEpoch: epoch, results: [result(PASS, PASS)], perArtifactConsistency: new Map(), avgCostUsd: 0 }],
      thresholds,
    ).rows[0];
  }

  it("is a real digest for an empty scorecard, not an empty string", () => {
    const empty = corpusEpochOf([]);
    expect(empty).toMatch(/^[0-9a-f]{64}$/);
    expect(empty).not.toBe("");
  });

  it("collapses rows that scored the same corpus", () => {
    const a = rowOf("model-a", "smoke", EPOCH);
    const b = rowOf("model-b", "smoke", EPOCH);
    expect(corpusEpochOf([a, b])).toBe(corpusEpochOf([a]));
  });

  it("does not depend on row order", () => {
    const a = rowOf("model-a", "smoke", EPOCH);
    const b = rowOf("model-b", "full", EPOCH);
    expect(corpusEpochOf([a, b])).toBe(corpusEpochOf([b, a]));
  });

  /**
   * The case a map keyed by suite name would silently resolve: two rows both reading `smoke`,
   * scored against two generations of the corpus. Keying by name would pick one epoch and publish
   * a hash describing neither. Keeping both pairs makes the disagreement part of the identity.
   */
  it("keeps a disagreement between two rows that share a suite name", () => {
    const relabelled = suiteEpoch(smokeSet().map((a) => ({ ...a, expectedVerdict: "VOID" })));
    expect(relabelled).not.toBe(EPOCH);

    const before = rowOf("model-a", "smoke", EPOCH);
    const after = rowOf("model-a", "smoke", relabelled);

    const mixed = corpusEpochOf([before, after]);
    expect(mixed).not.toBe(corpusEpochOf([before]));
    expect(mixed).not.toBe(corpusEpochOf([after]));
  });
});

describe("trustPageLine (gate 432)", () => {
  it("renders the public scorecard line per graderVersion", () => {
    const line = trustPageLine("v3", "claude-opus-4", 0.91, 0.94, 0.004);
    expect(line).toBe('Warden v3 — model claude-opus-4 · kappa 0.91 · kill-rate 94% · false-pass 0.4%');
  });

  it("formats kill-rate and false-pass as whole and one-decimal percents", () => {
    const line = trustPageLine("v1", "stub", 0.5, 1.0, 0.017);
    expect(line).toContain('kill-rate 100%');
    expect(line).toContain('false-pass 1.7%');
  });
});
