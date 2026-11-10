import { describe, expect, it } from "vitest";
import { evaluateMainnetReadiness, REQUIRED_GATES } from "../src/mainnet-readiness.js";

describe("mainnet readiness evaluator", () => {
  it("is ready only when every gate is true", () => {
    const gates: Record<string, boolean> = {};
    for (const g of REQUIRED_GATES) gates[g] = true;
    const r = evaluateMainnetReadiness(gates as any);
    expect(r.ready).toBe(true);
    expect(r.passed.length).toBe(REQUIRED_GATES.length);
    expect(r.failed).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it("is not ready when a gate is false", () => {
    const gates: Record<string, boolean> = {};
    for (const g of REQUIRED_GATES) gates[g] = true;
    gates.chainIdCorrect = false;
    const r = evaluateMainnetReadiness(gates as any);
    expect(r.ready).toBe(false);
    expect(r.failed).toContain("chainIdCorrect");
  });

  it("treats unknown (null/undefined) as not-ready", () => {
    const gates: Record<string, boolean | null> = {};
    for (const g of REQUIRED_GATES) gates[g] = true;
    gates.legalAndOperationalApproval = null;
    const r = evaluateMainnetReadiness(gates as any);
    expect(r.ready).toBe(false);
    expect(r.unknown).toContain("legalAndOperationalApproval");
  });

  it("empty gates → nothing ready", () => {
    const r = evaluateMainnetReadiness({});
    expect(r.ready).toBe(false);
    expect(r.unknown.length).toBe(REQUIRED_GATES.length);
  });
});
