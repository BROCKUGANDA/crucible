import { describe, expect, it } from "vitest";
import { evaluateSponsorship } from "../src/sponsorship-approval.js";

describe("sponsorship approval", () => {
  const baseReq = {
    principal: "p", tenant: "t", chainId: 11155111, target: "0xabc", method: "submit",
    operation: "run", trialState: "judging", idempotencyKey: "k", policyVersion: "v1",
    deadlineMs: Date.now() + 10000, estimatedWei: "1000",
  };
  const baseCtx = {
    now: Date.now(), allowedMethods: new Set(["submit"]), allowedTargets: new Set(["0xabc"]),
    allowedChains: new Set([11155111]), budgetRemainingWei: 10000n, rateLimitOk: true,
    idempotencySeen: false, trialStateAllowed: new Set(["judging"]), policyVersionCurrent: "v1",
    maxPerOpWei: 5000n,
  };

  it("allows a valid request", () => {
    const r = evaluateSponsorship(baseReq, baseCtx);
    expect(r.allowed).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("denies missing principal", () => {
    const r = evaluateSponsorship({ ...baseReq, principal: null }, baseCtx);
    expect(r.allowed).toBe(false);
    expect(r.reasons).toContain("missing principal");
  });

  it("denies expired deadline", () => {
    const r = evaluateSponsorship({ ...baseReq, deadlineMs: Date.now() - 1 }, { ...baseCtx, now: Date.now() });
    expect(r.allowed).toBe(false);
    expect(r.reasons).toContain("expired or missing deadline");
  });

  it("denies over budget", () => {
    const r = evaluateSponsorship({ ...baseReq, estimatedWei: "99999" }, baseCtx);
    expect(r.allowed).toBe(false);
  });

  it("denies idempotency replay", () => {
    const r = evaluateSponsorship(baseReq, { ...baseCtx, idempotencySeen: true });
    expect(r.allowed).toBe(false);
    expect(r.reasons).toContain("idempotency key already used");
  });

  it("fails closed on policy mismatch", () => {
    const r = evaluateSponsorship({ ...baseReq, policyVersion: "v0" }, baseCtx);
    expect(r.allowed).toBe(false);
  });
});
