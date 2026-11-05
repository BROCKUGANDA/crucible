/**
 * @file bounty-adequacy.ts — Bounty adequacy engine.
 *
 * Helps sponsors offer economically appropriate native ETH/SOL rewards without
 * changing protocol fee constants. The legacy 5% fee (FEE_BPS = 500) and the
 * dormant Arena 15% fee are preserved exactly; this engine only recommends.
 *
 * All amounts are exact integers (wei for ETH, lamports for SOL). No floating
 * point is used for monetary calculations.
 */

import { FEE_BPS_CANONICAL, commissionInBand, applyCaps } from "./gates.js";

/* ------------------------------------------------------------------ */
/* Bounty recommendation                                              */
/* ------------------------------------------------------------------ */

export interface BountyRecommendation {
  version: string;
  trialId: string;
  nativeAsset: "ETH" | "SOL";
  network: string;

  // Recommended range (in base units: wei for ETH, lamports for SOL)
  minimumRecommended: bigint;
  competitiveBounty: bigint;
  premiumBounty: bigint;

  // Model inputs (modelling inputs, not approved protocol constants)
  executionCost: bigint;
  specialistEffortValue: bigint;
  complexityPremium: bigint;
  riskPremium: bigint;
  scarcityPremium: bigint;
  protocolFloor: bigint;

  // Bond-aware analysis
  requiredBondWei: bigint;
  maxAmountAtRiskWei: bigint;
  expectedNetAgentPayoutWei: bigint;
  protocolFeeWei: bigint;

  // Metadata
  reason: string;
  modelConfidence: number; // 0-1
  calibrationDataDate: number | null;
  computedAt: number;
}

export function newBountyRecommendation(
  trialId: string,
  nativeAsset: "ETH" | "SOL",
  network: string,
): BountyRecommendation {
  const now = Date.now();
  return {
    version: "1.0",
    trialId,
    nativeAsset,
    network,
    minimumRecommended: 0n,
    competitiveBounty: 0n,
    premiumBounty: 0n,
    executionCost: 0n,
    specialistEffortValue: 0n,
    complexityPremium: 0n,
    riskPremium: 0n,
    scarcityPremium: 0n,
    protocolFloor: 0n,
    requiredBondWei: 0n,
    maxAmountAtRiskWei: 0n,
    expectedNetAgentPayoutWei: 0n,
    protocolFeeWei: 0n,
    reason: "No data — bounty not yet computed.",
    modelConfidence: 0,
    calibrationDataDate: null,
    computedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* Bounty adequacy report                                             */
/* ------------------------------------------------------------------ */

export interface BountyAdequacyReport {
  trialId: string;
  recommendation: BountyRecommendation;
  sponsorProposedRewardWei: bigint | null;
  isAdequate: boolean;
  adequacyReason: string;
  suggestions: string[]; // e.g. "Reduce scope", "Extend deadline"
}

export function newBountyAdequacyReport(
  trialId: string,
): BountyAdequacyReport {
  return {
    trialId,
    recommendation: newBountyRecommendation(trialId, "ETH", "31337"),
    sponsorProposedRewardWei: null,
    isAdequate: false,
    adequacyReason: "No bounty computed yet.",
    suggestions: [],
  };
}

/* ------------------------------------------------------------------ */
/* Bond calculation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Calculate the agent bond from the reward using the existing protocol
 * rule: 20% bond on the reward (legacy ETH escrow).
 *
 * Returns the bond in base units (wei). Rounds up so the bond is never
 * printed short (printing short causes StakeTooSmall).
 */
export function calculateBondWei(rewardWei: bigint): bigint {
  // 20% bond = reward * 20 / 100, rounded up.
  return (rewardWei * 20n + 99n) / 100n;
}

/**
 * Calculate the protocol fee from the reward using the legacy 5% fee.
 * Rounds down (truncates) — payouts and credits truncate, never overstate.
 */
export function calculateProtocolFeeWei(rewardWei: bigint): bigint {
  return (rewardWei * BigInt(FEE_BPS_CANONICAL)) / 10000n;
}

/**
 * Calculate the agent's net payout after the protocol fee.
 * Truncates (never rounds up).
 */
export function calculateNetAgentPayoutWei(rewardWei: bigint): bigint {
  return rewardWei - calculateProtocolFeeWei(rewardWei);
}

/* ------------------------------------------------------------------ */
/* Recommendation engine                                              */
/* ------------------------------------------------------------------ */

/**
 * Compute a bounty recommendation from the model inputs.
 *
 * R_recommended = max(R_min, C_execution + V_effort + P_complexity + P_risk + P_scarcity)
 *
 * All inputs are exact integers in base units. The model inputs are
 * modelling inputs, not approved protocol constants — they must be
 * calibrated using real trial data.
 */
export function computeBountyRecommendation(
  trialId: string,
  nativeAsset: "ETH" | "SOL",
  network: string,
  inputs: {
    executionCost: bigint;
    specialistEffortValue: bigint;
    complexityPremium: bigint;
    riskPremium: bigint;
    scarcityPremium: bigint;
    protocolFloor: bigint;
    modelConfidence: number;
    calibrationDataDate: number | null;
    reason: string;
  },
): BountyRecommendation {
  const rec = newBountyRecommendation(trialId, nativeAsset, network);

  rec.executionCost = inputs.executionCost;
  rec.specialistEffortValue = inputs.specialistEffortValue;
  rec.complexityPremium = inputs.complexityPremium;
  rec.riskPremium = inputs.riskPremium;
  rec.scarcityPremium = inputs.scarcityPremium;
  rec.protocolFloor = inputs.protocolFloor;
  rec.modelConfidence = inputs.modelConfidence;
  rec.calibrationDataDate = inputs.calibrationDataDate;
  rec.reason = inputs.reason;

  const sum =
    inputs.executionCost +
    inputs.specialistEffortValue +
    inputs.complexityPremium +
    inputs.riskPremium +
    inputs.scarcityPremium;

  const competitive = sum > inputs.protocolFloor ? sum : inputs.protocolFloor;
  rec.competitiveBounty = competitive;

  // Minimum recommended = the floor.
  rec.minimumRecommended = inputs.protocolFloor;

  // Premium = competitive + 25% complexity/risk buffer, rounded up.
  const premiumBuffer = (competitive * 25n + 99n) / 100n;
  rec.premiumBounty = competitive + premiumBuffer;

  // Bond-aware analysis on the competitive bounty.
  rec.requiredBondWei = calculateBondWei(competitive);
  rec.maxAmountAtRiskWei = competitive + rec.requiredBondWei;
  rec.expectedNetAgentPayoutWei = calculateNetAgentPayoutWei(competitive);
  rec.protocolFeeWei = calculateProtocolFeeWei(competitive);

  return rec;
}

/* ------------------------------------------------------------------ */
/* Adequacy assessment                                                */
/* ------------------------------------------------------------------ */

/**
 * Assess whether a sponsor's proposed reward is adequate. Returns
 * suggestions (reduce scope, extend deadline) rather than pretending
 * an inadequate reward is fine.
 */
export function assessBountyAdequacy(
  trialId: string,
  proposal: BountyAdequacyReport["recommendation"],
  sponsorProposedRewardWei: bigint | null,
): BountyAdequacyReport {
  const report = newBountyAdequacyReport(trialId);
  report.recommendation = proposal;
  report.sponsorProposedRewardWei = sponsorProposedRewardWei;

  if (sponsorProposedRewardWei === null) {
    report.isAdequate = false;
    report.adequacyReason = "No sponsor reward proposed.";
    report.suggestions = ["Propose a reward before requesting adequacy assessment."];
    return report;
  }

  const competitive = proposal.competitiveBounty;
  const floor = proposal.protocolFloor;

  if (sponsorProposedRewardWei < floor) {
    report.isAdequate = false;
    report.adequacyReason = `Proposed reward (${sponsorProposedRewardWei}) is below protocol floor (${floor}).`;
    report.suggestions = [
      "Increase reward to at least the protocol floor, or reduce scope.",
    ];
    return report;
  }

  if (sponsorProposedRewardWei < competitive) {
    const shortfall = competitive - sponsorProposedRewardWei;
    report.isAdequate = false;
    report.adequacyReason = `Proposed reward is ${shortfall} below the competitive bounty.`;
    report.suggestions = [
      "Increase reward to the competitive bounty, or",
      "Reduce task scope/complexity, or",
      "Extend the deadline to lower execution cost.",
    ];
    return report;
  }

  report.isAdequate = true;
  report.adequacyReason =
    "Proposed reward meets or exceeds the competitive bounty.";
  report.suggestions = [];
  return report;
}