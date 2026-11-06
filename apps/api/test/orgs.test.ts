// The auth routes fail closed: a missing secret means no session is signed.
process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createApp } from "../src/app.js";
import {
  createOrganisation,
  newOrganisation,
  __resetForgeStoreForTests,
} from "@crucible/agent-security";
import { emptyModel } from "@crucible/indexer";

process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

const OWNER = `0x${"11".repeat(20)}`;
const STRANGER = `0x${"33".repeat(20)}`;
const ORG_ID = "org-test";
const DEV_SECRET = "crucible-local-dev-secret-not-for-production";

const ownerPrincipalId = `eip155:31337:${OWNER.toLowerCase()}`;
const testOrg = newOrganisation(ORG_ID, "Test Org", "test-org", ownerPrincipalId);
createOrganisation(testOrg);

function sessionHeaders(
  address: string,
  options: { expiresInSeconds?: number; audience?: string } = {},
): Headers {
  const now = Date.now();
  const payload = {
    address,
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + (options.expiresInSeconds ?? 60 * 60 * 24 * 7),
    aud: options.audience ?? "http://localhost:3000",
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = Buffer.from(
    createHmac("sha256", DEV_SECRET).update(encoded).digest("base64url"),
  ).toString("base64url");
  const token = `${encoded}.${sig}`;
  return new Headers({
    cookie: `crucible_session=${token}`,
    "content-type": "application/json",
  });
}

function appWith() {
  return createApp({ getModel: () => emptyModel() }, { rateLimit: false });
}

afterEach(() => {
  __resetForgeStoreForTests();
});

describe("Org routes", () => {
  it("lists organisations for an authenticated member", async () => {
    const app = appWith();
    const res = await app.request("/orgs", { headers: sessionHeaders(OWNER) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.organisations)).toBe(true);
    expect(body.organisations.some((o: { id: string }) => o.id === ORG_ID)).toBe(true);
  });

  it("gets an organisation by id for a member", async () => {
    const app = appWith();
    const res = await app.request(`/orgs/${ORG_ID}`, { headers: sessionHeaders(OWNER) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organisation.id).toBe(ORG_ID);
  });

  it("rejects unauthenticated callers", async () => {
    const app = appWith();
    const res = await app.request("/orgs");
    expect(res.status).toBe(401);
  });

  it("rejects a forged session cookie with an invalid HMAC", async () => {
    const headers = sessionHeaders(OWNER);
    const token = headers.get("cookie")!.replace("crucible_session=", "");
    const [payload] = token.split(".");
    headers.set("cookie", `crucible_session=${payload}.${Buffer.alloc(32, 0).toString("base64url")}`);

    const res = await appWith().request("/orgs", { headers });
    expect(res.status).toBe(401);
  });

  it("rejects a session issued for a different audience", async () => {
    const res = await appWith().request("/orgs", {
      headers: sessionHeaders(OWNER, { audience: "https://attacker.example" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an expired session", async () => {
    const res = await appWith().request("/orgs", {
      headers: sessionHeaders(OWNER, { expiresInSeconds: -1 }),
    });
    expect(res.status).toBe(401);
  });

  it("forbids non-members", async () => {
    const app = appWith();
    const res = await app.request(`/orgs/${ORG_ID}`, { headers: sessionHeaders(STRANGER) });
    expect(res.status).toBe(403);
  });
});
