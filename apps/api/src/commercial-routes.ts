/**
 * @file commercial-routes.ts — Hono routes for commercial tiers and usage.
 *
 * Provides tier configuration, plan assignment, usage tracking,
 * quota enforcement, and budget alerts.
 */

import { Hono } from "hono";
import { verifiedSessionFromContext } from "./auth.js";
import {
  DEFAULT_TIERS,
  getTier,
  listTiers,
  createTenantPlan,
  getTenantPlan,
  recordUsage,
  getUsageSummary,
  checkQuota,
  checkBudgetAlert,
  type TierId,
  type UsageCategory,
} from "./commercial-tiers.js";

export function createCommercialRoutes(): Hono {
  const app = new Hono();

  // List all available tiers
  app.get("/tiers", (c) => {
    const tiers = listTiers();
    return c.json(tiers);
  });

  // Get default tier configurations
  app.get("/tiers/defaults", (c) => {
    return c.json(DEFAULT_TIERS);
  });

  // Get a specific tier
  app.get("/tiers/:tierId", (c) => {
    const tierId = c.req.param("tierId");
    const tier = getTier(tierId as TierId);
    if (!tier) return c.json({ error: "Tier not found" }, 404);
    return c.json(tier);
  });

  // Assign a plan to a tenant
  app.post("/plans", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const input = await c.req.json<{
      tenantId: string;
      tierId: TierId;
      budgetAlertThreshold?: number;
      overageAllowed?: boolean;
    }>();

    try {
      const plan = createTenantPlan(input);
      return c.json(plan, 201);
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });

  // Get plan for a tenant
  app.get("/plans/:tenantId", (c) => {
    const tenantId = c.req.param("tenantId");
    const plan = getTenantPlan(tenantId);
    if (!plan) return c.json({ error: "Plan not found" }, 404);
    return c.json(plan);
  });

  // Record usage
  app.post("/usage", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const input = await c.req.json<{
      tenantId: string;
      category: UsageCategory;
      amount: number;
    }>();

    try {
      const record = recordUsage(input);
      return c.json(record, 201);
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });

  // Get usage summary for a tenant
  app.get("/usage/:tenantId/summary", (c) => {
    const tenantId = c.req.param("tenantId");
    const summary = getUsageSummary(tenantId);
    return c.json(summary);
  });

  // Check quota for a tenant
  app.get("/usage/:tenantId/quota/:category", (c) => {
    const tenantId = c.req.param("tenantId");
    const category = c.req.param("category");
    const quota = checkQuota(tenantId, category as UsageCategory);
    return c.json(quota);
  });

  // Check budget alert for a tenant
  app.get("/usage/:tenantId/alert", (c) => {
    const tenantId = c.req.param("tenantId");
    const alert = checkBudgetAlert(tenantId);
    return c.json({ alert });
  });

  return app;
}
