import { describe, expect, it } from "vitest";
import {
  accuracy,
  buildScorecard,
  consistency,
  falseFailRate,
  falsePassRate,
  kappa,
  killRate,
  mean,
  p95,
  scorecardLine,
  trustPageLine,
} from "../src/eval/scorer.js";
import type { EvalResult, ScorecardRow, SmokeThresholds } from "../src/eval/types.js";

const PASS = "PASS" as const;
const VOID = "VOID" as const;
const FAIL = "FAIL" as const;

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
    expected,
    actual,
    confidence: 0.5,
    correct,
    falsePass: actual === "PASS" && expected !== "PASS",
    falseFail: actual !== "PASS" && expected === "PASS",
    latencyMs,
    killed,
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

    const line = scorecardLine(r);
    const parsed = JSON.parse(line) as ScorecardRow;
    expect(parsed.modelId).toBe("stub");
    expect(parsed.disqualified).toBe(true);
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
