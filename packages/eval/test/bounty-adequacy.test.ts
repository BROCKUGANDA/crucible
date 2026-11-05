/**
 * @file bounty-adequacy.test.ts — Bounty adequacy engine tests.
 */

import { describe, it, expect } from "vitest";
import {
  newBountyRecommendation,
  newBountyAdequacyReport,
  calculateBondWei,
  calculateProtocolFeeWei,
  calculateNetAgentPayoutWei,
  computeBountyRecommendation,
  assessBountyAdequacy,
} from "../src/bounty-adequacy.js";
import { FEE_BPS_CANONICAL } from "../src/gates.js";

describe("calculateBondWei", () => {
  it("computes 20% bond rounded up", () => {
    // 1000 * 20 / 100 = 200
    expect(calculateBondWei(1000n)).toBe(200n);
    // 1001 * 20 / 100 = 200.2 -> rounded up to 201
    expect(calculateBondWei(1001n)).toBe(201n);
    // 0 -> 0
    expect(calculateBondWei(0n)).toBe(0n);
  });
});

describe("calculateProtocolFeeWei", () => {
  it("computes 5% fee truncated", () => {
    // 1000 * 500 / 10000 = 50
    expect(calculateProtocolFeeWei(1000n)).toBe(50n);
    // 999 * 500 / 10000 = 49.95 -> truncated to 49
    expect(calculateProtocolFeeWei(999n)).toBe(49n);
  });

  it("matches FEE_BPS_CANONICAL = 500", () => {
    const reward = 1_000_000_000_000_000_000n; // 1 ETH
    const expected = (reward * BigInt(FEE_BPS_CANONICAL)) / 10000n;
    expect(calculateProtocolFeeWei(reward)).toBe(expected);
  });
});

describe("calculateNetAgentPayoutWei", () => {
  it("subtracts fee from reward", () => {
    const reward = 1000n;
    const fee = calculateProtocolFeeWei(reward);
    expect(calculateNetAgentPayoutWei(reward)).toBe(reward - fee);
  });
});

describe("computeBountyRecommendation", () => {
  it("computes recommendation from inputs", () => {
    const rec = computeBountyRecommendation("trial-1", "ETH", "31337", {
      executionCost: 100n,
      specialistEffortValue: 200n,
      complexityPremium: 50n,
      riskPremium: 30n,
      scarcityPremium: 20n,
      protocolFloor: 10n,
      modelConfidence: 0.8,
      calibrationDataDate: Date.now(),
      reason: "Test recommendation.",
    });

    expect(rec.trialId).toBe("trial-1");
    expect(rec.nativeAsset).toBe("ETH");
    expect(rec.network).toBe("31337");
    // sum = 100+200+50+30+20 = 400, floor = 10, so competitive = 400
    expect(rec.competitiveBounty).toBe(400n);
    expect(rec.minimumRecommended).toBe(10n);
    // premium = 400 + 25% = 500
    expect(rec.premiumBounty).toBe(500n);
    // bond = 20% of 400 = 80
    expect(rec.requiredBondWei).toBe(80n);
    // max at risk = 400 + 80 = 480
    expect(rec.maxAmountAtRiskWei).toBe(480n);
    // net payout = 400 - 5% fee (20) = 380
    expect(rec.expectedNetAgentPayoutWei).toBe(380n);
    // protocol fee = 20
    expect(rec.protocolFeeWei).toBe(20n);
    expect(rec.modelConfidence).toBe(0.8);
    expect(rec.reason).toBe("Test recommendation.");
  });

  it("uses protocol floor when sum is below it", () => {
    const rec = computeBountyRecommendation("trial-1", "ETH", "31337", {
      executionCost: 0n,
      specialistEffortValue: 0n,
      complexityPremium: 0n,
      riskPremium: 0n,
      scarcityPremium: 0n,
      protocolFloor: 500n,
      modelConfidence: 1.0,
      calibrationDataDate: null,
      reason: "Floor only.",
    });
    expect(rec.competitiveBounty).toBe(500n);
    expect(rec.minimumRecommended).toBe(500n);
  });
});

describe("assessBountyAdequacy", () => {
  it("declares inadequate when below floor", () => {
    const proposal = newBountyRecommendation("trial-1", "ETH", "31337");
    proposal.protocolFloor = 100n;
    proposal.competitiveBounty = 200n;
    const report = assessBountyAdequacy("trial-1", proposal, 50n);
    expect(report.isAdequate).toBe(false);
    expect(report.adequacyReason).toContain("below protocol floor");
    expect(report.suggestions.length).toBeGreaterThan(0);
  });

  it("declares inadequate when below competitive", () => {
    const proposal = newBountyRecommendation("trial-1", "ETH", "31337");
    proposal.protocolFloor = 10n;
    proposal.competitiveBounty = 200n;
    const report = assessBountyAdequacy("trial-1", proposal, 150n);
    expect(report.isAdequate).toBe(false);
    expect(report.adequacyReason).toContain("below the competitive bounty");
  });

  it("declares adequate when at or above competitive", () => {
    const proposal = newBountyRecommendation("trial-1", "ETH", "31337");
    proposal.protocolFloor = 10n;
    proposal.competitiveBounty = 200n;
    const report = assessBountyAdequacy("trial-1", proposal, 200n);
    expect(report.isAdequate).toBe(true);
    expect(report.adequacyReason).toContain("meets or exceeds");
  });

  it("handles no proposed reward", () => {
    const proposal = newBountyRecommendation("trial-1", "ETH", "31337");
    const report = assessBountyAdequacy("trial-1", proposal, null);
    expect(report.isAdequate).toBe(false);
    expect(report.adequacyReason).toContain("No sponsor reward proposed");
  });
});

describe("newBountyAdequacyReport", () => {
  it("creates an empty report", () => {
    const r = newBountyAdequacyReport("trial-1");
    expect(r.trialId).toBe("trial-1");
    expect(r.isAdequate).toBe(false);
    expect(r.sponsorProposedRewardWei).toBeNull();
  });
});