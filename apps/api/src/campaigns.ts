/**
 * @file campaigns.ts — Campaign and airdrop distributor (REW-003).
 *
 * A campaign is a distribution event with its own eligibility rules, budget,
 * claim window, and anti-Sybil controls. It is separate from:
 *
 *   - Engrams (achievement-based NFT entitlements)
 *   - The test ETH faucet (developer utility)
 *   - Agent collateral (trial security deposits)
 *
 * Design decisions:
 *
 *   1. **A campaign is not an Engram.** Engrams reward verified achievements.
 *      Campaigns distribute tokens, credits, or other assets based on
 *      eligibility criteria that may have nothing to do with trial performance.
 *   2. **The budget is the campaign's hard limit.** No claim can succeed if
 *      the remaining budget is insufficient. The distributor tracks spent
 *      and reserved amounts separately so a campaign cannot overspend.
 *   3. **Claim windows are explicit.** A campaign has a start and end time.
 *      Claims outside the window are rejected, not silently queued.
 *   4. **Anti-Sybil is layered.** Wallet-based dedup prevents double-claiming.
 *      Optional passport checks add risk scoring for higher-value campaigns.
 *   5. **The distributor is server-authoritative.** The browser never computes
 *      eligibility or budget. It only displays what the server confirms.
 */

import { randomBytes } from "crypto";
import {
  decide,
  scoreWallet,
  type Decision,
  type PassportSignal,
  type RiskScore,
} from "./identity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The lifecycle status of a campaign. */
export type CampaignStatus = "draft" | "active" | "paused" | "ended" | "depleted";

/** The type of asset a campaign distributes. */
export type CampaignAssetType = "token" | "credit" | "nft" | "custom";

/** Eligibility criterion type. */
export type EligibilityType =
  | "wallet_age"
  | "trial_count"
  | "reputation_min"
  | "passport_score"
  | "allowlist"
  | "blocklist"
  | "custom";

/** A single eligibility criterion. */
export interface EligibilityCriterion {
  readonly type: EligibilityType;
  readonly operator: "gte" | "lte" | "eq" | "in" | "not_in";
  readonly value: unknown;
  readonly description?: string;
}

/** A campaign definition. */
export interface Campaign {
  readonly campaignId: string;
  readonly name: string;
  readonly description: string;
  readonly sponsor: string;
  readonly assetType: CampaignAssetType;
  readonly assetSymbol?: string;
  readonly assetContract?: string;
  readonly totalBudget: bigint;
  readonly perClaimAmount: bigint;
  readonly maxClaimsPerWallet: number;
  readonly status: CampaignStatus;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly eligibility: readonly EligibilityCriterion[];
  readonly requirePassport: boolean;
  readonly minPassportScore?: number;
  readonly allowlist?: readonly string[];
  readonly blocklist?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

/** A claim record. */
export interface Claim {
  readonly claimId: string;
  readonly campaignId: string;
  readonly recipient: string;
  readonly amount: bigint;
  readonly status: ClaimStatus;
  readonly reason?: string;
  readonly txHash?: string;
  readonly createdAt: number;
  readonly claimedAt?: number;
  readonly completedAt?: number;
}

/** The status of a claim. */
export type ClaimStatus = "pending" | "approved" | "rejected" | "completed" | "expired";

/** Campaign budget snapshot. */
export interface CampaignBudget {
  readonly campaignId: string;
  readonly totalBudget: bigint;
  readonly claimed: bigint;
  readonly pending: bigint;
  readonly completed: bigint;
  readonly rejected: bigint;
  readonly remaining: bigint;
  readonly claimsCount: number;
  readonly uniqueClaimants: number;
}

/** The result of an eligibility check. */
export interface EligibilityResult {
  readonly eligible: boolean;
  readonly reasons: string[];
}

/** The result of a claim attempt. */
export interface ClaimResult {
  readonly claim: Claim;
  readonly budget: CampaignBudget;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Server-authoritative campaign store. */
export interface CampaignStore {
  /** Create a new campaign. */
  create(campaign: Campaign): void;

  /** Get a campaign by ID. */
  get(campaignId: string): Campaign | undefined;

  /** List campaigns, optionally filtered by status. */
  list(status?: CampaignStatus): Campaign[];

  /** Update campaign status (e.g., draft → active, active → ended). */
  updateStatus(campaignId: string, status: CampaignStatus): Campaign | undefined;

  /** Add a claim record. */
  addClaim(claim: Claim): void;

  /** Get a claim by ID. */
  getClaim(claimId: string): Claim | undefined;

  /** List claims for a campaign. */
  listClaims(campaignId: string): Claim[];

  /** List claims for a wallet. */
  listClaimsByWallet(wallet: string): Claim[];

  /** Update claim status. */
  updateClaimStatus(claimId: string, status: ClaimStatus, txHash?: string): Claim | undefined;

  /** Get budget snapshot for a campaign. */
  budget(campaignId: string): CampaignBudget | null;
}

/**
 * Create an in-memory campaign store.
 *
 * Used for development, testing, and single-process deployments.
 * Production deployments should use a persistent backend (PostgreSQL/Redis).
 */
export function createCampaignStore(): CampaignStore {
  const campaigns = new Map<string, Campaign>();
  const claims = new Map<string, Claim>();
  const claimsByCampaign = new Map<string, string[]>();
  const claimsByWallet = new Map<string, string[]>();

  return {
    create(campaign) {
      if (campaigns.has(campaign.campaignId)) {
        throw new Error(`campaign already exists: ${campaign.campaignId}`);
      }
      campaigns.set(campaign.campaignId, campaign);
    },

    get(campaignId) {
      return campaigns.get(campaignId);
    },

    list(status) {
      const all = [...campaigns.values()];
      if (status) return all.filter((c) => c.status === status);
      return all;
    },

    updateStatus(campaignId, status) {
      const campaign = campaigns.get(campaignId);
      if (!campaign) return undefined;

      // Validate transitions
      if (!validTransition(campaign.status, status)) {
        throw new Error(
          `invalid campaign transition: ${campaign.status} → ${status}`,
        );
      }

      const updated: Campaign = {
        ...campaign,
        status,
        updatedAt: Date.now(),
      };
      campaigns.set(campaignId, updated);
      return updated;
    },

    addClaim(claim) {
      if (claims.has(claim.claimId)) {
        throw new Error(`claim already exists: ${claim.claimId}`);
      }
      claims.set(claim.claimId, claim);

      // Index by campaign
      const campaignClaims = claimsByCampaign.get(claim.campaignId) || [];
      campaignClaims.push(claim.claimId);
      claimsByCampaign.set(claim.campaignId, campaignClaims);

      // Index by wallet
      const walletClaims = claimsByWallet.get(claim.recipient) || [];
      walletClaims.push(claim.claimId);
      claimsByWallet.set(claim.recipient, walletClaims);
    },

    getClaim(claimId) {
      return claims.get(claimId);
    },

    listClaims(campaignId) {
      const claimIds = claimsByCampaign.get(campaignId) || [];
      return claimIds.map((id) => claims.get(id)!).filter(Boolean);
    },

    listClaimsByWallet(wallet) {
      const claimIds = claimsByWallet.get(wallet) || [];
      return claimIds.map((id) => claims.get(id)!).filter(Boolean);
    },

    updateClaimStatus(claimId, status, txHash) {
      const claim = claims.get(claimId);
      if (!claim) return undefined;

      const now = Date.now();
      const updated: Claim = {
        ...claim,
        status,
        claimedAt: status === "approved" ? now : claim.claimedAt,
        completedAt: status === "completed" ? now : claim.completedAt,
        txHash: txHash || claim.txHash,
      };
      claims.set(claimId, updated);
      return updated;
    },

    budget(campaignId) {
      const campaign = campaigns.get(campaignId);
      if (!campaign) return null;

      const campaignClaims = this.listClaims(campaignId);
      let claimed = 0n;
      let pending = 0n;
      let completed = 0n;
      let rejected = 0n;
      const uniqueClaimants = new Set<string>();

      for (const claim of campaignClaims) {
        uniqueClaimants.add(claim.recipient);
        switch (claim.status) {
          case "pending":
            pending += claim.amount;
            break;
          case "approved":
          case "completed":
            completed += claim.amount;
            claimed += claim.amount;
            break;
          case "rejected":
            rejected += claim.amount;
            break;
        }
      }

      return {
        campaignId,
        totalBudget: campaign.totalBudget,
        claimed,
        pending,
        completed,
        rejected,
        remaining: campaign.totalBudget - claimed - pending,
        claimsCount: campaignClaims.length,
        uniqueClaimants: uniqueClaimants.size,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Campaign lifecycle
// ---------------------------------------------------------------------------

/** Valid status transitions for a campaign. */
function validTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  const transitions: Record<CampaignStatus, CampaignStatus[]> = {
    draft: ["active", "ended"],
    active: ["paused", "ended", "depleted"],
    paused: ["active", "ended"],
    ended: [],
    depleted: ["ended"],
  };
  return (transitions[from] || []).includes(to);
}

/**
 * Create a new campaign definition.
 *
 * The sponsor is the wallet that created the campaign. The budget is the
 * total amount available for distribution. The claim window defines when
 * claims can be submitted.
 */
export function createCampaign(params: {
  name: string;
  description: string;
  sponsor: string;
  assetType: CampaignAssetType;
  assetSymbol?: string;
  assetContract?: string;
  totalBudget: bigint;
  perClaimAmount: bigint;
  maxClaimsPerWallet: number;
  startsAt: number;
  endsAt: number;
  eligibility?: readonly EligibilityCriterion[];
  requirePassport?: boolean;
  minPassportScore?: number;
  allowlist?: readonly string[];
  blocklist?: readonly string[];
  metadata?: Record<string, unknown>;
}): Campaign {
  const now = Date.now();
  const campaignId = `camp-${randomBytes(8).toString("hex")}`;

  if (params.totalBudget <= 0n) {
    throw new Error("campaign budget must be positive");
  }
  if (params.perClaimAmount <= 0n) {
    throw new Error("per-claim amount must be positive");
  }
  if (params.perClaimAmount > params.totalBudget) {
    throw new Error("per-claim amount cannot exceed total budget");
  }
  if (params.maxClaimsPerWallet < 1) {
    throw new Error("max claims per wallet must be at least 1");
  }
  if (params.startsAt >= params.endsAt) {
    throw new Error("claim window must have a valid start/end range");
  }
  if (params.endsAt <= now) {
    throw new Error("claim window end must be in the future");
  }

  return {
    campaignId,
    name: params.name,
    description: params.description,
    sponsor: params.sponsor.toLowerCase(),
    assetType: params.assetType,
    assetSymbol: params.assetSymbol,
    assetContract: params.assetContract,
    totalBudget: params.totalBudget,
    perClaimAmount: params.perClaimAmount,
    maxClaimsPerWallet: params.maxClaimsPerWallet,
    status: "draft",
    startsAt: params.startsAt,
    endsAt: params.endsAt,
    createdAt: now,
    updatedAt: now,
    eligibility: params.eligibility || [],
    requirePassport: params.requirePassport || false,
    minPassportScore: params.minPassportScore,
    allowlist: params.allowlist,
    blocklist: params.blocklist,
    metadata: params.metadata,
  };
}

// ---------------------------------------------------------------------------
// Eligibility engine
// ---------------------------------------------------------------------------

/**
 * Check whether a wallet is eligible to claim from a campaign.
 *
 * This is the server-authoritative check. The browser never computes
 * eligibility — it only displays the result.
 */
export function checkEligibility(
  campaign: Campaign,
  wallet: string,
  context: {
    walletAge?: number;
    trialCount?: number;
    reputation?: number;
    passportSignal?: PassportSignal;
  } = {},
): EligibilityResult {
  const reasons: string[] = [];
  const walletLower = wallet.toLowerCase();

  // Blocklist check (highest priority)
  if (campaign.blocklist && campaign.blocklist.length > 0) {
    if (campaign.blocklist.map((w) => w.toLowerCase()).includes(walletLower)) {
      return {
        eligible: false,
        reasons: ["Wallet is on the campaign blocklist"],
      };
    }
  }

  // Allowlist check
  if (campaign.allowlist && campaign.allowlist.length > 0) {
    if (!campaign.allowlist.map((w) => w.toLowerCase()).includes(walletLower)) {
      return {
        eligible: false,
        reasons: ["Wallet is not on the campaign allowlist"],
      };
    }
  }

  // Passport check
  if (campaign.requirePassport) {
    if (!context.passportSignal) {
      return {
        eligible: false,
        reasons: ["Campaign requires a passport check; none provided"],
      };
    }

    const ps = context.passportSignal;
    if (ps.sanctioned) {
      return {
        eligible: false,
        reasons: ["Wallet blocked by risk policy: sanctioned address"],
      };
    }

    if (campaign.minPassportScore != null) {
      if (ps.score == null) {
        return {
          eligible: false,
          reasons: ["Passport score unavailable"],
        };
      }
      if (ps.score < campaign.minPassportScore) {
        return {
          eligible: false,
          reasons: [
            `Passport score ${ps.score} below minimum ${campaign.minPassportScore}`,
          ],
        };
      }
    }
  }

  // Eligibility criteria checks
  for (const criterion of campaign.eligibility) {
    const passed = evaluateCriterion(criterion, context, walletLower);
    if (!passed) {
      reasons.push(
        criterion.description ||
          `Failed eligibility: ${criterion.type} ${criterion.operator}`,
      );
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons: reasons.length === 0 ? ["Eligible"] : reasons,
  };
}

/** Evaluate a single eligibility criterion. */
function evaluateCriterion(
  criterion: EligibilityCriterion,
  context: {
    walletAge?: number;
    trialCount?: number;
    reputation?: number;
    passportSignal?: PassportSignal;
  },
  wallet: string,
): boolean {
  let actual: number | undefined;

  switch (criterion.type) {
    case "wallet_age":
      actual = context.walletAge;
      break;
    case "trial_count":
      actual = context.trialCount;
      break;
    case "reputation_min":
      actual = context.reputation;
      break;
    case "passport_score":
      if (context.passportSignal) {
        actual = context.passportSignal.score ?? undefined;
      }
      break;
    case "allowlist":
      // Allowlist is handled at the campaign level
      return true;
    case "blocklist":
      // Blocklist is handled at the campaign level
      return true;
    case "custom":
      // Custom criteria are evaluated by the sponsor's logic
      return true;
    default:
      return false;
  }

  if (actual === undefined) {
    return false;
  }

  const value = Number(criterion.value);
  switch (criterion.operator) {
    case "gte":
      return actual >= value;
    case "lte":
      return actual <= value;
    case "eq":
      return actual === value;
    case "in":
      const arr = Array.isArray(criterion.value) ? (criterion.value as number[]) : [value];
      return arr.includes(actual);
    case "not_in":
      const notArr = Array.isArray(criterion.value)
        ? (criterion.value as number[])
        : [value];
      return !notArr.includes(actual);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Claim distributor
// ---------------------------------------------------------------------------

/**
 * The campaign distributor: the single source of truth for claim eligibility,
 * budget enforcement, and anti-Sybil controls.
 */
export class CampaignDistributor {
  private readonly store: CampaignStore;

  constructor(store: CampaignStore = createCampaignStore()) {
    this.store = store;
  }

  /** Create and register a new campaign. */
  createCampaign(params: Parameters<typeof createCampaign>[0]): Campaign {
    const campaign = createCampaign(params);
    this.store.create(campaign);
    return campaign;
  }

  /** Get a campaign by ID. */
  getCampaign(campaignId: string): Campaign | undefined {
    return this.store.get(campaignId);
  }

  /** List campaigns, optionally filtered by status. */
  listCampaigns(status?: CampaignStatus): Campaign[] {
    return this.store.list(status);
  }

  /** Update campaign status. */
  updateCampaignStatus(
    campaignId: string,
    status: CampaignStatus,
  ): Campaign | undefined {
    return this.store.updateStatus(campaignId, status);
  }

  /** Get budget snapshot for a campaign. */
  getBudget(campaignId: string): CampaignBudget | null {
    return this.store.budget(campaignId);
  }

  /**
   * Attempt a claim.
   *
   * This is the main entry point. It checks:
   * 1. Campaign exists and is active
   * 2. Claim window is open
   * 3. Budget has remaining funds
   * 4. Wallet is eligible
   * 5. Wallet hasn't exceeded max claims
   * 6. Anti-Sybil checks pass
   *
   * If all checks pass, a claim record is created with "pending" status.
   * The caller is responsible for executing the on-chain transfer and
   * updating the claim to "completed" with the transaction hash.
   */
  attemptClaim(
    campaignId: string,
    wallet: string,
    context: {
      walletAge?: number;
      trialCount?: number;
      reputation?: number;
      passportSignal?: PassportSignal;
    } = {},
  ): ClaimResult | { error: string; code: string } {
    const campaign = this.store.get(campaignId);
    if (!campaign) {
      return { error: "Campaign not found", code: "campaign_not_found" };
    }

    // Status check
    if (campaign.status !== "active") {
      return {
        error: `Campaign is not active (status: ${campaign.status})`,
        code: "campaign_not_active",
      };
    }

    // Claim window check
    const now = Date.now();
    if (now < campaign.startsAt) {
      return {
        error: "Claim window has not yet opened",
        code: "claim_window_not_open",
      };
    }
    if (now > campaign.endsAt) {
      return {
        error: "Claim window has closed",
        code: "claim_window_closed",
      };
    }

    // Budget check
    const budget = this.store.budget(campaignId);
    if (!budget || budget.remaining < campaign.perClaimAmount) {
      // Auto-transition to depleted if budget exhausted
      if (budget && budget.remaining < campaign.perClaimAmount) {
        this.store.updateStatus(campaignId, "depleted");
      }
      return { error: "Campaign budget depleted", code: "budget_depleted" };
    }

    // Per-wallet claim count check
    const walletClaims = this.store
      .listClaimsByWallet(wallet.toLowerCase())
      .filter(
        (c) =>
          c.campaignId === campaignId &&
          (c.status === "pending" || c.status === "approved" || c.status === "completed"),
      );
    if (walletClaims.length >= campaign.maxClaimsPerWallet) {
      return {
        error: `Maximum claims per wallet (${campaign.maxClaimsPerWallet}) reached`,
        code: "max_claims_reached",
      };
    }

    // Eligibility check
    const eligibility = checkEligibility(campaign, wallet, context);
    if (!eligibility.eligible) {
      return {
        error: `Not eligible: ${eligibility.reasons.join("; ")}`,
        code: "not_eligible",
      };
    }

    // All checks passed — create the claim
    const claimId = `claim-${randomBytes(8).toString("hex")}`;
    const claim: Claim = {
      claimId,
      campaignId,
      recipient: wallet.toLowerCase(),
      amount: campaign.perClaimAmount,
      status: "pending",
      createdAt: now,
    };

    this.store.addClaim(claim);
    const updatedBudget = this.store.budget(campaignId)!;

    return { claim, budget: updatedBudget };
  }

  /**
   * Complete a claim with a transaction hash.
   *
   * Called after the on-chain transfer is confirmed. Moves the claim
   * from "pending" to "completed".
   */
  completeClaim(
    claimId: string,
    txHash: string,
  ): Claim | { error: string; code: string } {
    const claim = this.store.getClaim(claimId);
    if (!claim) {
      return { error: "Claim not found", code: "claim_not_found" };
    }

    if (claim.status !== "pending") {
      return {
        error: `Claim is not pending (status: ${claim.status})`,
        code: "claim_not_pending",
      };
    }

    const updated = this.store.updateClaimStatus(claimId, "completed", txHash);
    if (!updated) {
      return { error: "Failed to update claim", code: "update_failed" };
    }

    return updated;
  }

  /**
   * Reject a claim with a reason.
   *
   * Called when a claim fails verification or the sponsor manually rejects it.
   */
  rejectClaim(
    claimId: string,
    reason: string,
  ): Claim | { error: string; code: string } {
    const claim = this.store.getClaim(claimId);
    if (!claim) {
      return { error: "Claim not found", code: "claim_not_found" };
    }

    if (claim.status !== "pending") {
      return {
        error: `Claim is not pending (status: ${claim.status})`,
        code: "claim_not_pending",
      };
    }

    const updated = this.store.updateClaimStatus(claimId, "rejected");
    if (!updated) {
      return { error: "Failed to update claim", code: "update_failed" };
    }

    return updated;
  }

  /**
   * List claims for a campaign (sponsor-only view).
   */
  listClaims(campaignId: string): Claim[] {
    return this.store.listClaims(campaignId);
  }

  /**
   * List claims for a wallet (self-view).
   */
  listClaimsByWallet(wallet: string): Claim[] {
    return this.store.listClaimsByWallet(wallet.toLowerCase());
  }

  /**
   * Check eligibility without creating a claim.
   *
   * Used by the UI to show whether a wallet can claim before attempting.
   */
  checkEligibility(
    campaignId: string,
    wallet: string,
    context: {
      walletAge?: number;
      trialCount?: number;
      reputation?: number;
      passportSignal?: PassportSignal;
    } = {},
  ): EligibilityResult | { error: string; code: string } {
    const campaign = this.store.get(campaignId);
    if (!campaign) {
      return { error: "Campaign not found", code: "campaign_not_found" };
    }

    return checkEligibility(campaign, wallet, context);
  }
}

/**
 * Reset the campaign store for tests.
 *
 * Called by test setup to clear all campaigns and claims.
 */
export function resetCampaignStoreForTests(): CampaignStore {
  return createCampaignStore();
}
