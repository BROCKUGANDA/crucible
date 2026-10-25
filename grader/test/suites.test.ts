import { describe, expect, it } from "vitest";
import { allSuites, calibrationSuite, injectionSuite, smokeSet, suiteEpoch } from "../src/eval/suites.js";
import type { Artifact } from "../src/eval/types.js";

/**
 * The corpus is the one input a scorecard is computed *from*, and until it had a digest every other
 * input did: probes carry `bankHash`, a model carries `identityHash`, a run carries `paramsHash`.
 * These tests are about the property that makes the digest worth having — that it moves when the
 * exam moves and does not move when only the plumbing does.
 */
describe("suiteEpoch", () => {
  const one: Artifact = {
    claimHash: "smoke-0000",
    payload: { kind: "run-artifact", index: 0, seed: 0 },
    expectedVerdict: "PASS",
    suite: "smoke",
    thresholdBand: "normal",
  };

  it("is stable across two independent generations of the same corpus", () => {
    expect(suiteEpoch(smokeSet())).toBe(suiteEpoch(smokeSet()));
    expect(suiteEpoch(smokeSet())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable to the order the artifacts were generated in", () => {
    const corpus = smokeSet();
    const shuffled = [...corpus].reverse();
    expect(shuffled[0]!.claimHash).not.toBe(corpus[0]!.claimHash);
    expect(suiteEpoch(shuffled)).toBe(suiteEpoch(corpus));
  });

  /** The gold label *is* the exam. Hashing questions without answers is the change worth seeing. */
  it("moves when a gold label is flipped", () => {
    const corpus = smokeSet();
    const relabelled = corpus.map((a, i) => (i === 0 ? { ...a, expectedVerdict: "VOID" as const } : a));
    expect(suiteEpoch(relabelled)).not.toBe(suiteEpoch(corpus));
  });

  it("moves when a payload byte changes", () => {
    const corpus = smokeSet();
    const edited = corpus.map((a, i) =>
      i === 0 ? { ...a, payload: { ...(a.payload as object), seed: 1 } } : a,
    );
    expect(suiteEpoch(edited)).not.toBe(suiteEpoch(corpus));
  });

  it("moves when an artifact is added, and when one is removed", () => {
    const corpus = smokeSet();
    expect(suiteEpoch([...corpus, { ...one, claimHash: "smoke-9999" }])).not.toBe(suiteEpoch(corpus));
    expect(suiteEpoch(corpus.slice(0, -1))).not.toBe(suiteEpoch(corpus));
  });

  it("separates two suites, so a row cannot be relabelled across them", () => {
    expect(suiteEpoch(injectionSuite())).not.toBe(suiteEpoch(smokeSet()));
    expect(suiteEpoch(allSuites())).not.toBe(suiteEpoch(smokeSet()));
  });

  /**
   * An omitted band and an explicit `"normal"` are the same artifact. The default is a
   * normalization, not a difference: without it, adding `thresholdBand: "normal"` to a generator
   * that had been leaving it off would churn every cached verdict for an exam that did not change.
   */
  it("treats an absent thresholdBand as normal, and boundary as different", () => {
    const { thresholdBand: _omitted, ...bare } = one;
    expect(suiteEpoch([bare as Artifact])).toBe(suiteEpoch([one]));
    expect(suiteEpoch([{ ...one, thresholdBand: "boundary" }])).not.toBe(suiteEpoch([one]));
  });

  /**
   * An empty corpus still has an identity. `""` would read as an absent value rather than as the
   * digest of nothing, and the display rule in this repo is that unknown renders `—`, never `0`.
   */
  it("digests an empty corpus to a real hash rather than to an empty string", () => {
    const empty = suiteEpoch([]);
    expect(empty).toMatch(/^[0-9a-f]{64}$/);
    expect(empty).not.toBe(suiteEpoch([one]));
  });
});

/**
 * The suite that used to be a loop.
 *
 * `calibrationSuite` generated sixty artifacts with `expectedVerdict = i % 2 === 0 ? PASS : VOID`
 * over a payload of `{ kind, index, difficulty }` — a label no content determines, which makes every
 * accuracy and kappa number computed from it a measurement of the generator. These four checks exist
 * so that shape cannot come back unnoticed: the first two are what a revert to `i % 2` trips, the
 * third is what a probe with nothing in it trips, and the fourth is what a relabelled artifact
 * keeping an index-shaped `claimHash` would trip — the eval cache keys on `claimHash`, so that
 * combination is answered from the verdict recorded against the old exam.
 */
describe("calibrationSuite", () => {
  const suite = calibrationSuite();
  const labels = suite.map((a) => a.expectedVerdict);

  it("reaches all three verdicts, because the axis it teaches is FAIL versus VOID", () => {
    expect(new Set(labels)).toEqual(new Set(["PASS", "VOID", "FAIL"]));
    // Absence of evidence has to outnumber certainty about evidence, or the suite teaches
    // "guess confidently" with a different label on it.
    expect(labels.filter((l) => l === "VOID").length).toBeGreaterThanOrEqual(
      labels.filter((l) => l === "PASS").length,
    );
  });

  it("is not a function of the index, at any period a loop would produce", () => {
    for (const p of [1, 2, 3]) {
      expect(
        labels.every((l, i) => l === labels[i % p]),
        `the labels repeat with period ${p}, which is a generator talking to itself`,
      ).toBe(false);
    }
    expect(labels.every((l, i) => l === (i % 2 === 0 ? "PASS" : "VOID"))).toBe(false);
  });

  it("hands every probe the text a grader has to judge", () => {
    for (const a of suite) {
      const p = a.payload as { claim?: string; evidence?: string | null };
      expect(typeof p.claim, `${a.claimHash} has no claim to grade`).toBe("string");
      expect((p.claim ?? "").length).toBeGreaterThan(10);
      // `null` is a real value here, not a missing one: "nothing was shown" is the probe.
      expect("evidence" in p, `${a.claimHash} omits evidence rather than showing none`).toBe(true);
    }
  });

  it("names its artifacts instead of numbering them", () => {
    const hashes = suite.map((a) => a.claimHash);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const h of hashes) {
      expect(h, `${h} is index-shaped, so a relabelled probe would reuse a cached verdict`).not.toMatch(
        /-\d{4}$/,
      );
    }
  });
});
