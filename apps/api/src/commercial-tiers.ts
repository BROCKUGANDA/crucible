/**
 * @file commercial-tiers.ts — Commercial tier configuration (Phase 9).
 *
 * Implements configurable commercial tiers, API metering, usage tracking,
 * and plan entitlements. Pricing is configurable, not hard-coded.
 *
 * Key principles:
 * - No hard-coded commercial policy in the execution engine.
 * - All pricing is configurable per tenant.
 * - Usage tracking is separate from evaluation results.
 * - Budget alerts prevent unexpected overages.
 */

import { randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type TierId = "developer" | "research" | "enterprise" | "sponsor";

export interface TierConfig {
  id: TierId;
  name: string;
  description: string;
  quotas: TierQuotas;
  pricing: TierPricing;
  features: TierFeatures;
}

export interface TierQuotas {
  /** Maximum API requests per month. */
  maxApiRequestsPerMonth: number;
  /** Maximum evaluations per month. */
  maxEvaluationsPerMonth: number;
  /** Maximum concurrent evaluations. */
  maxConcurrentEvaluations: number;
  /** Maximum storage in bytes. */
  maxStorageBytes: number;
  /** Maximum compute hours per month. */
  maxComputeHoursPerMonth: number;
  /** Maximum team members. */
  maxTeamMembers: number;
  /** Maximum private suites. */
  maxPrivateSuites: number;
}

export interface TierPricing {
  /** Monthly base price in cents. */
  monthlyBasePriceCents: number;
  /** Price per API request in microcents. */
  pricePerApiRequest: number;
  /** Price per evaluation in cents. */
  pricePerEvaluation: number;
  /** Price per GB storage in cents. */
  pricePerGbStorage: number;
  /** Price per compute hour in cents. */
  pricePerComputeHour: number;
}

export interface TierFeatures {
  /** Public discovery access. */
  publicDiscovery: boolean;
  /** Private suites. */
  privateSuites: boolean;
  /** Detailed evidence. */
  detailedEvidence: boolean;
  /** Comparative reporting. */
  comparativeReporting: boolean;
  /** Advanced analytics. */
  advancedAnalytics: boolean;
  /** Team collaboration. */
  teamCollaboration: boolean;
  /** Custom benchmark suites. */
  customSuites: boolean;
  /** Governance workflows. */
  governanceWorkflows: boolean;
  /** API access. */
  apiAccess: boolean;
  /** Webhook integrations. */
  webhookIntegrations: boolean;
  /** Priority support. */
  prioritySupport: boolean;
  /** SLA commitments. */
  slaCommitments: boolean;
}

export interface UsageRecord {
  id: string;
  tenantId: string;
  tierId: TierId;
  category: UsageCategory;
  amount: number;
  timestamp: number;
}

export type UsageCategory =
  | "api_request"
  | "evaluation"
  | "storage_bytes"
  | "compute_hours"
  | "team_member";

export interface TenantPlan {
  tenantId: string;
  tierId: TierId;
  startDate: number;
  endDate?: number;
  usage: UsageRecord[];
  budgetAlertThreshold: number; // Percentage, 0-100
  overageAllowed: boolean;
}

/* ------------------------------------------------------------------ */
/* Default tier configurations                                       */
/* ------------------------------------------------------------------ */

export const DEFAULT_TIERS: Record<TierId, TierConfig> = {
  developer: {
    id: "developer",
    name: "Developer",
    description: "Free public discovery with limited evaluation access.",
    quotas: {
      maxApiRequestsPerMonth: 1000,
      maxEvaluationsPerMonth: 5,
      maxConcurrentEvaluations: 1,
      maxStorageBytes: 100_000_000, // 100MB
      maxComputeHoursPerMonth: 1,
      maxTeamMembers: 1,
      maxPrivateSuites: 0,
    },
    pricing: {
      monthlyBasePriceCents: 0,
      pricePerApiRequest: 0,
      pricePerEvaluation: 0,
      pricePerGbStorage: 0,
      pricePerComputeHour: 0,
    },
    features: {
      publicDiscovery: true,
      privateSuites: false,
      detailedEvidence: false,
      comparativeReporting: false,
      advancedAnalytics: false,
      teamCollaboration: false,
      customSuites: false,
      governanceWorkflows: false,
      apiAccess: true,
      webhookIntegrations: false,
      prioritySupport: false,
      slaCommitments: false,
    },
  },

  research: {
    id: "research",
    name: "Research",
    description: "Private suites, repeated evaluations, detailed evidence.",
    quotas: {
      maxApiRequestsPerMonth: 50_000,
      maxEvaluationsPerMonth: 100,
      maxConcurrentEvaluations: 5,
      maxStorageBytes: 10_000_000_000, // 10GB
      maxComputeHoursPerMonth: 50,
      maxTeamMembers: 10,
      maxPrivateSuites: 10,
    },
    pricing: {
      monthlyBasePriceCents: 4900, // $49/month
      pricePerApiRequest: 1, // $0.000001 per request
      pricePerEvaluation: 99, // $0.99 per evaluation
      pricePerGbStorage: 500, // $5/GB
      pricePerComputeHour: 2000, // $20/hour
    },
    features: {
      publicDiscovery: true,
      privateSuites: true,
      detailedEvidence: true,
      comparativeReporting: true,
      advancedAnalytics: false,
      teamCollaboration: true,
      customSuites: true,
      governanceWorkflows: false,
      apiAccess: true,
      webhookIntegrations: true,
      prioritySupport: false,
      slaCommitments: false,
    },
  },

  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    description: "Private workspaces, dedicated programs, audit history.",
    quotas: {
      maxApiRequestsPerMonth: 500_000,
      maxEvaluationsPerMonth: 1000,
      maxConcurrentEvaluations: 20,
      maxStorageBytes: 100_000_000_000, // 100GB
      maxComputeHoursPerMonth: 500,
      maxTeamMembers: 100,
      maxPrivateSuites: 100,
    },
    pricing: {
      monthlyBasePriceCents: 49900, // $499/month
      pricePerApiRequest: 0,
      pricePerEvaluation: 49, // $0.49 per evaluation
      pricePerGbStorage: 200, // $2/GB
      pricePerComputeHour: 1000, // $10/hour
    },
    features: {
      publicDiscovery: true,
      privateSuites: true,
      detailedEvidence: true,
      comparativeReporting: true,
      advancedAnalytics: true,
      teamCollaboration: true,
      customSuites: true,
      governanceWorkflows: true,
      apiAccess: true,
      webhookIntegrations: true,
      prioritySupport: true,
      slaCommitments: true,
    },
  },

  sponsor: {
    id: "sponsor",
    name: "Sponsor",
    description: "Sponsored evaluation programs, prize administration.",
    quotas: {
      maxApiRequestsPerMonth: 100_000,
      maxEvaluationsPerMonth: 500,
      maxConcurrentEvaluations: 10,
      maxStorageBytes: 50_000_000_000, // 50GB
      maxComputeHoursPerMonth: 200,
      maxTeamMembers: 50,
      maxPrivateSuites: 50,
    },
    pricing: {
      monthlyBasePriceCents: 9900, // $99/month
      pricePerApiRequest: 0,
      pricePerEvaluation: 0,
      pricePerGbStorage: 100, // $1/GB
      pricePerComputeHour: 500, // $5/hour
    },
    features: {
      publicDiscovery: true,
      privateSuites: true,
      detailedEvidence: true,
      comparativeReporting: true,
      advancedAnalytics: true,
      teamCollaboration: true,
      customSuites: true,
      governanceWorkflows: true,
      apiAccess: true,
      webhookIntegrations: true,
      prioritySupport: true,
      slaCommitments: false,
    },
  },
};

/* ------------------------------------------------------------------ */
/* In-memory store                                                    */
/* ------------------------------------------------------------------ */

interface CommercialStore {
  tiers: Map<TierId, TierConfig>;
  plans: Map<string, TenantPlan>;
  usage: Map<string, UsageRecord[]>;
}

const store: CommercialStore = {
  tiers: new Map(Object.entries(DEFAULT_TIERS) as [TierId, TierConfig][]),
  plans: new Map(),
  usage: new Map(),
};

/* ------------------------------------------------------------------ */
/* Tier operations                                                    */
/* ------------------------------------------------------------------ */

export function getTier(tierId: TierId): TierConfig | undefined {
  return store.tiers.get(tierId);
}

export function listTiers(): TierConfig[] {
  const tiers: TierConfig[] = [];
  for (const [, tier] of store.tiers) {
    tiers.push(tier);
  }
  return tiers;
}

export function updateTier(tierId: TierId, updates: Partial<TierConfig>): boolean {
  const tier = store.tiers.get(tierId);
  if (!tier) return false;

  const updated = { ...tier, ...updates };
  store.tiers.set(tierId, updated);
  return true;
}

/* ------------------------------------------------------------------ */
/* Plan operations                                                    */
/* ------------------------------------------------------------------ */

export function createTenantPlan(input: {
  tenantId: string;
  tierId: TierId;
  budgetAlertThreshold?: number;
  overageAllowed?: boolean;
}): TenantPlan {
  const tier = store.tiers.get(input.tierId);
  if (!tier) {
    throw new Error(`Tier "${input.tierId}" not found`);
  }

  const plan: TenantPlan = {
    tenantId: input.tenantId,
    tierId: input.tierId,
    startDate: Date.now(),
    usage: [],
    budgetAlertThreshold: input.budgetAlertThreshold ?? 80,
    overageAllowed: input.overageAllowed ?? false,
  };

  store.plans.set(input.tenantId, plan);
  store.usage.set(input.tenantId, []);

  return plan;
}

export function getTenantPlan(tenantId: string): TenantPlan | undefined {
  return store.plans.get(tenantId);
}

export function upgradeTier(tenantId: string, newTierId: TierId): boolean {
  const plan = store.plans.get(tenantId);
  if (!plan) return false;

  const tier = store.tiers.get(newTierId);
  if (!tier) return false;

  plan.tierId = newTierId;
  store.plans.set(tenantId, plan);
  return true;
}

/* ------------------------------------------------------------------ */
/* Usage tracking                                                     */
/* ------------------------------------------------------------------ */

export function recordUsage(input: {
  tenantId: string;
  category: UsageCategory;
  amount: number;
}): UsageRecord {
  const plan = store.plans.get(input.tenantId);
  if (!plan) {
    throw new Error(`Tenant "${input.tenantId}" has no plan`);
  }

  const record: UsageRecord = {
    id: randomUUID(),
    tenantId: input.tenantId,
    tierId: plan.tierId,
    category: input.category,
    amount: input.amount,
    timestamp: Date.now(),
  };

  const records = store.usage.get(input.tenantId) ?? [];
  records.push(record);
  store.usage.set(input.tenantId, records);

  plan.usage.push(record);
  store.plans.set(input.tenantId, plan);

  return record;
}

export function getUsageSummary(tenantId: string): UsageSummary {
  const records = store.usage.get(tenantId) ?? [];
  const now = Date.now();
  const monthStart = now - 30 * 24 * 60 * 60 * 1000;

  const summary: UsageSummary = {
    apiRequests: 0,
    evaluations: 0,
    storageBytes: 0,
    computeHours: 0,
    teamMembers: 0,
  };

  for (const record of records) {
    if (record.timestamp < monthStart) continue;

    switch (record.category) {
      case "api_request":
        summary.apiRequests += record.amount;
        break;
      case "evaluation":
        summary.evaluations += record.amount;
        break;
      case "storage_bytes":
        summary.storageBytes += record.amount;
        break;
      case "compute_hours":
        summary.computeHours += record.amount;
        break;
      case "team_member":
        summary.teamMembers += record.amount;
        break;
    }
  }

  return summary;
}

export interface UsageSummary {
  apiRequests: number;
  evaluations: number;
  storageBytes: number;
  computeHours: number;
  teamMembers: number;
}

export function checkQuota(tenantId: string, category: UsageCategory): QuotaStatus {
  const plan = store.plans.get(tenantId);
  if (!plan) return { allowed: false, remaining: 0, limit: 0, error: "No plan found" };

  const tier = store.tiers.get(plan.tierId);
  if (!tier) return { allowed: false, remaining: 0, limit: 0, error: "Tier not found" };

  const summary = getUsageSummary(tenantId);
  let used: number;
  let limit: number;

  switch (category) {
    case "api_request":
      used = summary.apiRequests;
      limit = tier.quotas.maxApiRequestsPerMonth;
      break;
    case "evaluation":
      used = summary.evaluations;
      limit = tier.quotas.maxEvaluationsPerMonth;
      break;
    case "storage_bytes":
      used = summary.storageBytes;
      limit = tier.quotas.maxStorageBytes;
      break;
    case "compute_hours":
      used = summary.computeHours;
      limit = tier.quotas.maxComputeHoursPerMonth;
      break;
    case "team_member":
      used = summary.teamMembers;
      limit = tier.quotas.maxTeamMembers;
      break;
    default:
      return { allowed: true, remaining: Infinity, limit: Infinity };
  }

  const remaining = Math.max(0, limit - used);
  const allowed = used < limit || plan.overageAllowed;

  return { allowed, remaining, limit, used };
}

export interface QuotaStatus {
  allowed: boolean;
  remaining: number;
  limit: number;
  used?: number;
  error?: string;
}

export function checkBudgetAlert(tenantId: string): boolean {
  const plan = store.plans.get(tenantId);
  if (!plan) return false;

  const tier = store.tiers.get(plan.tierId);
  if (!tier || tier.pricing.monthlyBasePriceCents === 0) return false;

  const summary = getUsageSummary(tenantId);
  const estimatedCost = estimateCost(summary, tier);
  const threshold = plan.budgetAlertThreshold / 100;

  // Simple budget alert: if estimated cost exceeds threshold of a reasonable budget
  // In production, this would compare against an actual budget cap
  return estimatedCost > 0; // Placeholder: always alert if there's any cost
}

function estimateCost(summary: UsageSummary, tier: TierConfig): number {
  const { pricing } = tier;
  let total = pricing.monthlyBasePriceCents;

  total += summary.apiRequests * pricing.pricePerApiRequest;
  total += summary.evaluations * pricing.pricePerEvaluation;
  total += (summary.storageBytes / (1024 * 1024 * 1024)) * pricing.pricePerGbStorage;
  total += summary.computeHours * pricing.pricePerComputeHour;

  return total;
}

/* ------------------------------------------------------------------ */
/* Store access for testing                                         */
/* ------------------------------------------------------------------ */

export function resetCommercialStore(): void {
  store.tiers.clear();
  for (const [key, value] of Object.entries(DEFAULT_TIERS) as [TierId, TierConfig][]) {
    store.tiers.set(key, value);
  }
  store.plans.clear();
  store.usage.clear();
}
