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
import { configuredChainId } from "./auth.js";
import {
  buildOrganisationPrincipal,
  getOrganisation,
  organisationsForPrincipal,
  isMemberOf,
  type OrganisationPrincipal,
} from "@crucible/agent-security";

function resolveWalletPrincipal(c: Context): OrganisationPrincipal | null {
  const auth = {
    walletAddress: null as string | null,
    sessionId: null as string | null,
    chainId: configuredChainId(),
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
      id: `eip155:${configuredChainId()}:${auth.walletAddress.toLowerCase()}`,
      sessionId: auth.sessionId,
      authenticated: true,
    },
  );
  return principal;
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

  return app;
}
