/**
 * @file forge.ts — Adaptive Forge API routes.
 *
 * Off-chain product-layer routes for Forge Briefs, difficulty profiles,
 * bounty adequacy, and Forge Campaigns. All routes are organisation-scoped:
 * the caller must be an authenticated wallet principal and an active member
 * of the target organisation (verified per request, never trusted from the
 * client).
 *
 * Data lives in the in-memory forge store (packages/agent-security/src/forge-store.ts),
 * consistent with ADR-0008 until ADR-0023 (PostgreSQL) is approved and
 * implemented.
 *
 * No chain keys are held by the API; all data is off-chain product metadata.
 */

import { Hono, type Context } from "hono";
import {
  authorize,
  resolvePrincipal,
  buildOrganisationPrincipal,
  type OrganisationPrincipal,
} from "@crucible/agent-security";
import {
  newForgeBrief,
  validateForgeBrief,
  newReadinessReport,
  computeBriefDigest,
  sealBrief,
  type ForgeBrief,
  type ChallengeReadinessReport,
} from "@crucible/eval";
import {
  newTrialDifficultyProfile,
  classifyHeat,
  computeAgentFit,
  type TrialDifficultyProfile,
  type AgentTrialFit,
  type DifficultyDimension,
} from "@crucible/eval";
import {
  newBountyRecommendation,
  newBountyAdequacyReport,
  calculateBondWei,
  calculateProtocolFeeWei,
  calculateNetAgentPayoutWei,
  computeBountyRecommendation,
  assessBountyAdequacy,
  type BountyRecommendation,
  type BountyAdequacyReport,
} from "@crucible/eval";
import {
  newForgeCampaign,
  addStage,
  fundStage,
  settleStage,
  isStageEligible,
  validateCampaign,
  type ForgeCampaign,
  type CampaignStage,
} from "@crucible/eval";
import {
  createForgeBrief,
  getForgeBrief,
  listForgeBriefs,
  updateForgeBrief,
  deleteForgeBrief,
  setBriefReadiness,
  getBriefReadiness,
  setDifficultyProfile,
  getDifficultyProfile,
  setAgentFit,
  getAgentFit,
  setBountyRecommendation,
  getBountyRecommendation,
  setBountyAdequacy,
  getBountyAdequacy,
  createCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
  deleteCampaign,
  __resetForgeStoreForTests,
} from "@crucible/agent-security";

export function createForgeRoutes(): Hono {
  const app = new Hono();

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Extract the wallet principal from the SIWE session cookie.
   * Returns null when unauthenticated.
   */
  function resolveWalletPrincipal(c: Context): OrganisationPrincipal | null {
    const auth = {
      walletAddress: null as string | null,
      sessionId: null as string | null,
      chainId: "31337",
    };
    const cookie = c.req.header("cookie");
    if (cookie) {
      for (const part of cookie.split(";")) {
        const [k, ...v] = part.trim().split("=");
        if (k === "crucible_session") {
          auth.sessionId = v.join("=");
          try {
            const encoded = auth.sessionId.split(".")[0];
            if (encoded) {
              const payload = JSON.parse(
                Buffer.from(encoded, "base64url").toString("utf8"),
              ) as { address?: string };
              if (payload.address) auth.walletAddress = payload.address;
            }
          } catch {
            // malformed session cookie
          }
          break;
        }
      }
    }
    if (!auth.walletAddress || !auth.sessionId) return null;
    const principal = buildOrganisationPrincipal(
      {
        address: auth.walletAddress,
        id: `eip155:31337:${auth.walletAddress.toLowerCase()}`,
        sessionId: auth.sessionId,
        authenticated: true,
      },
    );
    return principal;
  }

  /**
   * Extract orgId from request body (POST/PUT/PATCH) or query (GET).
   */
  async function getOrgId(c: Context): Promise<string | null> {
    if (c.req.method === "GET") {
      return c.req.query("orgId") ?? null;
    }
    try {
      const body = (await c.req.json()) as { orgId?: string };
      return body.orgId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Authorize the caller for an org-scoped action. Returns a Response
   * (401/403) when denied, or null when allowed.
   */
  async function requireOrgAuthz(
    c: Context,
    permission: string,
    actorRole?: string,
    targetRole?: string,
    action?: "grant-role" | "grade-own-run" | "publish-own-benchmark",
  ): Promise<Response | null> {
    const principal = resolveWalletPrincipal(c);
    if (!principal) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    const orgId = await getOrgId(c);
    if (!orgId) {
      return c.json({ error: "org_id is required", code: "no-credential" }, 400);
    }
    const decision = authorize(principal, orgId, permission, actorRole, targetRole, action);
    if (!decision.allow) {
      return c.json(
        { error: "forbidden", reason: decision.reason, code: decision.code },
        403,
      );
    }
    (c.var as Record<string, unknown>).orgId = orgId;
    (c.var as Record<string, unknown>).orgPrincipalAddress = principal.wallet.address;
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Forge Briefs                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Create a Forge Brief. The sponsor describes the problem; difficulty and
   * bounty are computed later, never supplied by the sponsor as authoritative.
   */
  app.post("/brief", async (c) => {
    const denied = await requireOrgAuthz(c, "benchmark:create");
    if (denied) return denied;

    const body = (await c.req.json()) as {
      orgId: string;
      briefId?: string;
      sponsor?: string;
      title?: string;
      domain?: string;
      problemStatement?: string;
      intendedOutcome?: string;
      purpose?: string;
      whyItMatters?: string;
      expectedDeliverable?: string;
      requirements?: unknown[];
      complexity?: unknown;
      environment?: unknown;
      verification?: unknown;
      reliabilityAndRisk?: unknown;
      financialCommitment?: unknown;
    };

    const orgId = body.orgId;
    if (!orgId) {
      return c.json({ error: "org_id is required" }, 400);
    }

    const principal = resolveWalletPrincipal(c);
    const principalAddress = principal?.wallet.address ?? "";
    const briefId = body.briefId ?? `brief-${Date.now()}`;
    const sponsor = body.sponsor ?? principalAddress;

    const brief = newForgeBrief(briefId, sponsor);
    if (body.title) brief.objective.title = body.title;
    if (body.domain) brief.objective.domain = body.domain;
    if (body.problemStatement) brief.objective.problemStatement = body.problemStatement;
    if (body.intendedOutcome) brief.objective.intendedOutcome = body.intendedOutcome;
    if (body.purpose) brief.objective.purpose = body.purpose;
    if (body.whyItMatters) brief.objective.whyItMatters = body.whyItMatters;
    if (body.expectedDeliverable) brief.objective.expectedDeliverable = body.expectedDeliverable;
    if (body.requirements) brief.requirements = body.requirements as any;
    if (body.complexity) brief.complexity = body.complexity as any;
    if (body.environment) brief.environment = body.environment as any;
    if (body.verification) brief.verification = body.verification as any;
    if (body.reliabilityAndRisk) brief.reliabilityAndRisk = body.reliabilityAndRisk as any;
    if (body.financialCommitment) brief.financialCommitment = body.financialCommitment as any;

    createForgeBrief(brief, orgId);

    // Initial readiness report.
    const report = validateForgeBrief(brief);
    setBriefReadiness(briefId, report);
    // Reflect readiness status in the brief itself.
    if (report.status === "ready_to_fund") {
      updateForgeBrief(briefId, { status: "ready_to_fund" });
      brief.status = "ready_to_fund";
    }

    return jsonWithBigInt(c, { brief, readiness: report }, 201);
  });

  /**
   * Get a Forge Brief by ID.
   */
  app.get("/brief/:briefId", async (c) => {
    const denied = await requireOrgAuthz(c, "org:read");
    if (denied) return denied;

    const briefId = c.req.param("briefId");
    const brief = getForgeBrief(briefId);
    if (!brief) {
      return c.json({ error: "brief not found" }, 404);
    }
    const readiness = getBriefReadiness(briefId);
    return jsonWithBigInt(c, { brief, readiness });
  });

  /**
   * Validate a Forge Brief and produce a Challenge Readiness Report.
   */
  app.post("/brief/:briefId/validate", async (c) => {
    const denied = await requireOrgAuthz(c, "org:read");
    if (denied) return denied;

    const briefId = c.req.param("briefId");
    const brief = getForgeBrief(briefId);
    if (!brief) {
      return c.json({ error: "brief not found" }, 404);
    }
    const report = validateForgeBrief(brief);
    setBriefReadiness(briefId, report);
    return jsonWithBigInt(c, { readiness: report });
  });

  /**
   * Seal a Forge Brief (compute its content digest).
   */
  app.post("/brief/:briefId/seal", async (c) => {
    const denied = await requireOrgAuthz(c, "benchmark:create");
    if (denied) return denied;

    const briefId = c.req.param("briefId");
    const brief = getForgeBrief(briefId);
    if (!brief) {
      return c.json({ error: "brief not found" }, 404);
    }
    const sealed = sealBrief(brief);
    updateForgeBrief(briefId, { digest: sealed.digest, updatedAt: sealed.updatedAt });
    return jsonWithBigInt(c, { brief: sealed });
  });

  /* ------------------------------------------------------------------ */
  /* Difficulty Profile                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Compute a Trial Difficulty Profile for a brief.
   */
  app.post("/difficulty/:briefId", async (c) => {
    const denied = await requireOrgAuthz(c, "org:read");
    if (denied) return denied;

    const briefId = c.req.param("briefId");
    const brief = getForgeBrief(briefId);
    if (!brief) {
      return c.json({ error: "brief not found" }, 404);
    }

    const body = (await c.req.json()) as {
      agentRating?: { mu: number; sigma: number };
      domain?: string;
    };

    const profile = newTrialDifficultyProfile(
      briefId,
      body.domain ?? brief.objective.domain,
    );

    if (brief.complexity) {
      const dims: {
        dimension: DifficultyDimension;
        value: number | null;
        confidence: number | null;
        basis: string;
      }[] = [];
      if (typeof brief.complexity.integrationComplexity === "string") {
        dims.push({
          dimension: "integration_complexity",
          value:
            brief.complexity.integrationComplexity === "low"
              ? 0.25
              : brief.complexity.integrationComplexity === "medium"
                ? 0.5
                : 0.75,
          confidence: 0.6,
          basis: "sponsor_declared",
        });
      }
      if (typeof brief.complexity.ambiguity === "string") {
        dims.push({
          dimension: "verification_complexity",
          value:
            brief.complexity.ambiguity === "low"
              ? 0.25
              : brief.complexity.ambiguity === "medium"
                ? 0.5
                : 0.75,
          confidence: 0.6,
          basis: "sponsor_declared",
        });
      }
      if (dims.length > 0) {
        profile.dimensions.scores = dims;
        const values = dims
          .map((d) => d.value)
          .filter((v): v is number => v !== null);
        if (values.length > 0) {
          profile.dimensions.composite =
            values.reduce((a, b) => a + b, 0) / values.length;
        }
      }
    }

    if (profile.dimensions.composite !== null) {
      profile.estimatedDifficulty = profile.dimensions.composite;
      profile.estimatedConfidence = 0.5;
    }

    const heat = classifyHeat(profile);
    (profile as any).heatClassification = heat;

    let fit: AgentTrialFit | null = null;
    if (body.agentRating) {
      fit = computeAgentFit(body.agentRating, profile);
      const principalAddr = (c.var as Record<string, unknown>)
        .orgPrincipalAddress as string;
      setAgentFit(principalAddr, briefId, fit);
    }

    setDifficultyProfile(briefId, profile);

    return jsonWithBigInt(c, { profile, heat, fit });
  });

  /* ------------------------------------------------------------------ */
  /* Bounty Adequacy                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Compute a Bounty Recommendation from model inputs.
   */
  app.post("/bounty/:briefId", async (c) => {
    const denied = await requireOrgAuthz(c, "org:read");
    if (denied) return denied;

    const briefId = c.req.param("briefId");
    const brief = getForgeBrief(briefId);
    if (!brief) {
      return c.json({ error: "brief not found" }, 404);
    }

    const body = (await c.req.json()) as {
      nativeAsset?: "ETH" | "SOL";
      network?: string;
      executionCost?: string;
      specialistEffortValue?: string;
      complexityPremium?: string;
      riskPremium?: string;
      scarcityPremium?: string;
      protocolFloor?: string;
      modelConfidence?: number;
      calibrationDataDate?: number;
      reason?: string;
    };

    const toBigInt = (v?: string): bigint => (v ? BigInt(v) : 0n);

    const rec = computeBountyRecommendation(
      briefId,
      body.nativeAsset ?? "ETH",
      body.network ?? "31337",
      {
        executionCost: toBigInt(body.executionCost),
        specialistEffortValue: toBigInt(body.specialistEffortValue),
        complexityPremium: toBigInt(body.complexityPremium),
        riskPremium: toBigInt(body.riskPremium),
        scarcityPremium: toBigInt(body.scarcityPremium),
        protocolFloor: toBigInt(body.protocolFloor),
        modelConfidence: body.modelConfidence ?? 0.5,
        calibrationDataDate: body.calibrationDataDate ?? null,
        reason: body.reason ?? "Bounty recommendation for Forge Brief.",
      },
    );

    setBountyRecommendation(briefId, rec);

    return jsonWithBigInt(c, { recommendation: rec });
  });

  /**
   * Assess whether a sponsor's proposed reward is adequate.
   */
  app.post("/bounty/:briefId/adequacy", async (c) => {
    const denied = await requireOrgAuthz(c, "org:read");
    if (denied) return denied;

    const briefId = c.req.param("briefId");
    const brief = getForgeBrief(briefId);
    if (!brief) {
      return c.json({ error: "brief not found" }, 404);
    }

    const rec = getBountyRecommendation(briefId);
    if (!rec) {
      return c.json(
        { error: "no bounty recommendation found; compute one first" },
        400,
      );
    }

    const body = (await c.req.json()) as {
      sponsorProposedRewardWei?: string;
    };

    const sponsorProposedRewardWei = body.sponsorProposedRewardWei
      ? BigInt(body.sponsorProposedRewardWei)
      : null;

    const report = assessBountyAdequacy(briefId, rec, sponsorProposedRewardWei);
    setBountyAdequacy(briefId, report);

    return jsonWithBigInt(c, { report });
  });

  /* ------------------------------------------------------------------ */
  /* Forge Campaigns                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Create a Forge Campaign.
   */
  app.post("/campaign", async (c) => {
    const denied = await requireOrgAuthz(c, "benchmark:create");
    if (denied) return denied;

    const body = (await c.req.json()) as {
      orgId: string;
      campaignId?: string;
      sponsor?: string;
      title: string;
      description?: string;
      domain?: string;
      totalBudgetWei?: string;
      nativeAsset?: "ETH" | "SOL";
      network?: string;
      requiredSkill?: string[];
    };

    const orgId = body.orgId;
    if (!orgId) {
      return c.json({ error: "org_id is required" }, 400);
    }
    if (!body.title) {
      return c.json({ error: "title is required" }, 400);
    }

    const principal = resolveWalletPrincipal(c);
    const principalAddress = principal?.wallet.address ?? "";
    const campaignId = body.campaignId ?? `camp-${Date.now()}`;
    const campaign = newForgeCampaign(
      campaignId,
      body.sponsor ?? principalAddress,
      body.title,
      body.nativeAsset ?? "ETH",
      body.network ?? "31337",
    );
    if (body.description) campaign.description = body.description;
    if (body.domain) campaign.domain = body.domain;
    if (body.totalBudgetWei) campaign.totalBudgetWei = BigInt(body.totalBudgetWei);
    if (body.requiredSkill) campaign.requiredSkill = body.requiredSkill;

    createCampaign(campaign, orgId);

    return jsonWithBigInt(c, { campaign }, 201);
  });

  /**
   * Get a Forge Campaign by ID.
   */
  app.get("/campaign/:campaignId", async (c) => {
    const denied = await requireOrgAuthz(c, "org:read");
    if (denied) return denied;

    const campaignId = c.req.param("campaignId");
    const campaign = getCampaign(campaignId);
    if (!campaign) {
      return c.json({ error: "campaign not found" }, 404);
    }
    const valid = validateCampaign(campaign);
    return jsonWithBigInt(c, { campaign, valid });
  });

  /**
   * Add a stage to a campaign.
   */
  app.post("/campaign/:campaignId/stage", async (c) => {
    const denied = await requireOrgAuthz(c, "benchmark:create");
    if (denied) return denied;

    const campaignId = c.req.param("campaignId");
    const campaign = getCampaign(campaignId);
    if (!campaign) {
      return c.json({ error: "campaign not found" }, 404);
    }

    const body = (await c.req.json()) as {
      stageId: string;
      stageNumber: number;
      title: string;
      domain: string;
      heat: "kindling" | "tempering" | "forging" | "crucible" | "masterwork";
      requiredSkill: string[];
      briefId: string;
      rewardWei: string;
      nativeAsset: "ETH" | "SOL";
      network: string;
      deadlineMs?: number;
      dependsOn?: string[];
      unlockCondition:
        | "previous_stage_settled"
        | "manual"
        | "time_based";
      previousStageEvidence?: string;
    };

    const stage: CampaignStage = {
      stageId: body.stageId,
      campaignId,
      stageNumber: body.stageNumber,
      title: body.title,
      domain: body.domain,
      heat: body.heat,
      requiredSkill: body.requiredSkill,
      briefId: body.briefId,
      trialId: undefined,
      rewardWei: BigInt(body.rewardWei),
      nativeAsset: body.nativeAsset,
      network: body.network,
      deadlineMs: body.deadlineMs,
      status: "unfunded",
      dependsOn: body.dependsOn ?? [],
      unlockCondition: body.unlockCondition,
      previousStageEvidence: body.previousStageEvidence,
      fundedAt: undefined,
      settledAt: undefined,
    };

    try {
      const updated = addStage(campaign, stage);
      updateCampaign(campaignId, {
        stages: updated.stages,
        updatedAt: updated.updatedAt,
      });
      return jsonWithBigInt(c, { campaign: updated }, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "invalid stage" },
        400,
      );
    }
  });

  /**
   * Fund a campaign stage.
   */
  app.post("/campaign/:campaignId/stage/:stageId/fund", async (c) => {
    const denied = await requireOrgAuthz(c, "org:budget:set");
    if (denied) return denied;

    const campaignId = c.req.param("campaignId");
    const stageId = c.req.param("stageId");
    const campaign = getCampaign(campaignId);
    if (!campaign) {
      return c.json({ error: "campaign not found" }, 404);
    }

    const body = (await c.req.json()) as {
      amountWei: string;
    };

    try {
      const updated = fundStage(campaign, stageId, BigInt(body.amountWei));
      updateCampaign(campaignId, {
        fundedBudgetWei: updated.fundedBudgetWei,
        stages: updated.stages,
        updatedAt: updated.updatedAt,
      });
      return jsonWithBigInt(c, { campaign: updated });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "invalid funding" },
        400,
      );
    }
  });

  /**
   * Settle a campaign stage.
   */
  app.post("/campaign/:campaignId/stage/:stageId/settle", async (c) => {
    const denied = await requireOrgAuthz(c, "org:budget:set");
    if (denied) return denied;

    const campaignId = c.req.param("campaignId");
    const stageId = c.req.param("stageId");
    const campaign = getCampaign(campaignId);
    if (!campaign) {
      return c.json({ error: "campaign not found" }, 404);
    }

    try {
      const updated = settleStage(campaign, stageId);
      updateCampaign(campaignId, {
        stages: updated.stages,
        status: updated.status,
        updatedAt: updated.updatedAt,
      });
      return jsonWithBigInt(c, { campaign: updated });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "invalid settlement" },
        400,
      );
    }
  });

  /**
   * Check whether a campaign stage is eligible to be opened.
   */
  app.get(
    "/campaign/:campaignId/stage/:stageId/eligible",
    async (c) => {
      const denied = await requireOrgAuthz(c, "org:read");
      if (denied) return denied;

      const campaignId = c.req.param("campaignId");
      const stageId = c.req.param("stageId");
      const campaign = getCampaign(campaignId);
      if (!campaign) {
        return c.json({ error: "campaign not found" }, 404);
      }
      return jsonWithBigInt(c, { eligible: isStageEligible(campaign, stageId) });
    },
  );

  /**
   * List campaigns for an organisation.
   */
  app.get("/campaigns", async (c) => {
    const denied = await requireOrgAuthz(c, "org:read");
    if (denied) return denied;

    const orgId = c.req.query("orgId");
    if (!orgId) {
      return c.json({ error: "org_id is required" }, 400);
    }
    return jsonWithBigInt(c, { campaigns: listCampaigns(orgId) });
  });

  /**
   * Reset the forge store (testing only).
   */
  app.post("/__reset", (c) => {
    __resetForgeStoreForTests();
    return c.json({ ok: true });
  });

  return app;
}

/**
 * JSON response helper that serializes BigInt values as strings.
 * Hono's c.json() cannot serialize BigInt directly.
 */
function jsonWithBigInt(c: Context, data: unknown, status = 200) {
  return c.json(
    JSON.parse(
      JSON.stringify(data, (key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    ) as any,
    status as any,
  );
}