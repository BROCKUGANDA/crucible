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
import { verifiedSessionFromContext, configuredChainId } from "./auth.js";
import { buildOrganisationPrincipal, authorize, isMemberOf } from "@crucible/agent-security";

export interface MeteringConfig {
  service?: MeteringService;
}

/**
 * Quotas with no limit carry `remaining: Infinity`, and `JSON.stringify`
 * turns that into `null` — the same shape a quota with zero left would have.
 * The route sends `null` deliberately to mean "no quota configured", never `0`.
 */
function jsonQuota<T extends object>(q: T): T {
  const remaining = (q as { remaining?: unknown }).remaining;
  if (typeof remaining === "number" && !Number.isFinite(remaining)) {
    return { ...q, remaining: null } as unknown as T;
  }
  return q;
}

type Gate =
  | { ok: true; principal: import("@crucible/agent-security").OrganisationPrincipal }
  | { ok: false; denied: Response };

export function createMeteringRoutes(config: MeteringConfig = {}): Hono {
  const service = config.service ?? new MeteringService({ store: createMeteringStore() });
  const app = new Hono();

  /** The caller's verified principal, or a 401/403 response. */
  function principalOrDenied(c: Context, tenantId: string): Gate {
    const session = verifiedSessionFromContext(c);
    if (!session) {
      return { ok: false, denied: c.json({ error: "unauthenticated", code: "no-credential" }, 401) };
    }
    const principal = buildOrganisationPrincipal({
      address: session.payload.address,
      id: `eip155:${configuredChainId()}:${session.payload.address.toLowerCase()}`,
      sessionId: session.sessionId,
      authenticated: true,
    });
    if (!principal) {
      return { ok: false, denied: c.json({ error: "unauthenticated", code: "no-credential" }, 401) };
    }
    // Tenancy is membership, resolved server-side. A tenantId the caller does
    // not belong to is refused — not merely hidden from the UI.
    if (!isMemberOf(principal.wallet.id, tenantId)) {
      return {
        ok: false,
        denied: c.json(
          { error: "forbidden", reason: `${principal.wallet.address} is not a member of ${tenantId}`, code: "not-a-member" },
          403,
        ),
      };
    }
    return { ok: true, principal };
  }

  app.post("/usage", async (c) => {
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
    const quantity = body.quantity ?? 1;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return c.json({ error: "quantity must be a positive number", code: "bad-request" }, 400);
    }

    const gate = principalOrDenied(c, tenantId);
    if (!gate.ok) return gate.denied;

    // Atomic quota check + record: concurrent requests cannot both pass and exceed the limit.
    const result = service.recordUsageIfAllowed(tenantId, metric, quantity, body.metadata);
    if (!result.event) {
      return c.json({ error: "quota_exceeded", ...result.check }, 429);
    }
    return c.json({ event: result.event, quota: jsonQuota(result.check) }, 201);
  });

  app.get("/usage/:tenantId", async (c) => {
    const tenantId = c.req.param("tenantId");
    const gate = principalOrDenied(c, tenantId);
    if (!gate.ok) return gate.denied;

    const metric = c.req.query("metric") ?? undefined;
    const from = c.req.query("from") ? Number(c.req.query("from")) : undefined;
    const to = c.req.query("to") ? Number(c.req.query("to")) : undefined;
    const summary = service.getUsage(tenantId, metric, from, to);
    return c.json({ usage: summary });
  });

  app.get("/quota/:tenantId", async (c) => {
    const tenantId = c.req.param("tenantId");
    const gate = principalOrDenied(c, tenantId);
    if (!gate.ok) return gate.denied;

    const quotas = service.getQuotas(tenantId).map((q) => jsonQuota(q));
    return c.json({ quotas });
  });

  app.post("/quota", async (c) => {
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

    // Setting a quota is a spend-control decision: the tenant's role matrix
    // decides, not membership.
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    const principal = buildOrganisationPrincipal({
      address: session.payload.address,
      id: `eip155:${configuredChainId()}:${session.payload.address.toLowerCase()}`,
      sessionId: session.sessionId,
      authenticated: true,
    });
    if (!principal) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    const decision = authorize(principal, tenantId, "org:budget:set");
    if (!decision.allow) {
      return c.json({ error: "forbidden", reason: decision.reason, code: decision.code }, 403);
    }

    const quota = service.setQuota(tenantId, metric, period, limit);
    return c.json({ quota: jsonQuota(quota) }, 201);
  });

  app.post("/check", async (c) => {
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

    const gate = principalOrDenied(c, tenantId);
    if (!gate.ok) return gate.denied;

    const result = service.checkQuota(tenantId, metric, quantity);
    return c.json(jsonQuota(result));
  });

  return app;
}
