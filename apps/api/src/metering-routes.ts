/**
 * @file metering-routes.ts — Usage metering and quota API routes.
 *
 * Mounted under `/metering`. Session-gated for writes and reads.
 */

import { Hono, type Context } from "hono";
import {
  MeteringService,
  createMeteringStore,
  type UsagePeriod,
  type QuotaCheckResult,
} from "./metering.js";
import { verifiedSessionFromContext } from "./auth.js";

export interface MeteringConfig {
  service?: MeteringService;
}

export function createMeteringRoutes(config: MeteringConfig = {}): Hono {
  const service = config.service ?? new MeteringService({ store: createMeteringStore() });
  const app = new Hono();

  app.post("/usage", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);

    let body: { tenantId?: string; metric?: string; quantity?: number; metadata?: Record<string, unknown> } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body", code: "bad-request" }, 400);
    }

    const tenantId = body.tenantId?.trim();
    const metric = body.metric?.trim();
    if (!tenantId || !metric) {
      return c.json({ error: "tenantId and metric are required", code: "bad-request" }, 400);
    }

    // Atomic quota check + record: concurrent requests cannot both pass and exceed the limit.
    const result = service.recordUsageIfAllowed(tenantId, metric, body.quantity ?? 1, body.metadata);
    if (!result.event) {
      return c.json({ error: "quota_exceeded", ...result.check }, 429);
    }
    return c.json({ event: result.event, quota: result.check }, 201);
  });

  app.get("/usage/:tenantId", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);

    const tenantId = c.req.param("tenantId");
    const metric = c.req.query("metric") ?? undefined;
    const from = c.req.query("from") ? Number(c.req.query("from")) : undefined;
    const to = c.req.query("to") ? Number(c.req.query("to")) : undefined;
    const summary = service.getUsage(tenantId, metric, from, to);
    return c.json({ usage: summary });
  });

  app.get("/quota/:tenantId", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);

    const tenantId = c.req.param("tenantId");
    const quotas = service.getQuotas(tenantId);
    return c.json({ quotas });
  });

  app.post("/quota", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);

    let body: { tenantId?: string; metric?: string; period?: UsagePeriod; limit?: number } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body", code: "bad-request" }, 400);
    }

    const tenantId = body.tenantId?.trim();
    const metric = body.metric?.trim();
    const period = body.period ?? "monthly";
    const limit = body.limit;
    if (!tenantId || !metric || !limit || limit <= 0) {
      return c.json({ error: "tenantId, metric, and positive limit are required", code: "bad-request" }, 400);
    }
    if (!["hourly", "daily", "monthly"].includes(period)) {
      return c.json({ error: "invalid period", code: "bad-request" }, 400);
    }

    const quota = service.setQuota(tenantId, metric, period, limit);
    return c.json({ quota }, 201);
  });

  app.post("/check", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);

    let body: { tenantId?: string; metric?: string; quantity?: number } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body", code: "bad-request" }, 400);
    }

    const tenantId = body.tenantId?.trim();
    const metric = body.metric?.trim();
    const quantity = body.quantity ?? 1;
    if (!tenantId || !metric) {
      return c.json({ error: "tenantId and metric are required", code: "bad-request" }, 400);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return c.json({ error: "quantity must be a positive number", code: "bad-request" }, 400);
    }

    const result = service.checkQuota(tenantId, metric, quantity);
    return c.json(result);
  });

  return app;
}
