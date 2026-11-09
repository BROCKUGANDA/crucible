/**
 * @file engrams-routes.test.ts — the /engrams/evaluate keeper gate.
 *
 * The bearer must be compared in constant time and must not be a short,
 * guessable credential; every failure fails closed.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createEngramRoutes } from "../src/engrams";

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
