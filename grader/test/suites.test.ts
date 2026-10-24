import { describe, expect, it } from "vitest";
import { allSuites, injectionSuite, smokeSet, suiteEpoch } from "../src/eval/suites.js";
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
