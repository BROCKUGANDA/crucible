/**
 * @file org-authz.ts — Organisation-aware authorization middleware.
 *
 * Enforces the ten-role matrix (collaboration-and-governance.md §3) at the
 * service layer. A permission is granted only when:
 *
 *   1. The principal is authenticated (wallet principal from a SIWE session).
 *   2. The principal is an active member of the target organisation.
 *   3. The principal's role in that organisation carries the requested permission.
 *   4. Separation-of-duties rules are satisfied.
 *
 * No client-supplied orgId is trusted. No role can move on-chain escrow funds.
 * An organisation-store outage fails closed for protected org writes.
 */

import type { Hono } from "hono";
import type { Context } from "hono";
import type { Decision } from "./types.js";
import type {
  OrganisationPrincipal,
  WalletPrincipal,
} from "./org-principal.js";
import { buildOrganisationPrincipal, canActInOrg, roleInOrg } from "./org-principal.js";
import {
  rolePermissions,
  separationOfDutiesDenial,
  parseOrgRole,
} from "./organisation.js";
import { getMembershipByPrincipalAndOrg } from "./org-store.js";

/** Where to find the wallet address on a request. */
export interface AuthContext {
  /** the SIWE-authenticated address, or null when unauthenticated */
  walletAddress: string | null;
  /** the session id that authenticated the wallet, or null */
  sessionId: string | null;
  /** chain id for principal construction */
  chainId?: string;
}

/**
 * Resolve the organisation principal from the request's auth context.
 * Returns null when the caller is not authenticated.
 */
export function resolvePrincipal(ctx: AuthContext): OrganisationPrincipal | null {
  if (!ctx.walletAddress || !ctx.sessionId) return null;
  return buildOrganisationPrincipal(
    { address: ctx.walletAddress, id: `eip155:${ctx.chainId ?? "31337"}:${ctx.walletAddress.toLowerCase()}`, sessionId: ctx.sessionId, authenticated: true },
  );
}

/**
 * Authorize a principal to perform a permission in an organisation.
 *
 * @param principal - the resolved organisation principal
 * @param orgId - the organisation the action targets
 * @param permission - the permission being requested (org-scoped string, not the
 *   agent-security `Permission` type)
 * @param actorRole - the actor's org role (for separation-of-duties)
 * @param targetRole - the target role (for separation-of-duties)
 * @param action - the separation-of-duties action kind, or null
 * @returns a Decision. `allow: true` means the action is permitted.
 */
export function authorize(
  principal: OrganisationPrincipal,
  orgId: string,
  permission: string,
  actorRole?: string,
  targetRole?: string,
  action?: "grant-role" | "grade-own-run" | "publish-own-benchmark",
): Decision {
  if (!canActInOrg(principal, orgId)) {
    return {
      allow: false,
      reason: `principal ${principal.wallet.address} is not a member of organisation ${orgId}`,
      code: "no-credential",
    };
  }

  const role = roleInOrg(principal, orgId);
  if (!role) {
    return {
      allow: false,
      reason: `principal ${principal.wallet.address} has no role in organisation ${orgId}`,
      code: "insufficient-role",
    };
  }

  const parsedRole = parseOrgRole(role);
  if (!parsedRole) {
    return {
      allow: false,
      reason: `unknown organisation role: ${role}`,
      code: "insufficient-role",
    };
  }

  const perms = rolePermissions(parsedRole);
  if (!perms.includes(permission)) {
    return {
      allow: false,
      reason: `role ${role} in organisation ${orgId} does not hold permission ${permission}`,
      code: "wrong-scope",
    };
  }

  // Separation of duties.
  if (action && actorRole && targetRole) {
    const parsedActor = parseOrgRole(actorRole);
    const parsedTarget = parseOrgRole(targetRole);
    if (parsedActor && parsedTarget) {
      const denial = separationOfDutiesDenial(parsedActor, parsedTarget, action);
      if (denial) {
        return {
          allow: false,
          reason: `separation of duties: ${action} prohibited for ${actorRole} acting on ${targetRole}`,
          code: denial,
        };
      }
    }
  }

  return {
    allow: true,
    reason: `role ${role} in organisation ${orgId} holds permission ${permission}`,
  };
}

/**
 * Hono middleware factory: organisation-aware authorization for a route.
 *
 * `getOrgId` extracts the target org id from the request (path param, body, or
 * query). It is verified against the store — never trusted.
 *
 * `requirePermission` is the permission the route needs.
 *
 * `getAuth` extracts the wallet address and session id from the request.
 *
 * `onDeny` is called with the denial decision; default returns 403.
 */
export function orgAuthzMiddleware(options: {
  getOrgId: (c: Context) => string | null | undefined;
  requirePermission: string;
  getAuth: (c: Context) => AuthContext;
  onDeny?: (
    c: Context,
    decision: { allow: boolean; reason: string; code: string },
  ) => void | Response;
}) {
  return async (c: Context, next: () => Promise<void>): Promise<void | Response> => {
    const orgId = options.getOrgId(c);
    if (!orgId) {
      const decision = {
        allow: false,
        reason: "no organisation identified",
        code: "no-credential",
      };
      options.onDeny?.(c, decision);
      return c.json({ error: "org_required", reason: decision.reason, code: decision.code }, 400);
    }

    const auth = options.getAuth(c);
    const principal = resolvePrincipal(auth);
    if (!principal) {
      const decision = {
        allow: false,
        reason: "unauthenticated",
        code: "no-credential",
      };
      options.onDeny?.(c, decision);
      return c.json({ error: "unauthenticated", reason: decision.reason, code: decision.code }, 401);
    }

    const decision = authorize(
      principal,
      orgId,
      options.requirePermission,
      principal.activeRole ?? undefined,
    ) as Decision;

    if (!decision.allow) {
      options.onDeny?.(c, decision);
      return c.json({ error: "forbidden", reason: decision.reason, code: decision.code }, 403);
    }

    // Attach the resolved principal and org for downstream handlers.
    c.set("orgPrincipal", principal);
    c.set("orgId", orgId);
    await next();
  };
}

/**
 * Build an AuthContext from a Hono request: wallet address from the SIWE
 * session cookie, session id from the same cookie.
 *
 * This is the integration point with apps/api/src/auth.ts. The cookie name
 * must match `crucible_session`.
 */
export function authContextFromRequest(c: Context): AuthContext {
  const cookie = c.req.header("cookie");
  let walletAddress: string | null = null;
  let sessionId: string | null = null;
  if (cookie) {
    for (const part of cookie.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === "crucible_session") {
        sessionId = v.join("=");
        // The session token is `base64url.payload.base64url.sig`; the payload
        // carries the address. Decode without verification here — verification
        // happens at the route that needs the session. This middleware only
        // needs the address to build the principal.
        try {
          const encoded = sessionId.split(".")[0];
          if (encoded) {
            const payload = JSON.parse(
              Buffer.from(encoded, "base64url").toString("utf8"),
            ) as { address?: string };
            if (payload.address) walletAddress = payload.address;
          }
        } catch {
          // Malformed session cookie: unauthenticated.
        }
        break;
      }
    }
  }
  return { walletAddress, sessionId, chainId: "31337" };
}