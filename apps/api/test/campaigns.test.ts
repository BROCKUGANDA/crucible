/**
 * @file campaigns.test.ts — Tests for campaign and airdrop distributor (REW-003).
 *
 * Covers: campaign creation, lifecycle transitions, eligibility checks,
 * claim attempts, budget enforcement, anti-Sybil controls, and edge cases.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  CampaignDistributor,
  createCampaign,
  createCampaignStore,
  checkEligibility,
  type Campaign,
  type CampaignStatus,
  type EligibilityCriterion,
} from "../src/campaigns";

const FUTURE = Date.now() + 86400000; // 24h from now
const PAST = Date.now() - 86400000;

describe("Campaign creation", () => {
  it("creates a valid campaign", () => {
    const campaign = createCampaign({
      name: "Test Airdrop",
      description: "A test campaign",
      sponsor: "0x1234567890123456789012345678901234567890",
      assetType: "token",
      assetSymbol: "TEST",
      totalBudget: 1000n,
      perClaimAmount: 10n,
      maxClaimsPerWallet: 2,
      startsAt: Date.now(),
      endsAt: FUTURE,
    });

    expect(campaign.campaignId).toMatch(/^camp-/);
    expect(campaign.name).toBe("Test Airdrop");
    expect(campaign.sponsor).toBe("0x1234567890123456789012345678901234567890");
    expect(campaign.status).toBe("draft");
    expect(campaign.totalBudget).toBe(1000n);
    expect(campaign.perClaimAmount).toBe(10n);
    expect(campaign.maxClaimsPerWallet).toBe(2);
  });

  it("rejects zero budget", () => {
    expect(() =>
      createCampaign({
        name: "Empty",
        description: "",
        sponsor: "0x1234",
        assetType: "token",
        totalBudget: 0n,
        perClaimAmount: 10n,
        maxClaimsPerWallet: 1,
        startsAt: Date.now(),
        endsAt: FUTURE,
      }),
    ).toThrow("campaign budget must be positive");
  });

  it("rejects per-claim exceeding budget", () => {
    expect(() =>
      createCampaign({
        name: "Overbudget",
        description: "",
        sponsor: "0x1234",
        assetType: "token",
        totalBudget: 10n,
        perClaimAmount: 100n,
        maxClaimsPerWallet: 1,
        startsAt: Date.now(),
        endsAt: FUTURE,
      }),
    ).toThrow("per-claim amount cannot exceed total budget");
  });

  it("rejects invalid claim window", () => {
    expect(() =>
      createCampaign({
        name: "Bad Window",
        description: "",
        sponsor: "0x1234",
        assetType: "token",
        totalBudget: 100n,
        perClaimAmount: 10n,
        maxClaimsPerWallet: 1,
        startsAt: FUTURE,
        endsAt: Date.now(),
      }),
    ).toThrow("claim window must have a valid start/end range");
  });

  it("rejects past claim window end", () => {
    expect(() =>
      createCampaign({
        name: "Past End",
        description: "",
        sponsor: "0x1234",
        assetType: "token",
        totalBudget: 100n,
        perClaimAmount: 10n,
        maxClaimsPerWallet: 1,
        startsAt: PAST - 86400000,
        endsAt: PAST,
      }),
    ).toThrow("claim window end must be in the future");
  });

  it("normalizes sponsor address to lowercase", () => {
    const campaign = createCampaign({
      name: "Case Test",
      description: "",
      sponsor: "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
      assetType: "token",
      totalBudget: 100n,
      perClaimAmount: 10n,
      maxClaimsPerWallet: 1,
      startsAt: Date.now(),
      endsAt: FUTURE,
    });
    expect(campaign.sponsor).toBe("0xabcdef1234567890abcdef1234567890abcdef12");
  });
});

describe("Campaign lifecycle", () => {
  let distributor: CampaignDistributor;
  let campaign: Campaign;

  beforeEach(() => {
    distributor = new CampaignDistributor(createCampaignStore());
    campaign = distributor.createCampaign({
      name: "Lifecycle Test",
      description: "",
      sponsor: "0x1234",
      assetType: "token",
      totalBudget: 1000n,
      perClaimAmount: 10n,
      maxClaimsPerWallet: 1,
      startsAt: Date.now(),
      endsAt: FUTURE,
    });
  });

  it("transitions from draft to active", () => {
    const updated = distributor.updateCampaignStatus(campaign.campaignId, "active");
    expect(updated?.status).toBe("active");
  });

  it("transitions from active to paused", () => {
    distributor.updateCampaignStatus(campaign.campaignId, "active");
    const updated = distributor.updateCampaignStatus(campaign.campaignId, "paused");
    expect(updated?.status).toBe("paused");
  });

  it("transitions from paused back to active", () => {
    distributor.updateCampaignStatus(campaign.campaignId, "active");
    distributor.updateCampaignStatus(campaign.campaignId, "paused");
    const updated = distributor.updateCampaignStatus(campaign.campaignId, "active");
    expect(updated?.status).toBe("active");
  });

  it("transitions from active to ended", () => {
    distributor.updateCampaignStatus(campaign.campaignId, "active");
    const updated = distributor.updateCampaignStatus(campaign.campaignId, "ended");
    expect(updated?.status).toBe("ended");
  });

  it("rejects invalid transition (draft → paused)", () => {
    expect(() =>
      distributor.updateCampaignStatus(campaign.campaignId, "paused"),
    ).toThrow("invalid campaign transition: draft → paused");
  });

  it("rejects transition from ended (ended → active)", () => {
    distributor.updateCampaignStatus(campaign.campaignId, "active");
    distributor.updateCampaignStatus(campaign.campaignId, "ended");
    expect(() =>
      distributor.updateCampaignStatus(campaign.campaignId, "active"),
    ).toThrow("invalid campaign transition: ended →");
  });

  it("returns undefined for non-existent campaign", () => {
    const updated = distributor.updateCampaignStatus("nonexistent", "active");
    expect(updated).toBeUndefined();
  });

  it("lists campaigns by status", () => {
    distributor.updateCampaignStatus(campaign.campaignId, "active");
    const active = distributor.listCampaigns("active");
    expect(active.length).toBe(1);
    expect(active[0].campaignId).toBe(campaign.campaignId);

    const drafts = distributor.listCampaigns("draft");
    expect(drafts.length).toBe(0);
  });
});

describe("Eligibility checks", () => {
  let campaign: Campaign;

  beforeEach(() => {
    campaign = createCampaign({
      name: "Eligibility Test",
      description: "",
      sponsor: "0x1234",
      assetType: "token",
      totalBudget: 1000n,
      perClaimAmount: 10n,
      maxClaimsPerWallet: 1,
      startsAt: Date.now(),
      endsAt: FUTURE,
    });
  });

  it("allows wallet with no criteria", () => {
    const result = checkEligibility(campaign, "0xabcd");
    expect(result.eligible).toBe(true);
  });

  it("blocks wallet on blocklist", () => {
    const campaignWithBlocklist = {
      ...campaign,
      blocklist: ["0xabcd"],
    };
    const result = checkEligibility(campaignWithBlocklist, "0xabcd");
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toContain("blocklist");
  });

  it("blocks wallet not on allowlist", () => {
    const campaignWithAllowlist = {
      ...campaign,
      allowlist: ["0x1234"],
    };
    const result = checkEligibility(campaignWithAllowlist, "0xabcd");
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toContain("allowlist");
  });

  it("allows wallet on allowlist", () => {
    const campaignWithAllowlist = {
      ...campaign,
      allowlist: ["0xabcd"],
    };
    const result = checkEligibility(campaignWithAllowlist, "0xabcd");
    expect(result.eligible).toBe(true);
  });

  it("case-insensitive blocklist check", () => {
    const campaignWithBlocklist = {
      ...campaign,
      blocklist: ["0xABCd"],
    };
    const result = checkEligibility(campaignWithBlocklist, "0xabcd");
    expect(result.eligible).toBe(false);
  });

  it("evaluates wallet_age criterion", () => {
    const criteria: EligibilityCriterion[] = [
      {
        type: "wallet_age",
        operator: "gte",
        value: 30,
        description: "Wallet must be at least 30 days old",
      },
    ];
    const campaignWithCriteria = { ...campaign, eligibility: criteria };

    const result = checkEligibility(campaignWithCriteria, "0xabcd", {
      walletAge: 60,
    });
    expect(result.eligible).toBe(true);

    const result2 = checkEligibility(campaignWithCriteria, "0xabcd", {
      walletAge: 10,
    });
    expect(result2.eligible).toBe(false);
  });

  it("evaluates trial_count criterion", () => {
    const criteria: EligibilityCriterion[] = [
      {
        type: "trial_count",
        operator: "gte",
        value: 5,
        description: "Must have completed at least 5 trials",
      },
    ];
    const campaignWithCriteria = { ...campaign, eligibility: criteria };

    const result = checkEligibility(campaignWithCriteria, "0xabcd", {
      trialCount: 10,
    });
    expect(result.eligible).toBe(true);

    const result2 = checkEligibility(campaignWithCriteria, "0xabcd", {
      trialCount: 2,
    });
    expect(result2.eligible).toBe(false);
  });

  it("evaluates reputation criterion", () => {
    const criteria: EligibilityCriterion[] = [
      {
        type: "reputation_min",
        operator: "gte",
        value: 100,
        description: "Minimum reputation score",
      },
    ];
    const campaignWithCriteria = { ...campaign, eligibility: criteria };

    const result = checkEligibility(campaignWithCriteria, "0xabcd", {
      reputation: 150,
    });
    expect(result.eligible).toBe(true);

    const result2 = checkEligibility(campaignWithCriteria, "0xabcd", {
      reputation: 50,
    });
    expect(result2.eligible).toBe(false);
  });

  it("requires passport when configured", () => {
    const campaignWithPassport = {
      ...campaign,
      requirePassport: true,
    };
    const result = checkEligibility(campaignWithPassport, "0xabcd");
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toContain("passport");
  });
});

describe("Claim lifecycle", () => {
  let distributor: CampaignDistributor;
  let campaign: Campaign;

  beforeEach(() => {
    distributor = new CampaignDistributor(createCampaignStore());
    campaign = distributor.createCampaign({
      name: "Claim Test",
      description: "",
      sponsor: "0x1234",
      assetType: "token",
      totalBudget: 100n,
      perClaimAmount: 10n,
      maxClaimsPerWallet: 2,
      startsAt: Date.now(),
      endsAt: FUTURE,
    });
    distributor.updateCampaignStatus(campaign.campaignId, "active");
  });

  it("rejects claim on non-existent campaign", () => {
    const result = distributor.attemptClaim("nonexistent", "0xabcd");
    expect("error" in result).toBe(true);
    expect((result as any).code).toBe("campaign_not_found");
  });

  it("rejects claim on inactive campaign", () => {
    const draftCampaign = distributor.createCampaign({
      name: "Draft",
      description: "",
      sponsor: "0x1234",
      assetType: "token",
      totalBudget: 100n,
      perClaimAmount: 10n,
      maxClaimsPerWallet: 1,
      startsAt: Date.now(),
      endsAt: FUTURE,
    });
    const result = distributor.attemptClaim(draftCampaign.campaignId, "0xabcd");
    expect("error" in result).toBe(true);
    expect((result as any).code).toBe("campaign_not_active");
  });

  it("rejects claim before window opens", () => {
    const futureCampaign = distributor.createCampaign({
      name: "Future",
      description: "",
      sponsor: "0x1234",
      assetType: "token",
      totalBudget: 100n,
      perClaimAmount: 10n,
      maxClaimsPerWallet: 1,
      startsAt: FUTURE,
      endsAt: FUTURE + 86400000,
    });
    distributor.updateCampaignStatus(futureCampaign.campaignId, "active");
    const result = distributor.attemptClaim(futureCampaign.campaignId, "0xabcd");
    expect("error" in result).toBe(true);
    expect((result as any).code).toBe("claim_window_not_open");
  });

  it("rejects claim after window closes", async () => {
    // createCampaign validates endsAt > now, so we create a campaign
    // with a very short window and wait for it to expire
    const store = createCampaignStore();
    const distributor = new CampaignDistributor(store);
    
    const shortLived = distributor.createCampaign({
      name: "Short-lived",
      description: "",
      sponsor: "0x1234",
      assetType: "token",
      totalBudget: 100n,
      perClaimAmount: 10n,
      maxClaimsPerWallet: 1,
      startsAt: Date.now(),
      endsAt: Date.now() + 50, // expires in 50ms
    });
    distributor.updateCampaignStatus(shortLived.campaignId, "active");
    
    // Wait for the window to close
    await new Promise((r) => setTimeout(r, 60));
    
    const result = distributor.attemptClaim(shortLived.campaignId, "0xabcd");
    expect("error" in result).toBe(true);
    expect((result as any).code).toBe("claim_window_closed");
  });

  it("creates a pending claim successfully", () => {
    const result = distributor.attemptClaim(campaign.campaignId, "0xabcd");
    expect("error" in result).toBe(false);
    if ("claim" in result) {
      expect(result.claim.status).toBe("pending");
      expect(result.claim.amount).toBe(10n);
      expect(result.claim.recipient).toBe("0xabcd");
      expect(result.budget.remaining).toBe(90n);
    }
  });

  it("enforces max claims per wallet", () => {
    distributor.attemptClaim(campaign.campaignId, "0xabcd");
    distributor.attemptClaim(campaign.campaignId, "0xabcd");
    const result = distributor.attemptClaim(campaign.campaignId, "0xabcd");
    expect("error" in result).toBe(true);
    expect((result as any).code).toBe("max_claims_reached");
  });

  it("depletes budget when exhausted", () => {
    const smallCampaign = distributor.createCampaign({
      name: "Small",
      description: "",
      sponsor: "0x1234",
      assetType: "token",
      totalBudget: 20n,
      perClaimAmount: 10n,
      maxClaimsPerWallet: 5,
      startsAt: Date.now(),
      endsAt: FUTURE,
    });
    distributor.updateCampaignStatus(smallCampaign.campaignId, "active");

    distributor.attemptClaim(smallCampaign.campaignId, "0xaaa");
    distributor.attemptClaim(smallCampaign.campaignId, "0xbbb");

    const result = distributor.attemptClaim(smallCampaign.campaignId, "0xccc");
    expect("error" in result).toBe(true);
    expect((result as any).code).toBe("budget_depleted");
  });

  it("completes a claim with tx hash", () => {
    const result = distributor.attemptClaim(campaign.campaignId, "0xabcd");
    if ("claim" in result) {
      const completed = distributor.completeClaim(result.claim.claimId, "0xtx123");
      expect("error" in completed).toBe(false);
      if ("status" in completed) {
        expect(completed.status).toBe("completed");
        expect(completed.txHash).toBe("0xtx123");
        expect(completed.completedAt).toBeDefined();
      }
    }
  });

  it("rejects completing non-pending claim", () => {
    const result = distributor.attemptClaim(campaign.campaignId, "0xabcd");
    if ("claim" in result) {
      distributor.completeClaim(result.claim.claimId, "0xtx123");
      const again = distributor.completeClaim(result.claim.claimId, "0xtx456");
      expect("error" in again).toBe(true);
      expect((again as any).code).toBe("claim_not_pending");
    }
  });

  it("rejects a claim", () => {
    const result = distributor.attemptClaim(campaign.campaignId, "0xabcd");
    if ("claim" in result) {
      const rejected = distributor.rejectClaim(result.claim.claimId, "Manual review");
      expect("error" in rejected).toBe(false);
      if ("status" in rejected) {
        expect(rejected.status).toBe("rejected");
      }
    }
  });
});

describe("Budget tracking", () => {
  let distributor: CampaignDistributor;
  let campaign: Campaign;

  beforeEach(() => {
    distributor = new CampaignDistributor(createCampaignStore());
    campaign = distributor.createCampaign({
      name: "Budget Test",
      description: "",
      sponsor: "0x1234",
      assetType: "token",
      totalBudget: 100n,
      perClaimAmount: 10n,
      maxClaimsPerWallet: 1,
      startsAt: Date.now(),
      endsAt: FUTURE,
    });
    distributor.updateCampaignStatus(campaign.campaignId, "active");
  });

  it("reports initial budget correctly", () => {
    const budget = distributor.getBudget(campaign.campaignId);
    expect(budget).not.toBeNull();
    expect(budget!.totalBudget).toBe(100n);
    expect(budget!.remaining).toBe(100n);
    expect(budget!.claimed).toBe(0n);
    expect(budget!.pending).toBe(0n);
    expect(budget!.claimsCount).toBe(0);
    expect(budget!.uniqueClaimants).toBe(0);
  });

  it("tracks pending claims in budget", () => {
    distributor.attemptClaim(campaign.campaignId, "0xaaa");
    distributor.attemptClaim(campaign.campaignId, "0xbbb");

    const budget = distributor.getBudget(campaign.campaignId);
    expect(budget!.pending).toBe(20n);
    expect(budget!.remaining).toBe(80n);
    expect(budget!.claimsCount).toBe(2);
    expect(budget!.uniqueClaimants).toBe(2);
  });

  it("tracks completed claims in budget", () => {
    const result = distributor.attemptClaim(campaign.campaignId, "0xaaa");
    if ("claim" in result) {
      distributor.completeClaim(result.claim.claimId, "0xtx123");
    }

    const budget = distributor.getBudget(campaign.campaignId);
    expect(budget!.completed).toBe(10n);
    expect(budget!.claimed).toBe(10n);
    expect(budget!.pending).toBe(0n);
    expect(budget!.remaining).toBe(90n);
  });

  it("returns null budget for non-existent campaign", () => {
    const budget = distributor.getBudget("nonexistent");
    expect(budget).toBeNull();
  });
});

describe("CampaignDistributor integration", () => {
  it("full lifecycle: create, activate, claim, complete", () => {
    const distributor = new CampaignDistributor(createCampaignStore());

    const campaign = distributor.createCampaign({
      name: "Full Lifecycle",
      description: "End-to-end test",
      sponsor: "0x1234",
      assetType: "token",
      assetSymbol: "FLC",
      totalBudget: 50n,
      perClaimAmount: 10n,
      maxClaimsPerWallet: 1,
      startsAt: Date.now(),
      endsAt: FUTURE,
    });

    expect(campaign.status).toBe("draft");

    distributor.updateCampaignStatus(campaign.campaignId, "active");
    const active = distributor.getCampaign(campaign.campaignId);
    expect(active?.status).toBe("active");

    const result = distributor.attemptClaim(campaign.campaignId, "0xabcd");
    expect("error" in result).toBe(false);

    if ("claim" in result) {
      const completed = distributor.completeClaim(result.claim.claimId, "0xtx");
      expect("error" in completed).toBe(false);

      const budget = distributor.getBudget(campaign.campaignId);
      expect(budget!.completed).toBe(10n);
      expect(budget!.remaining).toBe(40n);
    }
  });

  it("eligibility check before claim", () => {
    const distributor = new CampaignDistributor(createCampaignStore());

    const campaign = distributor.createCampaign({
      name: "Eligibility Gate",
      description: "",
      sponsor: "0x1234",
      assetType: "token",
      totalBudget: 100n,
      perClaimAmount: 10n,
      maxClaimsPerWallet: 1,
      startsAt: Date.now(),
      endsAt: FUTURE,
      eligibility: [
        {
          type: "trial_count",
          operator: "gte",
          value: 5,
          description: "Must have 5+ trials",
        },
      ],
    });
    distributor.updateCampaignStatus(campaign.campaignId, "active");

    const eligible = distributor.checkEligibility(campaign.campaignId, "0xabcd", {
      trialCount: 10,
    });
    expect("error" in eligible).toBe(false);
    if ("eligible" in eligible) {
      expect(eligible.eligible).toBe(true);
    }

    const notEligible = distributor.checkEligibility(campaign.campaignId, "0xabcd", {
      trialCount: 2,
    });
    expect("error" in notEligible).toBe(false);
    if ("eligible" in notEligible) {
      expect(notEligible.eligible).toBe(false);
    }
  });
});
