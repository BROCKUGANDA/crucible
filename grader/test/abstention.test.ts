import { describe, expect, it } from "vitest";
import {
  ABSTENTION_CONFIDENCE_THRESHOLD,
  ABSTENTION_RUBRIC,
  abstentionMetrics,
  abstentionSuite,
  wilsonInterval,
} from "../src/eval/abstention.js";
import { allSuites, calibrationSuite, suiteEpoch } from "../src/eval/suites.js";
import { scorecardLine, scorecardRow } from "../src/eval/scorer.js";
import type { EvalResult, ScorecardRow, Verdict } from "../src/eval/types.js";

const PASS: Verdict = "PASS";
const VOID: Verdict = "VOID";
const FAIL: Verdict = "FAIL";

const thresholds = { maxFalsePassRate: 0.01, maxP95LatencyMs: 20_000 };
const EPOCH = suiteEpoch(abstentionSuite());

function result(
  claimHash: string,
  expected: Verdict,
  actual: Verdict,
  confidence: number,
): EvalResult {
  return {
    claimHash,
    modelId: "stub",
    promptVersion: "v1",
    suite: "abstention",
    suiteEpoch: EPOCH,
    expected,
    actual,
    confidence,
    correct: actual === expected,
    falsePass: actual === PASS && expected !== PASS,
    falseFail: actual !== PASS && expected === PASS,
    latencyMs: 10,
    killed: false,
    tier: "frontier",
    difficulty: "stressed",
  };
}

function rowOf(results: EvalResult[], suite = "abstention"): ScorecardRow {
  return scorecardRow("stub", "v1", suite, EPOCH, results, new Map(), 0, thresholds);
}

/**
 * The corpus has to be an exam, not a loop.
 *
 * The calibration suite's regression is the precedent: sixty probes whose labels came from
 * `i % 2` made every accuracy computed from them a measurement of the generator. These checks
 * are the shape that would have caught it — all three verdicts present, answerable controls
 * beside the unanswerable probes, no period that reproduces the labels, and descriptive hashes
 * because the eval cache keys on them.
 */
describe("abstentionSuite", () => {
  const suite = abstentionSuite();
  const labels = suite.map((artifact) => artifact.expectedVerdict);

  it("is 40 content-labelled probes: 30 unanswerable and 10 controls", () => {
    expect(suite).toHaveLength(40);
    expect(labels.filter((label) => label === VOID)).toHaveLength(30);
    expect(labels.filter((label) => label === PASS)).toHaveLength(5);
    expect(labels.filter((label) => label === FAIL)).toHaveLength(5);
    expect(suite.every((artifact) => artifact.suite === "abstention")).toBe(true);
    expect(suite.every((artifact) => artifact.tier === "frontier")).toBe(true);
  });

  it("hands every probe the claim, evidence and rubric a grader has to read", () => {
    for (const artifact of suite) {
      const payload = artifact.payload as {
        kind?: string;
        domain?: string;
        claim?: string;
        evidence?: string | null;
        rubric?: string;
      };
      expect(payload.kind, artifact.claimHash).toBe("abstention");
      expect(typeof payload.domain, artifact.claimHash).toBe("string");
      expect((payload.domain ?? "").length, artifact.claimHash).toBeGreaterThan(2);
      expect(typeof payload.claim, artifact.claimHash).toBe("string");
      expect((payload.claim ?? "").length, artifact.claimHash).toBeGreaterThan(10);
      expect("evidence" in payload, artifact.claimHash).toBe(true);
      expect(payload.rubric, artifact.claimHash).toBe(ABSTENTION_RUBRIC);
    }
  });

  it("keeps the unanswerable half about insufficiency, not just absence", () => {
    const unanswerable = suite.filter((artifact) => artifact.expectedVerdict === VOID);
    const withEvidence = unanswerable.filter((artifact) => {
      const payload = artifact.payload as { evidence?: string | null };
      return typeof payload.evidence === "string" && payload.evidence.length > 20;
    });
    // A suite of nulls only tests "nothing was shown". The construct is the harder shape:
    // evidence is present and still does not settle the claim.
    expect(withEvidence.length).toBeGreaterThanOrEqual(25);
    expect(
      unanswerable.some((artifact) => {
        const payload = artifact.payload as { evidence?: string | null };
        return payload.evidence === null;
      }),
    ).toBe(true);
  });

  it("settles every control with evidence a grader can check", () => {
    for (const artifact of suite.filter((item) => item.expectedVerdict !== VOID)) {
      const payload = artifact.payload as { evidence?: string | null };
      expect(typeof payload.evidence, artifact.claimHash).toBe("string");
      expect((payload.evidence ?? "").length, artifact.claimHash).toBeGreaterThan(20);
    }
  });

  it("is not a function of the index, at any period a loop would produce", () => {
    for (const period of [1, 2, 3, 4, 5, 10]) {
      expect(
        labels.every((label, index) => label === labels[index % period]),
        `the labels repeat with period ${period}, which is a generator talking to itself`,
      ).toBe(false);
    }
    expect(labels.every((label, index) => label === (index % 3 === 0 ? VOID : PASS))).toBe(false);
  });

  it("names its artifacts instead of numbering them", () => {
    const hashes = suite.map((artifact) => artifact.claimHash);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const hash of hashes) {
      expect(hash, `${hash} is index-shaped, so a relabelled probe could reuse a cached verdict`).not.toMatch(
        /-\d{4}$/,
      );
    }
  });

  it("is a separate exam from the calibration corpus, not a copy of it", () => {
    const calibration = calibrationSuite();
    const calibrationHashes = new Set(calibration.map((artifact) => artifact.claimHash));
    for (const artifact of suite) {
      expect(calibrationHashes.has(artifact.claimHash), artifact.claimHash).toBe(false);
    }

    const words = (text: string): Set<string> =>
      new Set(
        text
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((word) => word.length > 2),
      );
    const jaccard = (a: Set<string>, b: Set<string>): number => {
      const intersection = [...a].filter((word) => b.has(word)).length;
      const union = new Set([...a, ...b]).size;
      return union === 0 ? 1 : intersection / union;
    };

    for (const artifact of suite) {
      const claim = (artifact.payload as { claim: string }).claim;
      for (const old of calibration) {
        const oldClaim = (old.payload as { claim?: string }).claim ?? "";
        expect(
          jaccard(words(claim), words(oldClaim)),
          `${artifact.claimHash} is near-duplicate of ${old.claimHash}`,
        ).toBeLessThan(0.8);
      }
    }

    expect(suiteEpoch(suite)).not.toBe(suiteEpoch(calibration));
    expect(allSuites().some((artifact) => artifact.suite === "abstention")).toBe(true);
  });
});

/**
 * Wilson rather than the normal approximation: these rates sit near 0 or 1 with tens of probes,
 * which is where the normal interval escapes [0, 1] or collapses. The known values below are
 * published Wilson intervals for 0/10, 5/10 and 10/10 at z = 1.96 — a changed formula or a changed
 * quantile has to argue with them.
 */
describe("wilsonInterval", () => {
  it("matches the published intervals at the boundaries and the middle", () => {
    const none = wilsonInterval(0, 10);
    expect(none).not.toBeNull();
    expect(none!.low).toBe(0);
    expect(none!.high).toBeCloseTo(0.2775, 3);

    const half = wilsonInterval(5, 10);
    expect(half).not.toBeNull();
    expect(half!.low).toBeCloseTo(0.2366, 3);
    expect(half!.high).toBeCloseTo(0.7634, 3);

    const all = wilsonInterval(10, 10);
    expect(all).not.toBeNull();
    expect(all!.low).toBeCloseTo(0.7225, 3);
    expect(all!.high).toBe(1);
  });

  it("returns no interval when no probe was asked", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it("contains the observed rate and stays inside [0, 1]", () => {
    for (const [successes, n] of [
      [3, 10],
      [17, 30],
      [29, 30],
      [1, 40],
    ] as const) {
      const interval = wilsonInterval(successes, n);
      expect(interval).not.toBeNull();
      expect(interval!.low).toBeGreaterThanOrEqual(0);
      expect(interval!.high).toBeLessThanOrEqual(1);
      expect(interval!.low).toBeLessThanOrEqual(successes / n);
      expect(interval!.high).toBeGreaterThanOrEqual(successes / n);
    }
  });

  it("narrows when the quantile is smaller", () => {
    const wide = wilsonInterval(8, 10, 1.96);
    const narrow = wilsonInterval(8, 10, 1.0);
    expect(wide).not.toBeNull();
    expect(narrow).not.toBeNull();
    expect(narrow!.low).toBeGreaterThan(wide!.low);
    expect(narrow!.high).toBeLessThan(wide!.high);
  });

  it("refuses counts that are not a count out of a sample", () => {
    expect(() => wilsonInterval(11, 10)).toThrow(/BAD_COUNT/);
    expect(() => wilsonInterval(-1, 10)).toThrow(/BAD_COUNT/);
    expect(() => wilsonInterval(5, -1)).toThrow(/BAD_COUNT/);
    expect(() => wilsonInterval(1.5, 10)).toThrow(/BAD_COUNT/);
    expect(() => wilsonInterval(5, 10.5)).toThrow(/BAD_COUNT/);
  });

  it("refuses a non-positive or non-finite quantile", () => {
    expect(() => wilsonInterval(5, 10, 0)).toThrow(/BAD_Z/);
    expect(() => wilsonInterval(5, 10, -1.96)).toThrow(/BAD_Z/);
    expect(() => wilsonInterval(5, 10, Number.NaN)).toThrow(/BAD_Z/);
    expect(() => wilsonInterval(5, 10, Number.POSITIVE_INFINITY)).toThrow(/BAD_Z/);
  });
});

describe("abstentionMetrics", () => {
  /**
   * Two unanswerable abstentions, two unanswerable guesses (one confident), one correct answer
   * and one false abstention. Every denominator and every failure kind is exercised by this set.
   */
  const results = [
    result("a", VOID, VOID, 0.6),
    result("b", VOID, PASS, 0.9),
    result("c", VOID, FAIL, 0.7),
    result("d", VOID, VOID, 0.4),
    result("e", PASS, PASS, 0.8),
    result("f", PASS, VOID, 0.5),
  ];
  const score = abstentionMetrics(results);

  it("splits by the gold label and reports both rates with their n", () => {
    expect(score.unanswerable.n).toBe(4);
    expect(score.unanswerable.abstained).toBe(2);
    expect(score.unanswerable.rate).toBe(0.5);
    expect(score.unanswerable.interval).not.toBeNull();

    expect(score.answerable.n).toBe(2);
    expect(score.answerable.falseAbstentions).toBe(1);
    expect(score.answerable.rate).toBe(0.5);
    expect(score.answerable.interval).not.toBeNull();
  });

  it("counts only confident guesses, over the unanswerable denominator", () => {
    expect(score.overconfidentGuesses.n).toBe(4);
    expect(score.overconfidentGuesses.count).toBe(1);
    expect(score.overconfidentGuesses.rate).toBe(0.25);
    expect(score.overconfidentGuesses.threshold).toBe(ABSTENTION_CONFIDENCE_THRESHOLD);
  });

  it("computes Brier over every probe, not only the failures", () => {
    expect(score.brier).toBeCloseTo(2.11 / 6, 10);
  });

  it("names the failures in result order and distinguishes the two kinds", () => {
    expect(score.failures.map((failure) => failure.claimHash)).toEqual(["b", "c", "f"]);
    expect(score.failures.map((failure) => failure.kind)).toEqual([
      "guess",
      "guess",
      "false-abstention",
    ]);
  });

  it("treats confidence exactly at the threshold as confident", () => {
    const atThreshold = abstentionMetrics([result("edge", VOID, PASS, ABSTENTION_CONFIDENCE_THRESHOLD)]);
    expect(atThreshold.overconfidentGuesses.count).toBe(1);
  });

  it("returns no measured rates and no Brier score for an empty set", () => {
    const empty = abstentionMetrics([]);
    expect(empty.unanswerable.n).toBe(0);
    expect(empty.unanswerable.rate).toBeNull();
    expect(empty.unanswerable.interval).toBeNull();
    expect(empty.answerable.rate).toBeNull();
    expect(empty.overconfidentGuesses.rate).toBeNull();
    expect(empty.brier).toBeNull();
    expect(empty.failures).toEqual([]);
  });

  it("refuses a confidence that is not a probability", () => {
    expect(() => abstentionMetrics([result("hot", VOID, VOID, 1.2)])).toThrow(/BAD_CONFIDENCE/);
    expect(() => abstentionMetrics([result("cold", VOID, VOID, -0.1)])).toThrow(/BAD_CONFIDENCE/);
    expect(() => abstentionMetrics([result("nan", VOID, VOID, Number.NaN)])).toThrow(/BAD_CONFIDENCE/);
  });

  /**
   * The pair of degenerate strategies, and the reason both rates are published. A model that
   * abstains on everything is perfectly cautious on the unanswerable half and perfectly useless
   * on the answerable half; a model that answers everything is the mirror image. Either number
   * alone can be held up as a success, and the pair cannot.
   */
  it("makes always-abstain and always-answer opposite failures", () => {
    const suite = abstentionSuite();
    const alwaysAbstain = suite.map((artifact) =>
      result(artifact.claimHash, artifact.expectedVerdict, VOID, 0.5),
    );
    const abstainScore = abstentionMetrics(alwaysAbstain);
    expect(abstainScore.unanswerable.rate).toBe(1);
    expect(abstainScore.answerable.rate).toBe(1);

    const alwaysAnswer = suite.map((artifact) =>
      result(artifact.claimHash, artifact.expectedVerdict, PASS, 0.8),
    );
    const answerScore = abstentionMetrics(alwaysAnswer);
    expect(answerScore.unanswerable.rate).toBe(0);
    expect(answerScore.answerable.rate).toBe(0);
  });
});

describe("the scorecard carries the score", () => {
  const suite = abstentionSuite();
  const alwaysFail = suite.map((artifact) =>
    result(artifact.claimHash, artifact.expectedVerdict, FAIL, 0.9),
  );

  it("attaches the score to an abstention row and leaves other rows without one", () => {
    const abstentionRow = rowOf(alwaysFail);
    expect(abstentionRow.abstention).toBeDefined();
    expect(abstentionRow.abstention!.unanswerable.n).toBe(30);
    expect(abstentionRow.abstention!.answerable.n).toBe(10);
    expect(abstentionRow.abstention!.failures.length).toBe(30);

    const otherRow = rowOf(alwaysFail, "smoke");
    expect(otherRow.abstention).toBeUndefined();
  });

  it("survives the JSONL boundary with the rates and failures intact", () => {
    const line = scorecardLine(rowOf(alwaysFail));
    const parsed = JSON.parse(line) as ScorecardRow;
    expect(parsed.abstention?.unanswerable.n).toBe(30);
    expect(parsed.abstention?.overconfidentGuesses.count).toBe(30);
    expect(parsed.abstention?.failures.length).toBe(30);
    // 30 wrong unanswerable probes + 5 wrong PASS controls at (0.9 - 0)^2, plus 5 correct FAIL
    // controls at (0.9 - 1)^2, over all 40 probes.
    expect(parsed.abstention?.brier).toBeCloseTo((35 * 0.81 + 5 * 0.01) / 40, 10);
  });

  /**
   * The existing false-pass gate catches a model that guesses PASS; it does not catch one that
   * guesses FAIL, because a FAIL on a VOID gold is wrong without being protocol bleed. That is
   * the hole the abstention rates fill, and this pair is the proof it is not already covered.
   */
  it("shows a FAIL-guessing model as un-abstaining without disqualifying it for false-pass", () => {
    const row = rowOf(alwaysFail);
    expect(row.falsePassRate).toBe(0);
    expect(row.disqualified).toBe(false);
    expect(row.abstention!.unanswerable.rate).toBe(0);
    expect(row.abstention!.overconfidentGuesses.rate).toBe(1);
  });

  it("still disqualifies a PASS-guessing model on the existing false-pass gate", () => {
    const alwaysPass = suite.map((artifact) =>
      result(artifact.claimHash, artifact.expectedVerdict, PASS, 0.9),
    );
    const row = rowOf(alwaysPass);
    expect(row.falsePassRate).toBeGreaterThan(thresholds.maxFalsePassRate);
    expect(row.disqualified).toBe(true);
    expect(row.disqualifyReason).toContain("false-pass rate");
  });
});
