/**
 * @file difficulty-profile.test.ts — Adaptive difficulty engine tests.
 */

import { describe, it, expect } from "vitest";
import {
  newTrialDifficultyProfile,
  emptyDifficultyDimensions,
  newAgentTrialFit,
  irtPassProbability,
  estimateDifficultyFromOutcomes,
  classifyHeat,
  computeAgentFit,
} from "../src/difficulty-profile.js";
import { defaultRating, conservative } from "../src/ratings.js";

describe("emptyDifficultyDimensions", () => {
  it("returns all dimensions as null", () => {
    const d = emptyDifficultyDimensions();
    expect(d.scores).toHaveLength(8);
    for (const s of d.scores) {
      expect(s.value).toBeNull();
      expect(s.confidence).toBeNull();
      expect(s.basis).toBe("provisional");
    }
    expect(d.composite).toBeNull();
  });
});

describe("newTrialDifficultyProfile", () => {
  it("creates a provisional profile", () => {
    const p = newTrialDifficultyProfile("trial-1", "finance");
    expect(p.trialId).toBe("trial-1");
    expect(p.domain).toBe("finance");
    expect(p.calibrationStatus).toBe("provisional");
    expect(p.estimatedDifficulty).toBeNull();
    expect(p.sampleSize).toBe(0);
    expect(p.dimensions.composite).toBeNull();
  });

  it("throws on missing trialId or domain", () => {
    expect(() => newTrialDifficultyProfile("", "finance")).toThrow();
    expect(() => newTrialDifficultyProfile("trial-1", "")).toThrow();
  });
});

describe("irtPassProbability", () => {
  it("returns 0.5 when ability equals difficulty", () => {
    expect(irtPassProbability(0, 0)).toBeCloseTo(0.5, 4);
  });

  it("returns higher probability for higher ability", () => {
    expect(irtPassProbability(1, 0)).toBeGreaterThan(irtPassProbability(0, 0));
  });

  it("returns lower probability for higher difficulty", () => {
    expect(irtPassProbability(0, 1)).toBeLessThan(irtPassProbability(0, 0));
  });

  it("is bounded between 0 and 1", () => {
    for (let theta = -10; theta <= 10; theta += 1) {
      for (let b = -10; b <= 10; b += 1) {
        const p = irtPassProbability(theta, b);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("estimateDifficultyFromOutcomes", () => {
  it("returns null for insufficient data", () => {
    const r = estimateDifficultyFromOutcomes([0.5, 0.6], [true, false], 20);
    expect(r.difficulty).toBeNull();
    expect(r.confidence).toBeNull();
    expect(r.sampleSize).toBe(2);
  });

  it("estimates difficulty with sufficient data", () => {
    // Mixed outcomes: 6 pass, 2 fail out of 8 with ability 0.5 -> passRate 0.75
    const abilities = Array(8).fill(0.5);
    const outcomes = [true, true, true, true, true, true, false, false];
    const r = estimateDifficultyFromOutcomes(abilities, outcomes, 5);
    expect(r.difficulty).not.toBeNull();
    expect(r.sampleSize).toBe(8);
    expect(r.confidence).not.toBeNull();
    // passRate 0.75 > 0.5, so difficulty > mean ability
    expect(r.difficulty).toBeGreaterThan(0.5);
  });

  it("returns null when all pass or all fail (can't invert)", () => {
    const r1 = estimateDifficultyFromOutcomes([0.5, 0.5, 0.5, 0.5, 0.5], [true, true, true, true, true], 5);
    expect(r1.difficulty).toBeNull();
    const r2 = estimateDifficultyFromOutcomes([0.5, 0.5, 0.5, 0.5, 0.5], [false, false, false, false, false], 5);
    expect(r2.difficulty).toBeNull();
  });
});

describe("classifyHeat", () => {
  it("classifies kindling for high completion", () => {
    const p = newTrialDifficultyProfile("trial-1", "finance");
    p.estimatedDifficulty = 0.1;
    p.sampleSize = 50;
    const c = classifyHeat(p);
    expect(c.heat).toBe("kindling");
  });

  it("classifies masterwork for very low completion", () => {
    const p = newTrialDifficultyProfile("trial-1", "finance");
    p.estimatedDifficulty = 0.9;
    p.sampleSize = 50;
    const c = classifyHeat(p);
    expect(c.heat).toBe("masterwork");
  });

  it("marks provisional with small sample", () => {
    const p = newTrialDifficultyProfile("trial-1", "finance");
    p.estimatedDifficulty = 0.5;
    p.sampleSize = 5;
    const c = classifyHeat(p);
    expect(c.provisional).toBe(true);
    expect(c.rationale.some((r) => r.includes("Small sample"))).toBe(true);
  });

  it("returns kindling with no data", () => {
    const p = newTrialDifficultyProfile("trial-1", "finance");
    const c = classifyHeat(p);
    expect(c.heat).toBe("kindling");
    expect(c.provisional).toBe(true);
  });
});

describe("computeAgentFit", () => {
  it("returns uncalibrated for no rating", () => {
    const p = newTrialDifficultyProfile("trial-1", "finance");
    p.estimatedDifficulty = 0.5;
    const fit = computeAgentFit(null, p);
    expect(fit.fitBucket).toBe("uncalibrated");
    expect(fit.sufficientEvidence).toBe(false);
  });

  it("classifies high ability as suitable or under_challenging", () => {
    const p = newTrialDifficultyProfile("trial-1", "finance");
    p.estimatedDifficulty = 0.1; // easy task
    const rating = defaultRating();
    rating.mu = 100; // very high ability
    rating.sigma = 1;
    const fit = computeAgentFit(rating, p);
    expect(["suitable", "under_challenging"]).toContain(fit.fitBucket);
    expect(fit.predictedSuccessProbability).toBeGreaterThan(0.7);
  });

  it("classifies low ability as specialist or uncalibrated", () => {
    const p = newTrialDifficultyProfile("trial-1", "finance");
    p.estimatedDifficulty = 0.9; // very hard task
    const rating = defaultRating();
    rating.mu = 0;
    rating.sigma = 1;
    const fit = computeAgentFit(rating, p);
    expect(["specialist", "uncalibrated"]).toContain(fit.fitBucket);
  });

  it("returns null probability when difficulty is null", () => {
    const p = newTrialDifficultyProfile("trial-1", "finance");
    const rating = defaultRating();
    const fit = computeAgentFit(rating, p);
    expect(fit.predictedSuccessProbability).toBeNull();
  });
});