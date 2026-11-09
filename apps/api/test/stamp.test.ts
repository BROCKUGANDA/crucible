process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  createStampRoutes,
  holderPortion,
  ratableReduce,
  monthlyReleases,
} from "../src/stamp.js";

const DEV_SECRET = "crucible-local-dev-secret-not-for-production";

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

const REVIEWER = "0x" + "11".repeat(20);
const STRANGER = "0x" + "22".repeat(20);

describe("STAMP reviewer gate", () => {
  it("refuses every admin route when no reviewer is configured", async () => {
    const app = createStampRoutes({ mode: "sandbox", reviewers: [] });
    const res = await app.request("/admin/instruments", {
      method: "POST",
      headers: headers(REVIEWER),
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("stamp_no_reviewers");
  });

  it("admits the configured reviewer and refuses another session", async () => {
    const app = createStampRoutes({ mode: "sandbox", reviewers: [REVIEWER] });

    const admitted = await app.request("/admin/instruments", {
      method: "POST",
      headers: headers(REVIEWER),
      body: JSON.stringify({}),
    });
    expect(admitted.status).toBe(201);

    const refused = await app.request("/admin/instruments", {
      method: "POST",
      headers: headers(STRANGER),
      body: JSON.stringify({}),
    });
    expect(refused.status).toBe(403);

    const read = await app.request("/admin/instruments/x", { headers: headers(STRANGER) });
    expect(read.status).toBe(403);
  });
});

describe("STAMP sandbox e2e", () => {
  it("sandbox observe route is session-gated", async () => {
    const app = createStampRoutes({ mode: "sandbox" });
    // Without a session the route refuses first — that is the auth boundary.
    const res = await app.request("/admin/payments/observe", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("production verify route refuses without session", async () => {
    const prod = createStampRoutes({ mode: "production" });
    const res = await prod.request("/admin/payments/x/verify", { method: "POST", body: "{}" });
    // 401 (no session) fires before the production gate — both are refusals.
    expect([401, 403]).toContain(res.status);
  });

  it("disabled mode answers 404", async () => {
    const app = createStampRoutes({ mode: "disabled" });
    const res = await app.request("/protocol/ownership");
    expect(res.status).toBe(404);
  });

  it("pure math: vesting vector + cap + portion", async () => {
    // pure math: 24-month vector sums exactly
    const v = monthlyReleases(100n * 10n ** 18n);
    expect(v).toHaveLength(24);
    expect(v.reduce((a, b) => a + b, 0n)).toBe(100n * 10n ** 18n);

    // cap: 25% + 10% → reduced to 20% total
    const eff = ratableReduce([2500n, 1000n]);
    expect(eff.reduce((a, b) => a + b, 0n)).toBe(2000n);

    // portion: 5% of 1M tokens
    expect(holderPortion(500n, 1_000_000n)).toBe(50_000n);
  });
});
