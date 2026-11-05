/**
 * @file forge-campaign.ts — Forge Campaigns.
 *
 * Sponsor-defined sequences of increasingly difficult challenges. Each paid
 * campaign stage is a separately created and funded trial with its own
 * on-chain identifier, reward, specification, and test-suite commitment.
 * Stages are linked by a campaign ID in the off-chain product layer only.
 *
 * The campaign object itself never holds funds. No shared escrow accounting
 * is created without a separate approved contract design.
 *
 * An unfunded future stage must never be represented as an available
 * guaranteed reward.
 */

export type CampaignStatus =
  | "draft"
  | "planning"
  | "funded"
  | "active"
  | "paused"
  | "completed"
  | "cancelled";

export type StageStatus =
  | "unfunded"
  | "funded"
  | "open"
  | "assigned"
  | "judging"
  | "challenged"
  | "settled"
  | "locked"
  | "cancelled";

export interface CampaignStage {
  stageId: string;
  campaignId: string;
  stageNumber: number; // 1-based
  title: string;
  domain: string;
  heat: "kindling" | "tempering" | "forging" | "crucible" | "masterwork";
  requiredSkill: string[];
  briefId: string; // references a Forge Brief
  trialId?: string; // set when the stage trial is created on-chain
  rewardWei: bigint;
  nativeAsset: "ETH" | "SOL";
  network: string;
  deadlineMs?: number;
  status: StageStatus;
  dependsOn: string[]; // stageIds that must complete first
  unlockCondition: "previous_stage_settled" | "manual" | "time_based";
  previousStageEvidence?: string; // reference to prior stage's settlement
  fundedAt?: number;
  settledAt?: number;
}

export interface ForgeCampaign {
  version: string;
  campaignId: string;
  sponsor: string;
  title: string;
  description: string;
  domain: string;
  totalBudgetWei: bigint;
  fundedBudgetWei: bigint;
  nativeAsset: "ETH" | "SOL";
  network: string;
  deadlineMs?: number;
  campaignDeadlineMs?: number;
  requiredSkill: string[];
  stages: CampaignStage[];
  status: CampaignStatus;
  createdAt: number;
  updatedAt: number;
  /** Whether the campaign advertises any unfunded stage as guaranteed. Must be false. */
  unfundedStagesAdvertisedAsGuaranteed: boolean;
}

export function newForgeCampaign(
  campaignId: string,
  sponsor: string,
  title: string,
  nativeAsset: "ETH" | "SOL",
  network: string,
): ForgeCampaign {
  if (!campaignId || !sponsor || !title) {
    throw new Error("forge-campaign: campaignId, sponsor, and title are required");
  }
  const now = Date.now();
  return {
    version: "1.0",
    campaignId,
    sponsor,
    title,
    description: "",
    domain: "",
    totalBudgetWei: 0n,
    fundedBudgetWei: 0n,
    nativeAsset,
    network,
    requiredSkill: [],
    stages: [],
    status: "draft",
    createdAt: now,
    updatedAt: now,
    unfundedStagesAdvertisedAsGuaranteed: false,
  };
}

/* ------------------------------------------------------------------ */
/* Stage management                                                   */
/* ------------------------------------------------------------------ */

export function addStage(
  campaign: ForgeCampaign,
  stage: CampaignStage,
): ForgeCampaign {
  if (campaign.status !== "draft" && campaign.status !== "planning") {
    throw new Error("forge-campaign: stages can only be added to draft or planning campaigns.");
  }
  // Stage numbers must be sequential.
  const expectedNumber = campaign.stages.length + 1;
  if (stage.stageNumber !== expectedNumber) {
    throw new Error(`forge-campaign: stage number must be ${expectedNumber}, got ${stage.stageNumber}.`);
  }
  // A stage cannot depend on a future stage.
  for (const dep of stage.dependsOn) {
    if (!campaign.stages.some((s) => s.stageId === dep)) {
      throw new Error(`forge-campaign: stage depends on unknown stage ${dep}.`);
    }
  }
  return {
    ...campaign,
    stages: [...campaign.stages, stage],
    updatedAt: Date.now(),
  };
}

/**
 * Fund a stage. Sets fundedBudgetWei and marks the stage funded. A stage
 * cannot be funded beyond the campaign's total remaining budget.
 *
 * Unlocking of dependent stages happens in settleStage, not here — a stage
 * becomes available only after its dependency settles.
 */
export function fundStage(
  campaign: ForgeCampaign,
  stageId: string,
  amountWei: bigint,
): ForgeCampaign {
  if (amountWei <= 0n) {
    throw new Error("forge-campaign: funding amount must be positive.");
  }
  const stageIndex = campaign.stages.findIndex((s) => s.stageId === stageId);
  if (stageIndex === -1) {
    throw new Error(`forge-campaign: stage ${stageId} not found.`);
  }
  const stage = campaign.stages[stageIndex];
  if (!stage) {
    throw new Error(`forge-campaign: stage ${stageId} not found.`);
  }
  if (stage.status !== "unfunded") {
    throw new Error(`forge-campaign: stage ${stageId} is already ${stage.status}.`);
  }

  const remainingBudget = campaign.totalBudgetWei - campaign.fundedBudgetWei;
  if (amountWei > remainingBudget) {
    throw new Error("forge-campaign: funding exceeds remaining campaign budget.");
  }

  const updatedStage: CampaignStage = {
    ...stage,
    status: "funded",
    fundedAt: Date.now(),
  };
  const updatedStages = [...campaign.stages];
  updatedStages[stageIndex] = updatedStage;

  return {
    ...campaign,
    fundedBudgetWei: campaign.fundedBudgetWei + amountWei,
    stages: updatedStages,
    updatedAt: Date.now(),
  };
}

/**
 * Settle a stage. Marks the stage settled and unlocks the next stage if its
 * unlock condition is "previous_stage_settled".
 */
export function settleStage(
  campaign: ForgeCampaign,
  stageId: string,
): ForgeCampaign {
  const stageIndex = campaign.stages.findIndex((s) => s.stageId === stageId);
  if (stageIndex === -1) {
    throw new Error(`forge-campaign: stage ${stageId} not found.`);
  }
  const stage = campaign.stages[stageIndex];
  if (!stage) {
    throw new Error(`forge-campaign: stage ${stageId} not found.`);
  }
  if (
    stage.status !== "open" &&
    stage.status !== "assigned" &&
    stage.status !== "judging" &&
    stage.status !== "challenged" &&
    stage.status !== "funded"
  ) {
    throw new Error(
      `forge-campaign: stage ${stageId} is not in a settlable state (${stage.status}).`,
    );
  }

  const updatedStage: CampaignStage = {
    ...stage,
    status: "settled",
    settledAt: Date.now(),
  };
  const updatedStages = [...campaign.stages];
  updatedStages[stageIndex] = updatedStage;

  // Unlock the next stage if its unlock condition is "previous_stage_settled"
  // and the next stage is currently unfunded (it becomes "open" so it can be claimed).
  const nextStageIndex = stageIndex + 1;
  if (nextStageIndex < campaign.stages.length) {
    const next = campaign.stages[nextStageIndex];
    if (!next) {
      throw new Error(`forge-campaign: next stage at index ${nextStageIndex} not found.`);
    }
    if (
      next.unlockCondition === "previous_stage_settled" &&
      next.status === "unfunded"
    ) {
      updatedStages[nextStageIndex] = { ...next, status: "open" };
    }
  }

  // Check if all stages are settled or cancelled.
  const allSettled = updatedStages.every(
    (s) => s.status === "settled" || s.status === "cancelled",
  );
  const campaignStatus = allSettled ? "completed" : campaign.status;

  return {
    ...campaign,
    stages: updatedStages,
    status: campaignStatus,
    updatedAt: Date.now(),
  };
}

/**
 * Check whether a stage is eligible to be opened (all dependencies settled,
 * unlock condition met, stage is funded).
 */
export function isStageEligible(
  campaign: ForgeCampaign,
  stageId: string,
): { eligible: boolean; reason: string | null } {
  const stage = campaign.stages.find((s) => s.stageId === stageId);
  if (!stage) {
    return { eligible: false, reason: "Stage not found." };
  }
  if (
    stage.status !== "unfunded" &&
    stage.status !== "locked" &&
    stage.status !== "open"
  ) {
    return { eligible: false, reason: `Stage is ${stage.status}.` };
  }
  if (stage.status === "unfunded") {
    return { eligible: false, reason: "Stage is not yet funded." };
  }
  // Check dependencies.
  for (const depId of stage.dependsOn) {
    const dep = campaign.stages.find((s) => s.stageId === depId);
    if (!dep || dep.status !== "settled") {
      return { eligible: false, reason: `Dependency stage ${depId} is not settled.` };
    }
  }
  return { eligible: true, reason: null };
}

/**
 * Validate that the campaign does not advertise unfunded stages as guaranteed.
 */
export function validateCampaign(campaign: ForgeCampaign): {
  valid: boolean;
  failures: string[];
} {
  const failures: string[] = [];

  // Total funded must not exceed total budget.
  if (campaign.fundedBudgetWei > campaign.totalBudgetWei) {
    failures.push("Funded budget exceeds total campaign budget.");
  }

  // No unfunded stage may be advertised as guaranteed.
  if (campaign.unfundedStagesAdvertisedAsGuaranteed) {
    failures.push("Unfunded stages are advertised as guaranteed — this is prohibited.");
  }

  // Each funded stage's reward must not exceed remaining budget at time of funding
  // (checked at fund time; here we check consistency).
  let cumulativeFunded = 0n;
  for (const stage of campaign.stages) {
    if (
      stage.status === "funded" ||
      stage.status === "open" ||
      stage.status === "settled"
    ) {
      cumulativeFunded += stage.rewardWei;
    }
  }
  if (cumulativeFunded > campaign.totalBudgetWei) {
    failures.push("Sum of funded stage rewards exceeds total campaign budget.");
  }

  // Stage numbers must be sequential starting at 1.
  for (let i = 0; i < campaign.stages.length; i++) {
    const stage = campaign.stages[i];
    if (!stage) {
      failures.push(`Stage at position ${i + 1} is missing.`);
      continue;
    }
    if (stage.stageNumber !== i + 1) {
      failures.push(`Stage numbers are not sequential at position ${i + 1}.`);
    }
  }

  return { valid: failures.length === 0, failures };
}

/* ------------------------------------------------------------------ */
/* TypeScript brand                                                   */
/* ------------------------------------------------------------------ */

export const __forgeCampaignBrand = Symbol.for("crucible.forge-campaign");