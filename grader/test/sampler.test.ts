import { describe, expect, it } from "vitest";
import {
  ANCHOR_SHARE_BPS,
  DrawError,
  SAFETY_SHARE_BPS,
  anchorFloorFor,
  drawSuite,
  hashOfDraw,
  seedCommitment,
  verifyDraw,
} from "../src/eval/sampler.js";
import {
  allSuites,
  calibrationSuite,
  canonicalizationVectors,
  injectionSuite,
  isAnchor,
  smokeSet,
  suiteEpoch,
} from "../src/eval/suites.js";
import type { Artifact } from "../src/eval/types.js";

/**
 * The sampler is the part of a trial that says *which* probes it ran, so every check below is about
 * a property a stranger can test: that the draw follows from the seed and the corpus and from
 * nothing else, that the seed could not have been re-rolled, and that two different draws still
 * measure a comparable thing.
 *
 * The corpora are taken from the builders. Nothing here states how many artifacts are in a tier, a
 * stratum or the anchor set — the floor and the mixing share are asserted against their own
 * arithmetic, with the bps written out as a decimal so a changed constant has to be argued with a
 * changed test.
 */

/** The visible version of the graded corpus: 5 persuasion probes + 15 content-decided items. */
const graded = (): Artifact[] => [...injectionSuite(), ...canonicalizationVectors(), ...calibrationSuite()];

const SEEDS = ["trial-0001", "trial-0002", "trial-0007", "0", "agent-42/stake", "🎲-seed"];

const sig = (drawn: readonly Artifact[]): string => drawn.map((a) => a.claimHash).join("|");

describe("seeded draws are reproducible", () => {
  it("is byte-identical across two independent generations of the same corpus and seed", () => {
    const a = drawSuite(allSuites(), "trial-0001", { size: 20 });
    const b = drawSuite(allSuites(), "trial-0001", { size: 20 });
    expect(sig(b.artifacts)).toBe(sig(a.artifacts));
    expect(b.drawHash).toBe(a.drawHash);
    expect(b.corpusEpoch).toBe(a.corpusEpoch);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  /**
   * The property `Math.random()` cannot survive, and the one a pick taken from the array's own order
   * would also survive: the draw is a function of the seed and the corpus, so the order the corpus
   * happened to be built in is not part of it. `suiteEpoch` sorts; this sorts the *selection*.
   */
  it("is the same draw from a corpus handed over in a different order", () => {
    const corpus = allSuites();
    const forward = drawSuite(corpus, "trial-0002", { size: 34 });
    const backward = drawSuite([...corpus].reverse(), "trial-0002", { size: 34 });
    expect(sig(backward.artifacts)).toBe(sig(forward.artifacts));
    expect(backward.drawHash).toBe(forward.drawHash);
  });

  /** The trap the seed is there to close: a subset cut from the front of the array is not a sample. */
  it("is not a prefix of the corpus", () => {
    const corpus = allSuites();
    const draw = drawSuite(corpus, "trial-0007", { size: 20 });
    expect(sig(draw.artifacts)).not.toBe(sig(corpus.slice(0, 20)));
    expect(draw.artifacts.slice(0, 3).map((a) => a.claimHash)).not.toEqual(
      corpus.slice(0, 3).map((a) => a.claimHash),
    );
  });

  it("changes the draw when the seed changes", () => {
    const corpus = allSuites();
    const draws = SEEDS.map((seed) => sig(drawSuite(corpus, seed, { size: 40 }).artifacts));
    expect(new Set(draws).size, "six seeds, one draw — the seed is not reaching the derivation").toBeGreaterThan(1);
    expect(draws[0]).not.toBe(draws[1]);
  });

  /**
   * Same seed, different exam. The epoch is in every ordering key, so a corpus that moved — by a
   * byte, a label or a tier — moves the draw instead of silently reusing the old one.
   */
  it("changes the draw when the corpus epoch moves", () => {
    const corpus = calibrationSuite();
    const before = drawSuite(corpus, "trial-0001", { size: 4 });
    const relabelled = corpus.map((a, i) => (i === 0 ? { ...a, expectedVerdict: "PASS" as const } : a));
    const after = drawSuite(relabelled, "trial-0001", { size: 4 });
    expect(after.corpusEpoch).not.toBe(before.corpusEpoch);
    expect(after.drawHash).not.toBe(before.drawHash);

    const retiered = corpus.map((a, i) => (i === 0 ? { ...a, tier: "competence" as const } : a));
    expect(suiteEpoch(retiered)).not.toBe(suiteEpoch(corpus));
    expect(drawSuite(retiered, "trial-0001", { size: 4 }).drawHash).not.toBe(before.drawHash);
  });

  it("re-derives from the reveal alone, which is what the commitment was for", () => {
    const corpus = allSuites();
    const receipt = drawSuite(corpus, "trial-0042", { size: 21 });
    // A stranger holds: the seed, the corpus, the receipt. Nothing else, and no process state.
    const cold = drawSuite(allSuites(), receipt.seed, { size: receipt.sizeRequested });
    expect(verifyDraw(receipt, corpus).ok).toBe(true);
    expect(verifyDraw(cold, corpus).ok).toBe(true);
    expect(cold.drawHash).toBe(receipt.drawHash);
  });
});

describe("the seed is committed, and never defaulted", () => {
  it("refuses an absent seed rather than picking one", () => {
    const corpus = graded();
    for (const bad of ["", "   ", "\n", undefined, null, 42, {}]) {
      expect(
        () => drawSuite(corpus, bad as unknown as string, { size: 4 }),
        `a draw from seed ${JSON.stringify(bad)} cannot be re-derived by anyone`,
      ).toThrow(DrawError);
      expect(() => drawSuite(corpus, bad as unknown as string, { size: 4 })).toThrow(/MISSING_SEED/);
    }
  });

  it("commits H(seed) — a digest, one-way, and not the seed", () => {
    const seed = "trial-0001";
    const commitment = seedCommitment(seed);
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(commitment).not.toContain(seed);
    expect(seedCommitment(seed)).toBe(commitment);
    expect(seedCommitment(`${seed}x`)).not.toBe(commitment);
    expect(drawSuite(graded(), seed, { size: 5 }).seedCommitment).toBe(commitment);
  });

  it("binds the commitment into the receipt so a reveal can be checked against it", () => {
    const receipt = drawSuite(graded(), "trial-0002", { size: 5 });
    const tampered = { ...receipt, seed: "trial-9999" };
    const checked = verifyDraw(tampered, graded());
    expect(checked.ok).toBe(false);
    expect(checked.mismatches.join("\n")).toContain("SEED_COMMITMENT");
  });

  /**
   * The other four ways a receipt can be wrong, named separately.
   *
   * A verifier that answered only "no" could not tell a re-rolled subset from a swapped corpus from
   * a truncated draw, and the difference is the whole question: one of those is dishonesty about the
   * draw, one is dishonesty about the exam, and one is a bug in the verifier's own copy.
   */
  it("names what failed: swapped corpus, reordered draw, substituted probe, unusable receipt", () => {
    const corpus = graded();
    const receipt = drawSuite(corpus, "trial-0007", { size: 8 });

    const wrongCorpus = verifyDraw(receipt, corpus.map((a, i) => (i === 0 ? { ...a, expectedVerdict: "PASS" as const } : a)));
    expect(wrongCorpus.ok).toBe(false);
    expect(wrongCorpus.mismatches.join("\n")).toContain("CORPUS_EPOCH");

    // A reordered list with an honest `drawHash` still beside it is internally inconsistent, and is
    // not what the seed derives: both checks fire, and they are two checks because a tamperer can
    // edit one of the two fields and not the other.
    const reordered = verifyDraw({ ...receipt, artifacts: [...receipt.artifacts].reverse() }, corpus);
    expect(reordered.ok).toBe(false);
    expect(reordered.mismatches.join("\n")).toContain("DRAW_HASH");
    expect(reordered.mismatches.join("\n")).toContain("DRAW_ORDER");

    const swapped = [...receipt.artifacts];
    const outside = corpus.find((a) => !receipt.artifacts.some((d) => d.claimHash === a.claimHash))!;
    swapped[0] = outside;
    const substituted = verifyDraw({ ...receipt, artifacts: swapped }, corpus);
    expect(substituted.ok).toBe(false);
    expect(substituted.mismatches.join("\n")).toContain("DRAW_HASH");

    // A fabricated list whose own hash was recomputed passes the internal check and cannot pass the
    // one that re-derives from the reveal.
    const selfConsistentLie = {
      ...receipt,
      artifacts: swapped,
      drawHash: hashOfDraw(swapped, receipt.seedCommitment, receipt.corpusEpoch),
    };
    const lie = verifyDraw(selfConsistentLie, corpus);
    expect(lie.ok).toBe(false);
    expect(lie.mismatches.join("\n")).not.toContain("DRAW_HASH");
    expect(lie.mismatches.join("\n")).toContain("DRAW_DERIVED");

    const unusable = verifyDraw({ ...receipt, sizeRequested: 0 }, corpus);
    expect(unusable.ok).toBe(false);
    expect(unusable.mismatches.join("\n")).toContain("DRAW_REFUSED");
  });

  it("never throws at a verifier, however broken the receipt is", () => {
    const corpus = graded();
    const receipt = drawSuite(corpus, "trial-0007", { size: 8 });
    for (const bad of [{ ...receipt, seed: "" }, { ...receipt, seed: undefined as unknown as string }]) {
      expect(() => verifyDraw(bad, corpus)).not.toThrow();
      expect(verifyDraw(bad, corpus).ok).toBe(false);
    }
    expect(() => verifyDraw(receipt, [])).not.toThrow();
    expect(verifyDraw(receipt, []).mismatches.join(" ")).toContain("DRAW_REFUSED");
  });
});

/**
 * The anchor floor, at every draw size.
 *
 * Without it two seeded draws of the same size could be disjoint, and both could score near chance
 * for reasons that are about the subset rather than the model. The floor is what makes "different
 * probes each trial" compatible with "the trials are still comparable".
 */
describe("the anchor floor holds at every draw size", () => {
  const corpus = allSuites();
  const anchorPool = corpus.filter(isAnchor);

  it("is a named budget, not a magic number", () => {
    expect(ANCHOR_SHARE_BPS).toBe(2500);
    expect(SAFETY_SHARE_BPS).toBe(1000);
    // The floor is the budget rounded *up*: a floor you may undershoot is not a floor.
    expect(anchorFloorFor(9, corpus.filter((a) => a.safety !== true))).toBe(3);
    expect(anchorFloorFor(4, anchorPool)).toBe(1);
    expect(anchorFloorFor(0, anchorPool)).toBe(0);
    // and it can never promise more than the set holds.
    expect(anchorFloorFor(1000, anchorPool)).toBe(anchorPool.length);
  });

  it("clears it for every draw size the corpus can answer", () => {
    for (const size of [1, 2, 3, 5, 8, 13, 20, 21, 34, 55, 89, 144, 233, corpus.length]) {
      for (const seed of ["trial-0001", "trial-0002", "trial-0007"]) {
        const draw = drawSuite(corpus, seed, { size });
        const safetyInDraw = draw.artifacts.filter((a) => a.safety === true).length;
        const capabilityCount = draw.size - safetyInDraw;
        const expected = Math.min(
          anchorPool.length,
          Math.ceil((capabilityCount * 2500) / 10000),
        );
        expect(draw.anchors.length, `size ${size} seed ${seed}: ${draw.anchors.length} anchors, floor ${expected}`).toBeGreaterThanOrEqual(
          expected,
        );
        expect(draw.anchorFloor).toBe(expected);
        // Every claimed anchor really is one, and is in the draw.
        const inDraw = new Set(draw.artifacts.map((a) => a.claimHash));
        for (const h of draw.anchors) {
          expect(inDraw.has(h), `${h} reported as an anchor but not drawn`).toBe(true);
          expect(anchorPool.some((a) => a.claimHash === h)).toBe(true);
        }
        // The receipt's own accounting adds up.
        expect(draw.artifacts.length).toBe(draw.size);
        expect(draw.safety).toHaveLength(safetyInDraw);
      }
    }
  });

  /**
   * The floor has teeth: a proportional cut across `allSuites` would take no anchors at all at
   * these sizes, because 325 of the 340 capability artifacts are index-labelled filler. If the
   * swap were removed, this row is the one that goes red.
   */
  it("takes anchors a purely proportional cut would have missed", () => {
    const draw = drawSuite(corpus, "trial-0001", { size: 20 });
    expect(draw.anchors.length).toBeGreaterThanOrEqual(Math.ceil(18 * 0.25));
    expect(new Set(draw.anchors).size).toBe(draw.anchors.length);
  });

  /** An exhaustive draw is not a sample: the budget must not shrink the set it is drawing. */
  it("returns the whole corpus when asked for the whole corpus", () => {
    const corpus = graded();
    const draw = drawSuite(corpus, "trial-0001", { size: corpus.length });
    expect(draw.size).toBe(corpus.length);
    expect(draw.artifacts.map((a) => a.claimHash).sort()).toEqual(corpus.map((a) => a.claimHash).sort());
    expect(draw.safety).toHaveLength(injectionSuite().length);
  });

  it("refuses a size that is not a positive integer, and clamps one that is merely too large", () => {
    const corpus = graded();
    for (const bad of [0, -1, 2.5, NaN]) {
      expect(() => drawSuite(corpus, "trial-0001", { size: bad })).toThrow(/BAD_SIZE/);
    }
    const clamped = drawSuite(corpus, "trial-0001", { size: corpus.length + 500 });
    expect(clamped.size).toBe(corpus.length);
    expect(clamped.sizeRequested).toBe(corpus.length + 500);
  });
});

/**
 * Mixing, not appending.
 *
 * A model can see two things: the payload, and the order the probes arrive in. `openai-compat.ts:36`
 * sends `artifact.payload` and nothing else, so the labels never reach it — which is why the sampler
 * must also not make the safety probes readable from *where they sit*.
 */
describe("safety probes are mixed into the draw", () => {
  const corpus = allSuites();

  it("does not park the whole safety set at the end of the draw", () => {
    const tailOnly = SEEDS.map((seed) => {
      const draw = drawSuite(corpus, seed, { size: 20 });
      const positions = draw.safety.map((h) => draw.artifacts.findIndex((a) => a.claimHash === h));
      const last = draw.artifacts.length - draw.safety.length;
      return positions.every((p) => p >= last);
    });
    expect(
      tailOnly.every(Boolean),
      "every seed puts the persuasion probes in the same tail — that is an appended suite, not a mix",
    ).toBe(false);
  });

  it("keeps the safety probes out of the capability strata it did not draw from", () => {
    const draw = drawSuite(corpus, "trial-0002", { size: 40 });
    expect(draw.safety.length).toBeGreaterThan(0);
    const capability = draw.artifacts.filter((a) => a.safety !== true);
    expect(capability.length + draw.safety.length).toBe(draw.size);
    // The strata counts are a partition of the capability items, never of the whole draw.
    expect(draw.strata.reduce((s, c) => s + c.drawn, 0)).toBe(capability.length);
    for (const cell of draw.strata) {
      expect(cell.drawn).toBeLessThanOrEqual(cell.available);
      expect(capability.filter((a) => a.tier === cell.tier && a.difficulty === cell.difficulty).length).toBe(cell.drawn);
    }
  });

  it("budgets the mixing share without ever exceeding the pool", () => {
    for (const size of [5, 10, 11, 19, 20, 60, 100]) {
      const draw = drawSuite(corpus, "trial-0007", { size });
      const expected = Math.min(
        injectionSuite().length,
        Math.floor((Math.min(size, corpus.length) * 1000) / 10000),
      );
      expect(draw.safety.length, `size ${size}`).toBe(expected);
    }
  });

  /**
   * Invisibility, stated as the constraint it actually is: the sampler adds nothing to what the
   * model is shown, and the role lives beside the artifact rather than inside it.
   */
  it("touches no payload and returns the corpus's own objects", () => {
    const corpusA = allSuites();
    const draw = drawSuite(corpusA, "trial-0042", { size: 30 });
    for (const a of draw.artifacts) {
      const original = corpusA.find((c) => c.claimHash === a.claimHash)!;
      expect(a).toBe(original);
      expect(JSON.stringify(a.payload)).toBe(JSON.stringify(original.payload));
    }
  });

  it("takes the safety pool from the corpus by default and from an option when told to", () => {
    const capability = allSuites().filter((a) => a.safety !== true);
    const probes = injectionSuite();
    const explicit = drawSuite(capability, "trial-0001", { size: 20, safetyPool: probes });
    expect(explicit.safety).toHaveLength(Math.min(probes.length, Math.floor((20 * 1000) / 10000)));
    for (const h of explicit.safety) expect(probes.some((p) => p.claimHash === h)).toBe(true);
    // The overridden pool is mixed in and nothing else: every probe that appears in the draw appears
    // *as* a safety item, so a probe supplied through this option cannot be counted as a capability
    // item by accident.
    const fromPool = explicit.artifacts.filter((a) => probes.some((p) => p.claimHash === a.claimHash));
    expect(fromPool).toHaveLength(explicit.safety.length);
    expect(explicit.strata.reduce((s, c) => s + c.drawn, 0)).toBe(explicit.size - explicit.safety.length);
  });
});

describe("the corpus it draws from has to be a corpus", () => {
  it("refuses an empty corpus and a duplicated claimHash", () => {
    expect(() => drawSuite([], "trial-0001")).toThrow(DrawError);
    expect(() => drawSuite([], "trial-0001")).toThrow(/EMPTY_CORPUS/);
    const dup = [smokeSet()[0]!, smokeSet()[0]!];
    expect(() => drawSuite(dup, "trial-0001", { size: 2 })).toThrow(/DUP_CLAIM_HASH/);
  });

  it("refuses an artifact that does not say what it tests", () => {
    const { tier: _gone, ...untiered } = smokeSet()[0]!;
    expect(() => drawSuite([untiered as unknown as Artifact], "trial-0001", { size: 1 })).toThrow(/BAD_TIER/);
    const { difficulty: _gone2, ...undeep } = smokeSet()[0]!;
    expect(() => drawSuite([undeep as unknown as Artifact], "trial-0001", { size: 1 })).toThrow(/BAD_DIFFICULTY/);
    expect(() =>
      drawSuite([{ ...smokeSet()[0]!, tier: "superhuman" as unknown as Artifact["tier"] }], "trial-0001", { size: 1 }),
    ).toThrow(/BAD_TIER/);
  });
});
