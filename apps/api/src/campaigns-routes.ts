/**
 * @file campaigns-routes.ts — Campaign and airdrop API routes (REW-003).
 *
 * Mounted as a Hono sub-app under `/campaigns`. All routes are session-gated
 * except the public list endpoint. The distributor is the single source of
 * truth — the routes only translate HTTP to domain calls.
 */

import { Hono, type Context } from "hono";
import {
  CampaignDistributor,
  createCampaignStore,
  type Campaign,
  type CampaignStatus,
  type CampaignAssetType,
  type EligibilityCriterion,
  type ClaimResult,
  type EligibilityResult,
} from "./campaigns.js";
import type { PassportSignal } from "./identity.js";
import { verifiedSessionFromContext } from "./auth.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The eligibility signals for one wallet, as derived by the host. Every value
 * is computed server-side from authoritative state; the request body is never
 * a source for any of them, and a missing signal fails a criterion closed.
 */
export interface CampaignEligibilitySignals {
  walletAge?: number;
  trialCount?: number;
  reputation?: number;
  passportSignal?: PassportSignal;
}

export interface CampaignsConfig {
  /** The distributor instance. Defaults to a new in-memory store. */
  distributor?: CampaignDistributor;
  /** Wallets allowed to create campaigns. Empty means any authenticated user. */
  allowedSponsors?: readonly string[];
  /** Maximum budget per campaign (in wei). 0 means unlimited. */
  maxBudgetWei?: bigint;
  /**
   * Derives the eligibility signals for a wallet from authoritative state
   * (read model, chain clock, Passport source). Unset means no signals exist:
   * campaigns with signal-dependent criteria fail closed rather than trusting
   * a caller's claim.
   */
  signals?: (wallet: string) => Promise<CampaignEligibilitySignals> | CampaignEligibilitySignals;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function createCampaignRoutes(config: CampaignsConfig = {}): Hono {
  const distributor = config.distributor || new CampaignDistributor();
  const app = new Hono();

  /**
   * Get claims for the authenticated wallet. Session-gated, self-only.
   * Hono matches in registration order — this MUST come before
   * /:campaignId so "my" is never read as a campaign ID.
   */
  app.get("/my/claims", (c) => {
    const mySession = verifiedSessionFromContext(c);
    if (!mySession) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }

    const myClaims = distributor.listClaimsByWallet(mySession.payload.address);
    return c.json({
      claims: myClaims.map((claim) => ({
        claimId: claim.claimId,
        campaignId: claim.campaignId,
        amount: claim.amount.toString(),
        status: claim.status,
        txHash: claim.txHash,
        createdAt: claim.createdAt,
        claimedAt: claim.claimedAt,
        completedAt: claim.completedAt,
      })),
    });
  });

  /**
   * List campaigns.
   *
   * Public endpoint: anyone can browse available campaigns.
   * Optional status filter via query parameter.
   */
  app.get("/", (c) => {
    const status = c.req.query("status") as CampaignStatus | undefined;
    const campaigns = distributor.listCampaigns(status);
    return c.json({
      campaigns: campaigns.map((camp) => ({
        campaignId: camp.campaignId,
        name: camp.name,
        description: camp.description,
        sponsor: camp.sponsor,
        assetType: camp.assetType,
        chain: camp.chain,
        cluster: camp.cluster,
        assetSymbol: camp.assetSymbol,
        status: camp.status,
        totalBudget: camp.totalBudget.toString(),
        perClaimAmount: camp.perClaimAmount.toString(),
        maxClaimsPerWallet: camp.maxClaimsPerWallet,
        startsAt: camp.startsAt,
        endsAt: camp.endsAt,
        createdAt: camp.createdAt,
      })),
    });
  });

  /**
   * Get a campaign by ID.
   *
   * Public endpoint: anyone can inspect a campaign's details.
   */
  app.get("/:campaignId", (c) => {
    const campaignId = c.req.param("campaignId");
    const campaign = distributor.getCampaign(campaignId);
    if (!campaign) {
      return c.json({ error: "Campaign not found", code: "not_found" }, 404);
    }

    const budget = distributor.getBudget(campaignId);
    return c.json({
      campaign: {
        campaignId: campaign.campaignId,
        name: campaign.name,
        description: campaign.description,
        sponsor: campaign.sponsor,
        assetType: campaign.assetType,
        chain: campaign.chain,
        cluster: campaign.cluster,
        assetSymbol: campaign.assetSymbol,
        assetContract: campaign.assetContract,
        status: campaign.status,
        totalBudget: campaign.totalBudget.toString(),
        perClaimAmount: campaign.perClaimAmount.toString(),
        maxClaimsPerWallet: campaign.maxClaimsPerWallet,
        startsAt: campaign.startsAt,
        endsAt: campaign.endsAt,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
        eligibility: campaign.eligibility,
        requirePassport: campaign.requirePassport,
        minPassportScore: campaign.minPassportScore,
        metadata: campaign.metadata,
      },
      budget: budget
        ? {
            remaining: budget.remaining.toString(),
            claimed: budget.claimed.toString(),
            pending: budget.pending.toString(),
            claimsCount: budget.claimsCount,
            uniqueClaimants: budget.uniqueClaimants,
          }
        : null,
    });
  });

  /**
   * Create a new campaign.
   *
   * Session-gated: only authenticated users can create campaigns.
   * If allowedSponsors is configured, only those wallets can create.
   */
  app.post("/", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }

    // Sponsor allowlist check
    if (config.allowedSponsors && config.allowedSponsors.length > 0) {
      const sponsorLower = session.payload.address.toLowerCase();
      const allowed = config.allowedSponsors.map((s) => s.toLowerCase());
      if (!allowed.includes(sponsorLower)) {
        return c.json(
          { error: "Not authorized to create campaigns", code: "forbidden" },
          403,
        );
      }
    }

    let body: {
      name?: string;
      description?: string;
      assetType?: CampaignAssetType;
      chain?: "evm" | "solana";
      cluster?: string;
      assetSymbol?: string;
      assetContract?: string;
      totalBudget?: string;
      perClaimAmount?: string;
      maxClaimsPerWallet?: number;
      startsAt?: number;
      endsAt?: number;
      eligibility?: EligibilityCriterion[];
      requirePassport?: boolean;
      minPassportScore?: number;
      allowlist?: string[];
      blocklist?: string[];
      metadata?: Record<string, unknown>;
    } = {};

    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body", code: "bad-request" }, 400);
    }

    // Validate required fields
    if (!body.name || !body.name.trim()) {
      return c.json({ error: "name is required", code: "bad-request" }, 400);
    }
    if (!body.assetType) {
      return c.json({ error: "assetType is required", code: "bad-request" }, 400);
    }
    if (!body.totalBudget || !body.perClaimAmount) {
      return c.json(
        { error: "totalBudget and perClaimAmount are required", code: "bad-request" },
        400,
      );
    }

    let totalBudget: bigint;
    let perClaimAmount: bigint;
    try {
      totalBudget = BigInt(body.totalBudget);
      perClaimAmount = BigInt(body.perClaimAmount);
    } catch {
      return c.json(
        { error: "totalBudget and perClaimAmount must be whole numbers", code: "bad-request" },
        400,
      );
    }

    // Max budget check
    if (config.maxBudgetWei && totalBudget > config.maxBudgetWei) {
      return c.json(
        {
          error: `Budget exceeds maximum (${config.maxBudgetWei.toString()} wei)`,
          code: "budget_exceeded",
        },
        400,
      );
    }

    if (!body.startsAt || !body.endsAt) {
      return c.json(
        { error: "startsAt and endsAt are required", code: "bad-request" },
        400,
      );
    }

    try {
      const campaign = distributor.createCampaign({
        name: body.name.trim(),
        description: body.description?.trim() || "",
        sponsor: session.payload.address,
        assetType: body.assetType,
        chain: body.chain,
        cluster: body.cluster,
        assetSymbol: body.assetSymbol,
        assetContract: body.assetContract,
        totalBudget,
        perClaimAmount,
        maxClaimsPerWallet: body.maxClaimsPerWallet || 1,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        eligibility: body.eligibility,
        requirePassport: body.requirePassport,
        minPassportScore: body.minPassportScore,
        allowlist: body.allowlist,
        blocklist: body.blocklist,
        metadata: body.metadata,
      });

      return c.json(
        {
          campaign: {
            campaignId: campaign.campaignId,
            name: campaign.name,
            status: campaign.status,
            sponsor: campaign.sponsor,
            chain: campaign.chain,
            cluster: campaign.cluster,
            createdAt: campaign.createdAt,
          },
        },
        201,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg, code: "bad-request" }, 400);
    }
  });

  /**
   * Update campaign status.
   *
   * Session-gated: only the campaign's sponsor can update its status.
   */
  app.patch("/:campaignId/status", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }

    const campaignId = c.req.param("campaignId");
    const campaign = distributor.getCampaign(campaignId);
    if (!campaign) {
      return c.json({ error: "Campaign not found", code: "not_found" }, 404);
    }

    // Sponsor-only
    if (campaign.sponsor.toLowerCase() !== session.payload.address.toLowerCase()) {
      return c.json(
        { error: "Only the campaign sponsor can update status", code: "forbidden" },
        403,
      );
    }

    let body: { status?: CampaignStatus } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body", code: "bad-request" }, 400);
    }

    if (!body.status) {
      return c.json({ error: "status is required", code: "bad-request" }, 400);
    }

    try {
      const updated = distributor.updateCampaignStatus(campaignId, body.status);
      if (!updated) {
        return c.json({ error: "Status update failed", code: "failed" }, 500);
      }

      return c.json({
        campaign: {
          campaignId: updated.campaignId,
          status: updated.status,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg, code: "bad-request" }, 400);
    }
  });

  /**
   * Get campaign budget.
   *
   * Public endpoint: anyone can check the remaining budget.
   */
  app.get("/:campaignId/budget", (c) => {
    const campaignId = c.req.param("campaignId");
    const budget = distributor.getBudget(campaignId);
    if (!budget) {
      return c.json({ error: "Campaign not found", code: "not_found" }, 404);
    }

    return c.json({
      campaignId: budget.campaignId,
      totalBudget: budget.totalBudget.toString(),
      claimed: budget.claimed.toString(),
      pending: budget.pending.toString(),
      completed: budget.completed.toString(),
      rejected: budget.rejected.toString(),
      remaining: budget.remaining.toString(),
      claimsCount: budget.claimsCount,
      uniqueClaimants: budget.uniqueClaimants,
    });
  });

  /**
   * Check eligibility for a campaign.
   *
   * Session-gated: the caller checks their own eligibility. The eligibility
   * signals are derived server-side from authoritative state; a client-supplied
   * value is never a source for any of them.
   */
  app.post("/:campaignId/eligibility", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }

    const campaignId = c.req.param("campaignId");
    const signals = config.signals ? await config.signals(session.payload.address) : {};

    const result = distributor.checkEligibility(campaignId, session.payload.address, signals);

    if ("error" in result) {
      return c.json(result, 400);
    }

    return c.json({
      eligible: result.eligible,
      reasons: result.reasons,
    });
  });

  /**
   * Attempt a claim.
   *
   * Session-gated: the caller claims for their own wallet. The eligibility
   * signals are derived server-side from authoritative state; a client-supplied
   * value is never a source for any of them.
   */
  app.post("/:campaignId/claim", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }

    const campaignId = c.req.param("campaignId");
    const signals = config.signals ? await config.signals(session.payload.address) : {};

    const result = distributor.attemptClaim(campaignId, session.payload.address, signals);

    if ("error" in result) {
      const status = result.code === "campaign_not_found" ? 404 : 400;
      return c.json({ error: result.error, code: result.code }, status);
    }

    return c.json(
      {
        claim: {
          claimId: result.claim.claimId,
          campaignId: result.claim.campaignId,
          recipient: result.claim.recipient,
          amount: result.claim.amount.toString(),
          status: result.claim.status,
          createdAt: result.claim.createdAt,
        },
        budget: {
          remaining: result.budget.remaining.toString(),
          claimsCount: result.budget.claimsCount,
        },
      },
      201,
    );
  });

  /**
   * Get claims for a campaign.
   *
   * Session-gated: only the campaign's sponsor can view all claims.
   */
  app.get("/:campaignId/claims", (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }

    const campaignId = c.req.param("campaignId");
    const campaign = distributor.getCampaign(campaignId);
    if (!campaign) {
      return c.json({ error: "Campaign not found", code: "not_found" }, 404);
    }

    // Sponsor-only for full claims list
    if (campaign.sponsor.toLowerCase() !== session.payload.address.toLowerCase()) {
      return c.json(
        { error: "Only the campaign sponsor can view claims", code: "forbidden" },
        403,
      );
    }

    const claims = distributor.listClaims(campaignId);
    return c.json({
      claims: claims.map((claim) => ({
        claimId: claim.claimId,
        recipient: claim.recipient,
        amount: claim.amount.toString(),
        status: claim.status,
        txHash: claim.txHash,
        createdAt: claim.createdAt,
        claimedAt: claim.claimedAt,
        completedAt: claim.completedAt,
      })),
    });
  });

  return app;
}
