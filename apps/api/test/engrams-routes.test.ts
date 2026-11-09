/**
 * @file engrams-routes.test.ts — the /engrams/evaluate keeper gate.
 *
 * The bearer must be compared in constant time and must not be a short,
 * guessable credential; every failure fails closed.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { createEngramRoutes } from "../src/engrams";

process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

const DEV_SECRET = "crucible-local-dev-secret-not-for-production";

function sessionCookie(address: string): string {
  const now = Date.now();
  const payload = {
    address,
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + 60 * 60 * 24 * 7,
    aud: "http://localhost:3000",
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", DEV_SECRET).update(encoded).digest("base64url");
  return `__Host-crucible_session=${encoded}.${sig}`;
}

const LONG_KEY = "keeper-key-0123456789abcdef0123456789abcdef";

function authHeader(key: string, scheme = "Bearer"): string {
  return `${scheme} ${key}`;
}

async function evaluate(authorization?: string): Promise<{ status: number; body: { error?: string; code?: string } }> {
  const app = createEngramRoutes();
  const res = await app.request("/evaluate", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body: JSON.stringify({}),
  });
  return { status: res.status, body: await res.json() };
}

afterEach(() => {
  delete process.env.KEEPER_API_KEY;
});

describe("engrams evaluate keeper gate", () => {
  it("answers /me for the session's own address without a path address", async () => {
    const app = createEngramRoutes();
    const unauth = await app.request("/me");
    expect(unauth.status).toBe(401);

    const res = await app.request("/me", { headers: { cookie: sessionCookie("0x1111111111111111111111111111111111111111") } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entitlements: unknown[] };
    expect(Array.isArray(body.entitlements)).toBe(true);
  });

  it("refuses when no key is configured, even with an empty bearer", async () => {
    const r = await evaluate("Bearer ");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("not-a-worker");
  });

  it("refuses a key shorter than 32 bytes even when it matches", async () => {
    process.env.KEEPER_API_KEY = "short-key";
    const r = await evaluate(authHeader("short-key"));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("not-a-worker");
  });

  it("accepts a properly sized key over an exact bearer match", async () => {
    process.env.KEEPER_API_KEY = LONG_KEY;
    const r = await evaluate(authHeader(LONG_KEY));
    // Auth passed: the request proceeds to body validation, not the 403 gate.
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("bad-request");
  });

  it("refuses a wrong key and a wrong scheme", async () => {
    process.env.KEEPER_API_KEY = LONG_KEY;
    const wrong = await evaluate(authHeader("keeper-key-ffffffffffffffffffffffffffffffff"));
    expect(wrong.status).toBe(403);

    const scheme = await evaluate(`${LONG_KEY}`);
    expect(scheme.status).toBe(403);
  });
});
