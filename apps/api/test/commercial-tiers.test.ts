import { describe, it, expect, beforeEach } from "vitest";
import {
  getTier,
  listTiers,
  updateTier,
  createTenantPlan,
  getTenantPlan,
  upgradeTier,
  recordUsage,
  getUsageSummary,
  checkQuota,
  checkBudgetAlert,
  resetCommercialStore,
  DEFAULT_TIERS,
} from "../src/commercial-tiers.js";

describe("commercial-tiers", () => {
  beforeEach(() => {
    resetCommercialStore();
  });

  describe("tier operations", () => {
    it("returns all default tiers", () => {
      const tiers = listTiers();
      expect(tiers.length).toBe(4);
      const ids = tiers.map(t => t.id);
      expect(ids).toContain("developer");
      expect(ids).toContain("research");
      expect(ids).toContain("enterprise");
      expect(ids).toContain("sponsor");
    });

    it("gets a specific tier", () => {
      const tier = getTier("developer");
      expect(tier).toBeDefined();
      expect(tier?.name).toBe("Developer");
    });

    it("returns undefined for unknown tier", () => {
      expect(getTier("unknown" as any)).toBeUndefined();
    });

    it("updates a tier", () => {
      const result = updateTier("developer", {
        quotas: { ...DEFAULT_TIERS.developer.quotas, maxApiRequestsPerMonth: 2000 },
      });
      expect(result).toBe(true);

      const tier = getTier("developer");
      expect(tier?.quotas.maxApiRequestsPerMonth).toBe(2000);
    });

    it("developer tier is free", () => {
      const tier = getTier("developer");
      expect(tier?.pricing.monthlyBasePriceCents).toBe(0);
    });

    it("enterprise tier has all features", () => {
      const tier = getTier("enterprise");
      expect(tier?.features.advancedAnalytics).toBe(true);
      expect(tier?.features.governanceWorkflows).toBe(true);
      expect(tier?.features.prioritySupport).toBe(true);
      expect(tier?.features.slaCommitments).toBe(true);
    });
  });

  describe("plan operations", () => {
    it("creates a tenant plan", () => {
      const plan = createTenantPlan({
        tenantId: "tenant-1",
        tierId: "developer",
      });

      expect(plan.tenantId).toBe("tenant-1");
      expect(plan.tierId).toBe("developer");
      expect(plan.budgetAlertThreshold).toBe(80);
    });

    it("rejects unknown tier", () => {
      expect(() =>
        createTenantPlan({
          tenantId: "tenant-1",
          tierId: "unknown" as any,
        }),
      ).toThrow("not found");
    });

    it("retrieves a tenant plan", () => {
      createTenantPlan({
        tenantId: "tenant-1",
        tierId: "developer",
      });

      const plan = getTenantPlan("tenant-1");
      expect(plan).toBeDefined();
      expect(plan?.tierId).toBe("developer");
    });

    it("upgrades a tier", () => {
      createTenantPlan({
        tenantId: "tenant-1",
        tierId: "developer",
      });

      const result = upgradeTier("tenant-1", "enterprise");
      expect(result).toBe(true);

      const plan = getTenantPlan("tenant-1");
      expect(plan?.tierId).toBe("enterprise");
    });

    it("rejects upgrade for unknown tenant", () => {
      expect(upgradeTier("unknown", "enterprise")).toBe(false);
    });
  });

  describe("usage tracking", () => {
    it("records usage", () => {
      createTenantPlan({
        tenantId: "tenant-1",
        tierId: "research",
      });

      const record = recordUsage({
        tenantId: "tenant-1",
        category: "api_request",
        amount: 100,
      });

      expect(record.amount).toBe(100);
      expect(record.category).toBe("api_request");
    });

    it("rejects usage for unknown tenant", () => {
      expect(() =>
        recordUsage({
          tenantId: "unknown",
          category: "api_request",
          amount: 1,
        }),
      ).toThrow("no plan");
    });

    it("summarizes usage", () => {
      createTenantPlan({
        tenantId: "tenant-1",
        tierId: "research",
      });

      recordUsage({ tenantId: "tenant-1", category: "api_request", amount: 100 });
      recordUsage({ tenantId: "tenant-1", category: "evaluation", amount: 5 });

      const summary = getUsageSummary("tenant-1");
      expect(summary.apiRequests).toBe(100);
      expect(summary.evaluations).toBe(5);
    });

    it("checks quota availability", () => {
      createTenantPlan({
        tenantId: "tenant-1",
        tierId: "developer",
      });

      const status = checkQuota("tenant-1", "api_request");
      expect(status.allowed).toBe(true);
      expect(status.limit).toBe(1000);
    });

    it("blocks when quota exceeded", () => {
      createTenantPlan({
        tenantId: "tenant-1",
        tierId: "developer",
      });

      // Record usage up to the limit
      recordUsage({ tenantId: "tenant-1", category: "api_request", amount: 1000 });

      const status = checkQuota("tenant-1", "api_request");
      expect(status.allowed).toBe(false);
      expect(status.remaining).toBe(0);
    });

    it("allows overage when configured", () => {
      createTenantPlan({
        tenantId: "tenant-1",
        tierId: "developer",
        overageAllowed: true,
      });

      recordUsage({ tenantId: "tenant-1", category: "api_request", amount: 1000 });

      const status = checkQuota("tenant-1", "api_request");
      expect(status.allowed).toBe(true);
    });

    it("returns error for unknown tenant", () => {
      const status = checkQuota("unknown", "api_request");
      expect(status.allowed).toBe(false);
      expect(status.error).toBe("No plan found");
    });

    it("checks budget alert", () => {
      createTenantPlan({
        tenantId: "tenant-1",
        tierId: "developer",
      });

      // Developer tier is free, so no alert
      const alert = checkBudgetAlert("tenant-1");
      expect(alert).toBe(false);
    });

    it("triggers budget alert for paid tier", () => {
      createTenantPlan({
        tenantId: "tenant-1",
        tierId: "research",
      });

      const alert = checkBudgetAlert("tenant-1");
      expect(alert).toBe(true);
    });
  });
});
