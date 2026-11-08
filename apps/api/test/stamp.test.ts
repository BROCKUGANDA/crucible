import { describe, expect, it } from "vitest";
import {
  createStampRoutes,
  holderPortion,
  ratableReduce,
  monthlyReleases,
} from "../src/stamp.js";

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
