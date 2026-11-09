/**
 * @file orgs.ts — Organisation (tenancy) read routes.
 *
 * Off-chain product layer: exposes the organisation store (packages/agent-security)
 * over HTTP so a signed-in wallet can discover the organisations it belongs to
 * and read their metadata. Organisation membership is resolved server-side from
 * the in-memory store per request; a client-supplied orgId is never trusted as
 * proof of membership.
 *
 * Consistent with ADR-0008 (in-memory) until ADR-0023 (PostgreSQL) lands.
 * No chain keys are held by the API.
 */

import { Hono, type Context } from "hono";
import { configuredChainId, verifiedSessionFromContext } from "./auth.js";
import {
  buildOrganisationPrincipal,
  createOrganisation,
  getOrganisation,
  organisationsForPrincipal,
  isMemberOf,
  authorize,
  newOrganisation,
  type OrganisationPrincipal,
} from "@crucible/agent-security";
import {
  inviteMember,
  listOrgMemberships,
  listOrgInvitations,
} from "@crucible/agent-security";
import {
  newOrgBudget,
  createBudget,
  listBudgetsForOrg,
} from "@crucible/agent-security";
import {
  newOrgApiKey,
  createApiKey,
  listApiKeysForOrg,
  revokeApiKey,
} from "@crucible/agent-security";

function resolveWalletPrincipal(c: Context): OrganisationPrincipal | null {
  const session = verifiedSessionFromContext(c);
  if (!session) return null;
  const address = session.payload.address;
  return buildOrganisationPrincipal({
    address,
    id: `eip155:${configuredChainId()}:${address.toLowerCase()}`,
    sessionId: session.sessionId,
    authenticated: true,
  });
}

export function createOrgRoutes(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const principal = resolveWalletPrincipal(c);
    if (!principal) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    const orgIds = organisationsForPrincipal(principal.wallet.id);
    const orgs = orgIds
      .map((id) => getOrganisation(id))
      .filter((o): o is NonNullable<typeof o> => o !== null);
    return c.json({ organisations: orgs });
  });

  app.post("/", async (c) => {
    const principal = resolveWalletPrincipal(c);
    if (!principal) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    let body: { orgId?: string; name?: string; slug?: string } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body", code: "bad-request" }, 400);
    }
    const orgId = body.orgId?.trim();
    const name = body.name?.trim();
    const slug = body.slug?.trim();
    if (!orgId || !name || !slug) {
      return c.json({ error: "orgId, name and slug are required", code: "bad-request" }, 400);
    }
    try {
      const org = newOrganisation(orgId, name, slug, principal.wallet.id);
      createOrganisation(org);
      return c.json({ organisation: getOrganisation(orgId) }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message, code: "conflict" }, 409);
    }
  });

  app.get("/:id", async (c) => {
    const principal = resolveWalletPrincipal(c);
    if (!principal) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    const id = c.req.param("id");
    if (!isMemberOf(principal.wallet.id, id)) {
      return c.json({ error: "forbidden", code: "not-a-member" }, 403);
    }
    const org = getOrganisation(id);
    if (!org) {
      return c.json({ error: "not found", code: "no-such-org" }, 404);
    }
    return c.json({ organisation: org });
  });

  app.get("/:id/members", async (c) => {
    const principal = resolveWalletPrincipal(c);
    if (!principal) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    const id = c.req.param("id");
    if (!isMemberOf(principal.wallet.id, id)) {
      return c.json({ error: "forbidden", code: "not-a-member" }, 403);
    }
    return c.json({ members: listOrgMemberships(id) });
  });

  app.post("/:id/invitations", async (c) => {
    const principal = resolveWalletPrincipal(c);
    if (!principal) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    const id = c.req.param("id");
    if (!isMemberOf(principal.wallet.id, id)) {
      return c.json({ error: "forbidden", code: "not-a-member" }, 403);
    }
    let body: { inviteePrincipalId?: string; role?: string; ttlMs?: number } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body", code: "bad-request" }, 400);
    }
    const invitee = body.inviteePrincipalId?.trim();
    const role = body.role?.trim() ?? "org.member";
    const ttlMs = body.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    if (!invitee) {
      return c.json({ error: "inviteePrincipalId is required", code: "bad-request" }, 400);
    }
    try {
      const result = inviteMember(id, invitee, role, principal.wallet.id, ttlMs);
      return c.json({ invitationId: result.invitationId, invitation: result.invitation }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message, code: "forbidden" }, 403);
    }
  });

  app.get("/:id/invitations", async (c) => {
    const principal = resolveWalletPrincipal(c);
    if (!principal) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    const id = c.req.param("id");
    if (!isMemberOf(principal.wallet.id, id)) {
      return c.json({ error: "forbidden", code: "not-a-member" }, 403);
    }
    return c.json({ invitations: listOrgInvitations(id) });
  });

  app.post("/:id/budgets", async (c) => {
    const principal = resolveWalletPrincipal(c);
    if (!principal) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    const id = c.req.param("id");
    // Budget creation is a spend-control decision: the role matrix decides,
    // not mere membership (org:budget:set is owner/billing-admin only).
    const decision = authorize(principal, id, "org:budget:set");
    if (!decision.allow) {
      return c.json({ error: "forbidden", reason: decision.reason, code: decision.code }, 403);
    }
    let body: { budgetId?: string; category?: string; totalUnits?: string; periodStart?: number; periodEnd?: number } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body", code: "bad-request" }, 400);
    }
    if (!body.budgetId || !body.category || !body.totalUnits || body.periodStart === undefined || body.periodEnd === undefined) {
      return c.json({ error: "budgetId, category, totalUnits, periodStart and periodEnd are required", code: "bad-request" }, 400);
    }
    try {
      const budget = newOrgBudget(
        body.budgetId,
        id,
        body.category as "evaluation_spend" | "model_usage" | "tool_calls" | "compute" | "storage" | "monthly_usage" | "per_project_limit",
        BigInt(body.totalUnits),
        body.periodStart,
        body.periodEnd,
        principal.wallet.id,
      );
      createBudget(budget);
      return c.json({ budget }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message, code: "conflict" }, 409);
    }
  });

  app.get("/:id/budgets", async (c) => {
    const principal = resolveWalletPrincipal(c);
    if (!principal) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    const id = c.req.param("id");
    if (!isMemberOf(principal.wallet.id, id)) {
      return c.json({ error: "forbidden", code: "not-a-member" }, 403);
    }
    return c.json({ budgets: listBudgetsForOrg(id) });
  });

  app.post("/:id/api-keys", async (c) => {
    const principal = resolveWalletPrincipal(c);
    if (!principal) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    const id = c.req.param("id");
    // Minting a credential is a governance action (org:manage — owner only).
    const decision = authorize(principal, id, "org:manage");
    if (!decision.allow) {
      return c.json({ error: "forbidden", reason: decision.reason, code: decision.code }, 403);
    }
    let body: { keyId?: string; name?: string; scopes?: string[] } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid body", code: "bad-request" }, 400);
    }
    if (!body.keyId || !body.name) {
      return c.json({ error: "keyId and name are required", code: "bad-request" }, 400);
    }
    try {
      const secret = (await import("node:crypto")).randomBytes(32).toString("hex");
      const { key, plaintextSecret } = newOrgApiKey(
        body.keyId,
        id,
        body.name,
        secret,
        body.scopes ?? [],
        principal.wallet.id,
      );
      createApiKey({ key, plaintextSecret });
      return c.json({ apiKey: key, secret: plaintextSecret }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message, code: "conflict" }, 409);
    }
  });

  app.get("/:id/api-keys", async (c) => {
    const principal = resolveWalletPrincipal(c);
    if (!principal) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    const id = c.req.param("id");
    if (!isMemberOf(principal.wallet.id, id)) {
      return c.json({ error: "forbidden", code: "not-a-member" }, 403);
    }
    const keys = listApiKeysForOrg(id).map((k) => ({ ...k, secretHash: undefined }));
    return c.json({ apiKeys: keys });
  });

  app.delete("/:id/api-keys/:keyId", async (c) => {
    const principal = resolveWalletPrincipal(c);
    if (!principal) {
      return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    }
    const id = c.req.param("id");
    // Revoking a credential is a governance action (org:manage — owner only).
    const decision = authorize(principal, id, "org:manage");
    if (!decision.allow) {
      return c.json({ error: "forbidden", reason: decision.reason, code: decision.code }, 403);
    }
    const keyId = c.req.param("keyId");
    const ok = revokeApiKey(keyId, id);
    if (!ok) {
      return c.json({ error: "not found", code: "no-such-key" }, 404);
    }
    return c.json({ revoked: true });
  });

  return app;
}
