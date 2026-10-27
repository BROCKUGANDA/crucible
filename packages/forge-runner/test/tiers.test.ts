import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX } from "../src/sandbox.js";
import {
  TIER_STRICTNESS,
  mayEarnAtTier,
  strictSandboxFor,
  tierOfSuite,
  type FrontierAxes,
} from "../src/tiers.js";

const axes = (over: Partial<FrontierAxes> = {}): FrontierAxes => ({
  horizon: 0,
  transfer: 0,
  novelty: 0,
  composition: 0,
  perturbation: 0,
  ...over,
});

describe("tierOfSuite (gates 841-842)", () => {
  it("derives the ladder rung from the axis mean", () => {
    expect(tierOfSuite(axes())).toBe(0);
    expect(tierOfSuite(axes({ horizon: 0.3, transfer: 0.3, novelty: 0.3, composition: 0.3, perturbation: 0.3 }))).toBe(1);
    expect(tierOfSuite(axes({ horizon: 0.5, transfer: 0.5, novelty: 0.5, composition: 0.5, perturbation: 0.5 }))).toBe(2);
    expect(tierOfSuite(axes({ horizon: 0.7, transfer: 0.7, novelty: 0.7, composition: 0.7, perturbation: 0.7 }))).toBe(3);
    expect(tierOfSuite(axes({ horizon: 0.95, transfer: 0.9, novelty: 0.9, composition: 0.85, perturbation: 0.9 }))).toBe(4);
  });

  it("a single extreme axis forces at least T3", () => {
    expect(tierOfSuite(axes({ novelty: 0.95 }))).toBe(3);
  });

  it("rejects out-of-range axes instead of guessing a tier", () => {
    expect(() => tierOfSuite(axes({ horizon: 1.5 }))).toThrow(/horizon/);
    expect(() => tierOfSuite(axes({ transfer: -0.1 }))).toThrow(/transfer/);
  });
});

describe("strictSandboxFor", () => {
  it("raises the default spec to the tier floor and names what it raised", () => {
    const { spec, raised } = strictSandboxFor(DEFAULT_SANDBOX, 4);
    expect(spec.timeoutSec).toBe(TIER_STRICTNESS[4].minTimeoutSec);
    expect(spec.memory).toBe("8192m");
    expect(raised).toEqual(expect.arrayContaining(["timeoutSec", "memory"]));
    // Isolation properties are the tier system's to keep, not to trade away.
    expect(spec.allowLocalFallback).toBe(DEFAULT_SANDBOX.allowLocalFallback);
  });

  it("never lowers a spec that already runs stricter", () => {
    const strict = { ...DEFAULT_SANDBOX, timeoutSec: 7200, memory: "16g" };
    const { spec, raised } = strictSandboxFor(strict, 2);
    expect(spec.timeoutSec).toBe(7200);
    expect(spec.memory).toBe("16g");
    expect(raised).toEqual([]);
  });

  it("leaves a T0 run at the default envelope", () => {
    const { spec, raised } = strictSandboxFor(DEFAULT_SANDBOX, 0);
    expect(spec.timeoutSec).toBe(DEFAULT_SANDBOX.timeoutSec);
    expect(raised).toEqual([]);
  });
});

describe("mayEarnAtTier", () => {
  it("pays only at or above the trial's tier", () => {
    expect(mayEarnAtTier(4, 4)).toBe(true);
    expect(mayEarnAtTier(0, 0)).toBe(true);
    expect(mayEarnAtTier(2, 4)).toBe(false);
    expect(mayEarnAtTier(1, 3)).toBe(false);
  });

  it("rejects a nonsense agent tier", () => {
    expect(() => mayEarnAtTier(5, 0)).toThrow(/agent tier/);
    expect(() => mayEarnAtTier(1.5, 0)).toThrow(/agent tier/);
  });
});
