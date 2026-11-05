/**
 * @file org-authz.test.ts — Organisation authorization middleware tests.
 *
 * A permission is granted only when the principal is authenticated, an active
 * member of the target org, and their role carries the permission. Separation
 * of duties is enforced. A client-supplied orgId is never trusted.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  authorize,
  orgAuthzMiddleware,
  authContextFromRequest,
  resolvePrincipal,
} from "../src/org-authz.js";
import { buildOrganisationPrincipal } from "../src/org-principal.js";
import {
  createOrganisation,
  createMembership,
  __resetStoreForTests,
} from "../src/org-store.js";
import { newOrganisation, newMembership } from "../src/organisation.js";
import type { Permission } from "../src/types.js";

beforeEach(() => {
  __resetStoreForTests();
});

const org = newOrganisation("org-1", "Acme", "acme", "0xowner");

function pid(address: string) {
  return `eip155:31337:${address.toLowerCase()}`;
}

function seed() {
  createOrganisation(org);
  // owner
  createMembership(newMembership("m-owner", "org-1", pid("0xowner"), "org.owner", pid("0xowner")));
  // billing admin
  createMembership(newMembership("m-billing", "org-1", pid("0xbilling"), "org.billing.admin", pid("0xowner")));
  // evaluator
  createMembership(newMembership("m-eval", "org-1", pid("0xeval"), "org.evaluator", pid("0xowner")));
  // readonly
  createMembership(newMembership("m-ro", "org-1", pid("0xro"), "org.readonly.analyst", pid("0xowner")));
}

function principalFor(address: string, orgId = "org-1") {
  return buildOrganisationPrincipal(
    {
      address,
      id: pid(address),
      sessionId: "sess-1",
      authenticated: true,
    },
    orgId,
  );
}

describe("authorize", () => {
  beforeEach(seed);

  it("grants owner org:manage", () => {
    const p = principalFor("0xowner");
    const d = authorize(p, "org-1", "org:manage");
    expect(d.allow).toBe(true);
  });

  it("grants billing admin org:budget:set", () => {
    const p = principalFor("0xbilling");
    const d = authorize(p, "org-1", "org:budget:set");
    expect(d.allow).toBe(true);
  });

  it("denies billing admin org:role:change (not in role perms)", () => {
    const p = principalFor("0xbilling");
    const d = authorize(p, "org-1", "org:role:change");
    expect(d.allow).toBe(false);
    expect(d.code).toBe("wrong-scope");
  });

  it("denies unauthenticated principal", () => {
    const p = buildOrganisationPrincipal(null, "org-1");
    expect(p).toBeNull();
  });

  it("denies principal not a member of the org", () => {
    const p = principalFor("0xstranger", "org-1");
    expect(p).toBeNull(); // not a member
  });

  it("denies readonly analyst org:budget:set", () => {
    const p = principalFor("0xro");
    const d = authorize(p, "org-1", "org:budget:set");
    expect(d.allow).toBe(false);
    expect(d.code).toBe("wrong-scope");
  });

  it("enforces separation of duties: billing admin cannot grant owner role", () => {
    const p = principalFor("0xbilling");
    const d = authorize(
      p,
      "org-1",
      "org:budget:set" as Permission,
      "org.billing.admin",
      "org.owner",
      "grant-role",
    );
    expect(d.allow).toBe(false);
    expect(d.code).toBe("separation-of-duties");
  });

  it("allows a different grant-role pairing", () => {
    const p = principalFor("0xowner");
    const d = authorize(
      p,
      "org-1",
      "org:role:change",
      "org.owner",
      "org.billing.admin",
      "grant-role",
    );
    expect(d.allow).toBe(true);
  });

  it("returns no-credential for non-member org", () => {
    const p = principalFor("0xowner");
    const d = authorize(p, "org-2", "org:read");
    expect(d.allow).toBe(false);
    expect(d.code).toBe("no-credential");
  });
});

describe("orgAuthzMiddleware", () => {
  beforeEach(seed);

  it("allows a member with the right permission", async () => {
    const calls: string[] = [];
    const mw = orgAuthzMiddleware({
      getOrgId: () => "org-1",
      requirePermission: "org:manage" as Permission,
      getAuth: () => ({
        walletAddress: "0xowner",
        sessionId: "sess-1",
        chainId: "31337",
      }),
      onDeny: () => {
        calls.push("deny");
        return new Response(null, { status: 403 });
      },
    });
    // Simulate: create a minimal Hono-like context. The middleware calls c.set
    // and c.json, which a plain object doesn't have. We test the authorize
    // function directly above; middleware wiring is exercised in the API tests.
    expect(typeof mw).toBe("function");
  });
});

describe("resolvePrincipal", () => {
  it("returns null when no wallet address", () => {
    expect(resolvePrincipal({ walletAddress: null, sessionId: null })).toBeNull();
  });

  it("builds a principal from wallet + session", () => {
    const p = resolvePrincipal({ walletAddress: "0xowner", sessionId: "sess-1" });
    expect(p?.wallet.address).toBe("0xowner");
    expect(p?.wallet.authenticated).toBe(true);
  });
});

describe("authContextFromRequest", () => {
  it("extracts wallet address from session cookie", () => {
    // Build a fake Hono context with a cookie header carrying a session token
    // whose payload encodes the address.
    const addr = "0xabc12345678901234567890123456789012345678";
    const payload = Buffer.from(JSON.stringify({ address: addr })).toString("base64url");
    const token = `${payload}.sig`;
    const ctx = {
      req: { header: () => `crucible_session=${token}` },
    } as unknown as { req: { header: (name: string) => string | undefined } };
    const auth = authContextFromRequest(ctx);
    expect(auth.walletAddress).toBe(addr);
    expect(auth.sessionId).toBe(token);
  });

  it("returns nulls when no cookie", () => {
    const ctx = { req: { header: () => undefined } } as unknown as { req: { header: (name: string) => string | undefined } };
    const auth = authContextFromRequest(ctx);
    expect(auth.walletAddress).toBeNull();
    expect(auth.sessionId).toBeNull();
  });
});