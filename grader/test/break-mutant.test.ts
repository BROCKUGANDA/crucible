import { describe, expect, it } from "vitest";
import {
  FrontierBreakGenerator,
  BreakMutant,
  scoreBreakMutants,
  breakDisqualified,
  BreakResult,
  mutantFalsePassRate,
} from "../src/eval/break-mutant.js";
import { StubModelAdapter } from "../src/eval/adapters/stub.js";
import type { Artifact, ModelVerdict, Verdict } from "../src/eval/types.js";

const PASS: Verdict = "PASS";
const VOID: Verdict = "VOID";
const FAIL: Verdict = "FAIL";

function artifact(claimHash: string): Artifact {
  return {
    claimHash,
    payload: { kind: "run-artifact", index: 1, ok: true },
    expectedVerdict: PASS,
    suite: "smoke",
    thresholdBand: "normal",
  };
}

describe("FrontierBreakGenerator (gate 427)", () => {
  it("generates three break mutants per artifact via the attacker model", async () => {
    const attacker = new StubModelAdapter("break-attacker-v1");
    const gen = new FrontierBreakGenerator();
    const art = artifact("claim-1");

    const mutants = await gen.generate(art, attacker);

    expect(mutants.length).toBe(3);
    for (const m of mutants) {
      expect(m.parentClaimHash).toBe("claim-1");
      expect(["VOID", "FAIL"]).toContain(m.expectedVerdict);
      expect(["near-miss", "plausible-wrong", "spec-deviation"]).toContain(m.breakType);
      expect(typeof m.description).toBe("string");
      expect(m.description.length).toBeGreaterThan(0);
    }
  });

  it("gives each mutant a distinct claimHash", async () => {
    const attacker = new StubModelAdapter("break-attacker-v1");
    const gen = new FrontierBreakGenerator();
    const art = artifact("claim-1");

    const mutants = await gen.generate(art, attacker);
    const hashes = mutants.map((m) => m.claimHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe("scoreBreakMutants", () => {
  const mutants: BreakMutant[] = [
    { claimHash: "m1", parentClaimHash: "p1", payload: {}, expectedVerdict: VOID, breakType: "near-miss", description: "d1" },
    { claimHash: "m2", parentClaimHash: "p1", payload: {}, expectedVerdict: FAIL, breakType: "plausible-wrong", description: "d2" },
    { claimHash: "m3", parentClaimHash: "p1", payload: {}, expectedVerdict: VOID, breakType: "spec-deviation", description: "d3" },
  ];

  it("computes kill rate: candidate that rejects all mutants scores 1", () => {
    const results: BreakResult[] = [
      { claimHash: "m1", modelId: "A", mutant: mutants[0], actual: VOID, confidence: 0.9, killed: true },
      { claimHash: "m2", modelId: "A", mutant: mutants[1], actual: FAIL, confidence: 0.8, killed: true },
      { claimHash: "m3", modelId: "A", mutant: mutants[2], actual: VOID, confidence: 0.85, killed: true },
    ];
    const out = scoreBreakMutants(mutants, results);
    expect(out.length).toBe(1);
    expect(out[0].modelId).toBe("A");
    expect(out[0].killRate).toBe(1);
    expect(out[0].n).toBe(3);
    expect(out[0].failed).toEqual([]);
  });

  it("computes kill rate: candidate that falsely passes one mutant scores 2/3", () => {
    const results: BreakResult[] = [
      { claimHash: "m1", modelId: "B", mutant: mutants[0], actual: PASS, confidence: 0.9, killed: false },
      { claimHash: "m2", modelId: "B", mutant: mutants[1], actual: FAIL, confidence: 0.8, killed: true },
      { claimHash: "m3", modelId: "B", mutant: mutants[2], actual: VOID, confidence: 0.85, killed: true },
    ];
    const out = scoreBreakMutants(mutants, results);
    expect(out[0].killRate).toBeCloseTo(2 / 3, 6);
    expect(out[0].failed).toEqual(["m1"]);
  });

  it("returns empty when no results", () => {
    expect(scoreBreakMutants(mutants, [])).toEqual([]);
  });

  it("ignores results whose claimHash is not a known mutant", () => {
    const results: BreakResult[] = [
      { claimHash: "unknown", modelId: "A", mutant: mutants[0], actual: VOID, confidence: 0.9, killed: true },
    ];
    expect(scoreBreakMutants(mutants, results)).toEqual([]);
  });
});

describe("breakDisqualified", () => {
  it("disqualifies below 90%", () => {
    expect(breakDisqualified(0.89)).toBe(true);
    expect(breakDisqualified(0.9)).toBe(false);
    expect(breakDisqualified(1.0)).toBe(false);
  });
});

describe("mutantFalsePassRate", () => {
  const mutants: BreakMutant[] = [
    { claimHash: "m1", parentClaimHash: "p1", payload: {}, expectedVerdict: VOID, breakType: "near-miss", description: "d1" },
    { claimHash: "m2", parentClaimHash: "p1", payload: {}, expectedVerdict: FAIL, breakType: "plausible-wrong", description: "d2" },
  ];

  it("counts false passes on broken mutants only", () => {
    const results: BreakResult[] = [
      { claimHash: "m1", modelId: "A", mutant: mutants[0], actual: PASS, confidence: 0.9, killed: false },
      { claimHash: "m2", modelId: "A", mutant: mutants[1], actual: VOID, confidence: 0.8, killed: true },
    ];
    expect(mutantFalsePassRate(results)).toBeCloseTo(0.5, 6);
  });

  it("returns 0 when no broken-mutant results", () => {
    expect(mutantFalsePassRate([])).toBe(0);
  });
});
