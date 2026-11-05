/**
 * @file forge-campaign.test.ts — Forge Campaigns tests.
 */

import { describe, it, expect } from "vitest";
import {
  newForgeCampaign,
  addStage,
  fundStage,
  settleStage,
  isStageEligible,
  validateCampaign,
} from "../src/forge-campaign.js";

describe("newForgeCampaign", () => {
  it("creates a draft campaign", () => {
    const c = newForgeCampaign("camp-1", "0xsponsor", "Reconciliation", "ETH", "31337");
    expect(c.campaignId).toBe("camp-1");
    expect(c.sponsor).toBe("0xsponsor");
    expect(c.title).toBe("Reconciliation");
    expect(c.status).toBe("draft");
    expect(c.stages).toHaveLength(0);
    expect(c.unfundedStagesAdvertisedAsGuaranteed).toBe(false);
    expect(c.fundedBudgetWei).toBe(0n);
  });

  it("throws on missing fields", () => {
    expect(() => newForgeCampaign("", "0xsponsor", "T", "ETH", "31337")).toThrow();
    expect(() => newForgeCampaign("c", "", "T", "ETH", "31337")).toThrow();
    expect(() => newForgeCampaign("c", "0x", "", "ETH", "31337")).toThrow();
  });
});

describe("addStage", () => {
  it("adds stages sequentially", () => {
    let c = newForgeCampaign("camp-1", "0xsponsor", "T", "ETH", "31337");
    c = addStage(c, {
      stageId: "s1",
      campaignId: "camp-1",
      stageNumber: 1,
      title: "Stage 1",
      domain: "finance",
      heat: "kindling",
      requiredSkill: [],
      briefId: "brief-1",
      rewardWei: 100n,
      nativeAsset: "ETH",
      network: "31337",
      status: "unfunded",
      dependsOn: [],
      unlockCondition: "manual",
    });
    expect(c.stages).toHaveLength(1);
    expect(c.stages[0].stageNumber).toBe(1);

    c = addStage(c, {
      stageId: "s2",
      campaignId: "camp-1",
      stageNumber: 2,
      title: "Stage 2",
      domain: "finance",
      heat: "tempering",
      requiredSkill: [],
      briefId: "brief-2",
      rewardWei: 200n,
      nativeAsset: "ETH",
      network: "31337",
      status: "unfunded",
      dependsOn: ["s1"],
      unlockCondition: "previous_stage_settled",
    });
    expect(c.stages).toHaveLength(2);
    expect(c.stages[1].stageNumber).toBe(2);
  });

  it("rejects non-sequential stage numbers", () => {
    let c = newForgeCampaign("camp-1", "0xsponsor", "T", "ETH", "31337");
    c = addStage(c, {
      stageId: "s1",
      campaignId: "camp-1",
      stageNumber: 1,
      title: "S1",
      domain: "d",
      heat: "kindling",
      requiredSkill: [],
      briefId: "b",
      rewardWei: 100n,
      nativeAsset: "ETH",
      network: "31337",
      status: "unfunded",
      dependsOn: [],
      unlockCondition: "manual",
    });
    expect(() =>
      addStage(c, {
        stageId: "s3",
        campaignId: "camp-1",
        stageNumber: 3,
        title: "S3",
        domain: "d",
        heat: "kindling",
        requiredSkill: [],
        briefId: "b",
        rewardWei: 100n,
        nativeAsset: "ETH",
        network: "31337",
        status: "unfunded",
        dependsOn: [],
        unlockCondition: "manual",
      }),
    ).toThrow();
  });

  it("rejects stages on completed campaigns", () => {
    let c = newForgeCampaign("camp-1", "0xsponsor", "T", "ETH", "31337");
    c = addStage(c, {
      stageId: "s1",
      campaignId: "camp-1",
      stageNumber: 1,
      title: "S1",
      domain: "d",
      heat: "kindling",
      requiredSkill: [],
      briefId: "b",
      rewardWei: 100n,
      nativeAsset: "ETH",
      network: "31337",
      status: "unfunded",
      dependsOn: [],
      unlockCondition: "manual",
    });
    c = { ...c, status: "completed" as const };
    expect(() =>
      addStage(c, {
        stageId: "s2",
        campaignId: "camp-1",
        stageNumber: 2,
        title: "S2",
        domain: "d",
        heat: "kindling",
        requiredSkill: [],
        briefId: "b",
        rewardWei: 100n,
        nativeAsset: "ETH",
        network: "31337",
        status: "unfunded",
        dependsOn: [],
        unlockCondition: "manual",
      }),
    ).toThrow();
  });
});

describe("fundStage", () => {
  it("funds a stage and unlocks the next", () => {
    let c = newForgeCampaign("camp-1", "0xsponsor", "T", "ETH", "31337");
    c = { ...c, totalBudgetWei: 1000n };
    c = addStage(c, {
      stageId: "s1",
      campaignId: "camp-1",
      stageNumber: 1,
      title: "S1",
      domain: "d",
      heat: "kindling",
      requiredSkill: [],
      briefId: "b",
      rewardWei: 100n,
      nativeAsset: "ETH",
      network: "31337",
      status: "unfunded",
      dependsOn: [],
      unlockCondition: "manual",
    });
    c = addStage(c, {
      stageId: "s2",
      campaignId: "camp-1",
      stageNumber: 2,
      title: "S2",
      domain: "d",
      heat: "tempering",
      requiredSkill: [],
      briefId: "b",
      rewardWei: 200n,
      nativeAsset: "ETH",
      network: "31337",
      status: "unfunded",
      dependsOn: ["s1"],
      unlockCondition: "previous_stage_settled",
    });

    c = fundStage(c, "s1", 100n);
    expect(c.fundedBudgetWei).toBe(100n);
    expect(c.stages[0].status).toBe("funded");
    // s2 is still unfunded (unlock condition is previous_stage_settled, not met yet)
    expect(c.stages[1].status).toBe("unfunded");
  });

  it("rejects funding beyond budget", () => {
    let c = newForgeCampaign("camp-1", "0xsponsor", "T", "ETH", "31337");
    c = { ...c, totalBudgetWei: 100n };
    c = addStage(c, {
      stageId: "s1",
      campaignId: "camp-1",
      stageNumber: 1,
      title: "S1",
      domain: "d",
      heat: "kindling",
      requiredSkill: [],
      briefId: "b",
      rewardWei: 100n,
      nativeAsset: "ETH",
      network: "31337",
      status: "unfunded",
      dependsOn: [],
      unlockCondition: "manual",
    });
    expect(() => fundStage(c, "s1", 200n)).toThrow();
  });

  it("rejects double funding", () => {
    let c = newForgeCampaign("camp-1", "0xsponsor", "T", "ETH", "31337");
    c = { ...c, totalBudgetWei: 1000n };
    c = addStage(c, {
      stageId: "s1",
      campaignId: "camp-1",
      stageNumber: 1,
      title: "S1",
      domain: "d",
      heat: "kindling",
      requiredSkill: [],
      briefId: "b",
      rewardWei: 100n,
      nativeAsset: "ETH",
      network: "31337",
      status: "unfunded",
      dependsOn: [],
      unlockCondition: "manual",
    });
    c = fundStage(c, "s1", 100n);
    expect(() => fundStage(c, "s1", 50n)).toThrow();
  });
});

describe("settleStage", () => {
  it("settles a stage and unlocks the next", () => {
    let c = newForgeCampaign("camp-1", "0xsponsor", "T", "ETH", "31337");
    c = { ...c, totalBudgetWei: 1000n };
    c = addStage(c, {
      stageId: "s1",
      campaignId: "camp-1",
      stageNumber: 1,
      title: "S1",
      domain: "d",
      heat: "kindling",
      requiredSkill: [],
      briefId: "b",
      rewardWei: 100n,
      nativeAsset: "ETH",
      network: "31337",
      status: "open",
      dependsOn: [],
      unlockCondition: "manual",
    });
    c = addStage(c, {
      stageId: "s2",
      campaignId: "camp-1",
      stageNumber: 2,
      title: "S2",
      domain: "d",
      heat: "tempering",
      requiredSkill: [],
      briefId: "b",
      rewardWei: 200n,
      nativeAsset: "ETH",
      network: "31337",
      status: "unfunded",
      dependsOn: ["s1"],
      unlockCondition: "previous_stage_settled",
    });

    c = settleStage(c, "s1");
    expect(c.stages[0].status).toBe("settled");
    expect(c.stages[1].status).toBe("open"); // unlocked
  });

  it("rejects settling an unfunded stage", () => {
    let c = newForgeCampaign("camp-1", "0xsponsor", "T", "ETH", "31337");
    c = { ...c, totalBudgetWei: 1000n };
    c = addStage(c, {
      stageId: "s1",
      campaignId: "camp-1",
      stageNumber: 1,
      title: "S1",
      domain: "d",
      heat: "kindling",
      requiredSkill: [],
      briefId: "b",
      rewardWei: 100n,
      nativeAsset: "ETH",
      network: "31337",
      status: "unfunded",
      dependsOn: [],
      unlockCondition: "manual",
    });
    expect(() => settleStage(c, "s1")).toThrow();
  });
});

describe("isStageEligible", () => {
  it("reports ineligible for unfunded stage", () => {
    const c = newForgeCampaign("camp-1", "0xsponsor", "T", "ETH", "31337", 1000n);
    const r = isStageEligible(c, "nonexistent");
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("not found");
  });
});

describe("validateCampaign", () => {
  it("validates a well-formed campaign", () => {
    const c = newForgeCampaign("camp-1", "0xsponsor", "T", "ETH", "31337");
    c.totalBudgetWei = 300n;
    const r = validateCampaign(c);
    expect(r.valid).toBe(true);
    expect(r.failures).toHaveLength(0);
  });

  it("rejects unfunded stages advertised as guaranteed", () => {
    const c = newForgeCampaign("camp-1", "0xsponsor", "T", "ETH", "31337");
    c.totalBudgetWei = 100n;
    c.unfundedStagesAdvertisedAsGuaranteed = true;
    const r = validateCampaign(c);
    expect(r.valid).toBe(false);
    expect(r.failures.some((f) => f.includes("guaranteed"))).toBe(true);
  });

  it("rejects funded budget exceeding total", () => {
    const c = newForgeCampaign("camp-1", "0xsponsor", "T", "ETH", "31337");
    c.totalBudgetWei = 100n;
    c.fundedBudgetWei = 200n;
    const r = validateCampaign(c);
    expect(r.valid).toBe(false);
  });
});