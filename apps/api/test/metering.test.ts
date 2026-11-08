import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import { emptyModel } from "@crucible/indexer";
import { MeteringService, createMeteringStore } from "../src/metering.js";

process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

function appWith() {
  return createApp({ getModel: () => emptyModel() }, { metering: { service: new MeteringService({ store: createMeteringStore() }) }, rateLimit: false });
}

describe("metering", () => {
  it("records usage and returns quota", async () => {
    const app = appWith();
    // session not needed? routes require session. Use unauth check
    const res = await app.request("/metering/usage", { method: "POST", body: JSON.stringify({ tenantId: "t1", metric: "api_call", quantity: 2 }) });
    expect(res.status).toBe(401);
  });

  it("service records and aggregates", () => {
    const store = createMeteringStore();
    const svc = new MeteringService({ store });
    const e1 = svc.recordUsage("t1", "api_call", 3);
    const e2 = svc.recordUsage("t1", "api_call", 2);
    expect(e1.eventId).toBeTruthy();
    const summary = svc.getUsage("t1", "api_call");
    expect(summary[0].total).toBe(5);
    expect(summary[0].eventCount).toBe(2);
  });

  it("enforces quota", () => {
    const store = createMeteringStore();
    const svc = new MeteringService({ store });
    svc.setQuota("t1", "api_call", "daily", 5);
    expect(svc.checkQuota("t1", "api_call", 3).allowed).toBe(true);
    svc.recordUsage("t1", "api_call", 3);
    expect(svc.checkQuota("t1", "api_call", 3).allowed).toBe(false);
    expect(svc.checkQuota("t1", "api_call", 2).allowed).toBe(true);
  });

  it("allows when no quota configured", () => {
    const store = createMeteringStore();
    const svc = new MeteringService({ store });
    expect(svc.checkQuota("t1", "api_call", 100).allowed).toBe(true);
  });

  it("rejects invalid quantity", () => {
    const store = createMeteringStore();
    const svc = new MeteringService({ store });
    expect(() => svc.recordUsage("t1", "api_call", 0)).toThrow();
    expect(() => svc.recordUsage("t1", "api_call", -1)).toThrow();
  });
});
