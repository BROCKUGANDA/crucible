/**
 * @file forge-store.ts — In-memory store for Adaptive Forge off-chain data.
 *
 * Forge Briefs, Difficulty Profiles, Bounty Recommendations, and Campaigns are
 * off-chain product-layer data owned by an organization. They are stored in
 * memory consistent with ADR-0008 until ADR-0023 (PostgreSQL) is approved and
 * implemented.
 *
 * All lookups return absent when a record does not exist — never fabricated.
 */

import type {
  ForgeBrief,
  ForgeBriefStatus,
  ChallengeReadinessReport,
} from "@crucible/eval";
import type {
  TrialDifficultyProfile,
  AgentTrialFit,
} from "@crucible/eval";
import type {
  BountyRecommendation,
  BountyAdequacyReport,
} from "@crucible/eval";
import type { ForgeCampaign, CampaignStage } from "@crucible/eval";

const STATE_KEY = "__crucible_forge_store__";
const globalScope = globalThis as unknown as Record<string, unknown>;

type ForgeStore = {
  briefs: Map<string, ForgeBrief>;
  briefReadiness: Map<string, ChallengeReadinessReport>;
  difficultyProfiles: Map<string, TrialDifficultyProfile>;
  agentFits: Map<string, AgentTrialFit>;
  bountyRecommendations: Map<string, BountyRecommendation>;
  bountyAdequacy: Map<string, BountyAdequacyReport>;
  campaigns: Map<string, ForgeCampaign>;
  /** orgId -> set of briefIds */
  briefsByOrg: Map<string, Set<string>>;
  /** orgId -> set of campaignIds */
  campaignsByOrg: Map<string, Set<string>>;
};

function getStore(): ForgeStore {
  let store = globalScope[STATE_KEY] as ForgeStore | undefined;
  if (!store) {
    store = {
      briefs: new Map(),
      briefReadiness: new Map(),
      difficultyProfiles: new Map(),
      agentFits: new Map(),
      bountyRecommendations: new Map(),
      bountyAdequacy: new Map(),
      campaigns: new Map(),
      briefsByOrg: new Map(),
      campaignsByOrg: new Map(),
    };
    globalScope[STATE_KEY] = store;
  }
  return store;
}

/* ------------------------------------------------------------------ */
/* Forge Briefs                                                       */
/* ------------------------------------------------------------------ */

export function createForgeBrief(brief: ForgeBrief, orgId: string): void {
  const store = getStore();
  if (store.briefs.has(brief.briefId)) {
    throw new Error(`forge-store: brief already exists: ${brief.briefId}`);
  }
  store.briefs.set(brief.briefId, brief);
  store.briefsByOrg.get(orgId)?.add(brief.briefId) ??
    store.briefsByOrg.set(orgId, new Set([brief.briefId]));
}

export function getForgeBrief(briefId: string): ForgeBrief | null {
  return getStore().briefs.get(briefId) ?? null;
}

export function listForgeBriefs(orgId: string): ForgeBrief[] {
  const store = getStore();
  const ids = store.briefsByOrg.get(orgId);
  if (!ids) return [];
  return [...ids].map((id) => store.briefs.get(id)).filter(Boolean) as ForgeBrief[];
}

export function updateForgeBrief(
  briefId: string,
  patch: Partial<ForgeBrief>,
): ForgeBrief | null {
  const store = getStore();
  const existing = store.briefs.get(briefId);
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAt: Date.now() };
  store.briefs.set(briefId, updated);
  return updated;
}

export function deleteForgeBrief(briefId: string): boolean {
  const store = getStore();
  const brief = store.briefs.get(briefId);
  if (!brief) return false;
  // Remove from org index.
  const orgIds = store.briefsByOrg;
  for (const [oid, ids] of orgIds) {
    ids.delete(briefId);
    if (ids.size === 0) orgIds.delete(oid);
  }
  store.briefReadiness.delete(briefId);
  store.difficultyProfiles.delete(briefId);
  store.agentFits.delete(briefId);
  store.bountyRecommendations.delete(briefId);
  store.bountyAdequacy.delete(briefId);
  store.briefs.delete(briefId);
  return true;
}

/* ------------------------------------------------------------------ */
/* Challenge Readiness                                                */
/* ------------------------------------------------------------------ */

export function setBriefReadiness(
  briefId: string,
  report: ChallengeReadinessReport,
): void {
  getStore().briefReadiness.set(briefId, report);
}

export function getBriefReadiness(briefId: string): ChallengeReadinessReport | null {
  return getStore().briefReadiness.get(briefId) ?? null;
}

/* ------------------------------------------------------------------ */
/* Difficulty Profiles                                                */
/* ------------------------------------------------------------------ */

export function setDifficultyProfile(
  trialId: string,
  profile: TrialDifficultyProfile,
): void {
  getStore().difficultyProfiles.set(trialId, profile);
}

export function getDifficultyProfile(
  trialId: string,
): TrialDifficultyProfile | null {
  return getStore().difficultyProfiles.get(trialId) ?? null;
}

/* ------------------------------------------------------------------ */
/* Agent Fit                                                          */
/* ------------------------------------------------------------------ */

export function setAgentFit(
  agentId: string,
  trialId: string,
  fit: AgentTrialFit,
): void {
  getStore().agentFits.set(`${agentId}:${trialId}`, fit);
}

export function getAgentFit(
  agentId: string,
  trialId: string,
): AgentTrialFit | null {
  return getStore().agentFits.get(`${agentId}:${trialId}`) ?? null;
}

/* ------------------------------------------------------------------ */
/* Bounty Recommendations                                             */
/* ------------------------------------------------------------------ */

export function setBountyRecommendation(
  trialId: string,
  rec: BountyRecommendation,
): void {
  getStore().bountyRecommendations.set(trialId, rec);
}

export function getBountyRecommendation(
  trialId: string,
): BountyRecommendation | null {
  return getStore().bountyRecommendations.get(trialId) ?? null;
}

export function setBountyAdequacy(
  trialId: string,
  report: BountyAdequacyReport,
): void {
  getStore().bountyAdequacy.set(trialId, report);
}

export function getBountyAdequacy(
  trialId: string,
): BountyAdequacyReport | null {
  return getStore().bountyAdequacy.get(trialId) ?? null;
}

/* ------------------------------------------------------------------ */
/* Campaigns                                                          */
/* ------------------------------------------------------------------ */

export function createCampaign(campaign: ForgeCampaign, orgId: string): void {
  const store = getStore();
  if (store.campaigns.has(campaign.campaignId)) {
    throw new Error(`forge-store: campaign already exists: ${campaign.campaignId}`);
  }
  store.campaigns.set(campaign.campaignId, campaign);
  store.campaignsByOrg.get(orgId)?.add(campaign.campaignId) ??
    store.campaignsByOrg.set(orgId, new Set([campaign.campaignId]));
}

export function getCampaign(campaignId: string): ForgeCampaign | null {
  return getStore().campaigns.get(campaignId) ?? null;
}

export function listCampaigns(orgId: string): ForgeCampaign[] {
  const store = getStore();
  const ids = store.campaignsByOrg.get(orgId);
  if (!ids) return [];
  return [...ids].map((id) => store.campaigns.get(id)).filter(Boolean) as ForgeCampaign[];
}

export function updateCampaign(
  campaignId: string,
  patch: Partial<ForgeCampaign>,
): ForgeCampaign | null {
  const store = getStore();
  const existing = store.campaigns.get(campaignId);
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAt: Date.now() };
  store.campaigns.set(campaignId, updated);
  return updated;
}

export function deleteCampaign(campaignId: string): boolean {
  const store = getStore();
  const campaign = store.campaigns.get(campaignId);
  if (!campaign) return false;
  const orgIds = store.campaignsByOrg;
  for (const [oid, ids] of orgIds) {
    ids.delete(campaignId);
    if (ids.size === 0) orgIds.delete(oid);
  }
  store.campaigns.delete(campaignId);
  return true;
}

/* ------------------------------------------------------------------ */
/* Reset (testing only)                                               */
/* ------------------------------------------------------------------ */

export function __resetForgeStoreForTests(): void {
  const store = getStore();
  store.briefs.clear();
  store.briefReadiness.clear();
  store.difficultyProfiles.clear();
  store.agentFits.clear();
  store.bountyRecommendations.clear();
  store.bountyAdequacy.clear();
  store.campaigns.clear();
  store.briefsByOrg.clear();
  store.campaignsByOrg.clear();
}

/** TypeScript brand. */
export const __forgeStoreBrand = Symbol.for("crucible.forge-store");