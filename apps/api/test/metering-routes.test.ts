/**
 * @file metering-routes.test.ts — tenancy is membership, and quota-setting is
 * a role decision (2026-11-09 audit, AUTHZ-F4).
 */

process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { createMeteringRoutes } from "../src/metering-routes";
import {
  createOrganisation,
  createMembership,
  newMembership,
  newOrganisation,
} from "@crucible/agent-security";

const TENANT = "org-meters";
const OWNER = "0x" + "11".repeat(20);
const MEMBER = "0x" + "22".repeat(20);
const STRANGER = "0x" + "33".repeat(20);
const DEV_SECRET = "crucible-local-dev-secret-not-for-production";

const ownerPrincipalId = `eip155:31337:${OWNER.toLowerCase()}`;
createOrganisation(newOrganisation(TENANT, "Meters", "meters", ownerPrincipalId));
createMembership(
  newMembership(
    "mem-meters-readonly",
    TENANT,
    `eip155:31337:${MEMBER.toLowerCase()}`,
    "org.readonly.analyst",
    ownerPrincipalId,
  ),
);

function headers(address: string): Headers {
  const now = Date.now();
  const payload = {
    address,
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + 60 * 60 * 24 * 7,
    aud: "http://localhost:3000",
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", DEV_SECRET).update(encoded).digest("base64url");
  return new Headers({
    cookie: `__Host-crucible_session=${encoded}.${sig}`,
    "content-type": "application/json",
  });
}

const post = (app: ReturnType<typeof createMeteringRoutes>, path: string, address: string, body: unknown) =>
  app.request(path, { method: "POST", headers: headers(address), body: JSON.stringify(body) });

describe("metering tenancy and role binding", () => {
  it("refuses a tenant the caller does not belong to", async () => {
    const app = createMeteringRoutes();

    const usage = await post(app, "/usage", STRANGER, { tenantId: TENANT, metric: "tokens" });
    expect(usage.status).toBe(403);

    const quota = await app.request(`/quota/${TENANT}`, { headers: headers(STRANGER) });
    expect(quota.status).toBe(403);

    const check = await post(app, "/check", STRANGER, { tenantId: TENANT, metric: "tokens", quantity: 1 });
    expect(check.status).toBe(403);
  });

  it("a member records usage but cannot set the tenant's quota", async () => {
    const app = createMeteringRoutes();

    const usage = await post(app, "/usage", MEMBER, { tenantId: TENANT, metric: "tokens", quantity: 2 });
    expect(usage.status).toBe(201);

    const quota = await post(app, "/quota", MEMBER, { tenantId: TENANT, metric: "tokens", limit: 100 });
    expect(quota.status).toBe(403);
  });

  it("the owner can set a quota and the remaining is measured against it", async () => {
    const app = createMeteringRoutes();

    const quota = await post(app, "/quota", OWNER, { tenantId: TENANT, metric: "tokens", limit: 5 });
    expect(quota.status).toBe(201);

    const usage = await post(app, "/usage", OWNER, { tenantId: TENANT, metric: "tokens", quantity: 2 });
    expect(usage.status).toBe(201);

    const check = await post(app, "/check", OWNER, { tenantId: TENANT, metric: "tokens", quantity: 1 });
    expect(check.status).toBe(200);
    expect(((await check.json()) as { remaining: number }).remaining).toBe(3);
  });

  it("an unquota'd metric reports remaining null, not zero", async () => {
    const app = createMeteringRoutes();
    const check = await post(app, "/check", OWNER, { tenantId: TENANT, metric: "unmetered", quantity: 1 });
    expect(check.status).toBe(200);
    const body = (await check.json()) as { remaining: number | null };
    expect(body.remaining).toBeNull();
  });

  it("rejects a non-positive usage quantity as a 400", async () => {
    const app = createMeteringRoutes();
    const usage = await post(app, "/usage", OWNER, { tenantId: TENANT, metric: "tokens", quantity: 0 });
    expect(usage.status).toBe(400);
  });
});
