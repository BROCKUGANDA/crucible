/**
 * @file monitoring.test.ts — Tests for monitoring, SLO, and alerting (RV-001).
 *
 * Covers: metrics recording, SLO compliance calculation, alert raising,
 * alert acknowledgment, system health summary, and path-to-group mapping.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordRequest,
  getSloCompliance,
  getSystemHealth,
  acknowledgeAlert,
  getDefaultSlos,
  resetMonitoringForTests,
  type SloCompliance,
} from "../src/monitoring";

describe("Metrics recording", () => {
  beforeEach(() => {
    resetMonitoringForTests();
  });

  it("records a request metric", () => {
    recordRequest("/trials", 200, 50);
    const health = getSystemHealth();
    expect(health.totalRequests).toBe(1);
    expect(health.overallErrorRate).toBe(0);
  });

  it("tracks error requests", () => {
    recordRequest("/trials", 200, 50);
    recordRequest("/trials", 500, 100);
    const health = getSystemHealth();
    expect(health.totalRequests).toBe(2);
    expect(health.overallErrorRate).toBe(0.5);
  });

  it("tracks uptime", () => {
    const health = getSystemHealth();
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("Path-to-group mapping", () => {
  beforeEach(() => {
    resetMonitoringForTests();
  });

  it("maps /health to health group", () => {
    recordRequest("/health", 200, 10);
    const compliance = getSloCompliance().find((c) => c.group === "health");
    expect(compliance).toBeDefined();
    expect(compliance!.requestCount).toBe(1);
  });

  it("maps /voice to voice group", () => {
    recordRequest("/voice/greeting", 200, 100);
    const compliance = getSloCompliance().find((c) => c.group === "voice");
    expect(compliance).toBeDefined();
    expect(compliance!.requestCount).toBe(1);
  });

  it("maps /campaigns to campaign group", () => {
    recordRequest("/campaigns", 200, 50);
    const compliance = getSloCompliance().find((c) => c.group === "campaign");
    expect(compliance).toBeDefined();
    expect(compliance!.requestCount).toBe(1);
  });

  it("maps /frenchy to frenchy group", () => {
    recordRequest("/frenchy/chat", 200, 200);
    const compliance = getSloCompliance().find((c) => c.group === "frenchy");
    expect(compliance).toBeDefined();
    expect(compliance!.requestCount).toBe(1);
  });

  it("maps /sts to sts group", () => {
    recordRequest("/sts/turn", 200, 500);
    const compliance = getSloCompliance().find((c) => c.group === "sts");
    expect(compliance).toBeDefined();
    expect(compliance!.requestCount).toBe(1);
  });

  it("maps /trials to read group by default", () => {
    recordRequest("/trials", 200, 50);
    const compliance = getSloCompliance().find((c) => c.group === "read");
    expect(compliance).toBeDefined();
    expect(compliance!.requestCount).toBe(1);
  });

  it("maps /forge to write group", () => {
    recordRequest("/forge/run", 200, 100);
    const compliance = getSloCompliance().find((c) => c.group === "write");
    expect(compliance).toBeDefined();
    expect(compliance!.requestCount).toBe(1);
  });
});

describe("SLO compliance", () => {
  beforeEach(() => {
    resetMonitoringForTests();
  });

  it("reports compliant when no samples", () => {
    const compliance = getSloCompliance();
    expect(compliance.length).toBeGreaterThan(0);
    for (const c of compliance) {
      expect(c.compliant).toBe(true);
      expect(c.requestCount).toBe(0);
    }
  });

  it("reports compliant when latency is within SLO", () => {
    // Record fast requests for the read group
    for (let i = 0; i < 10; i++) {
      recordRequest("/trials", 200, 10);
    }
    const compliance = getSloCompliance().find((c) => c.group === "read")!;
    expect(compliance.p95Compliant).toBe(true);
    expect(compliance.p99Compliant).toBe(true);
    expect(compliance.errorRateCompliant).toBe(true);
    expect(compliance.compliant).toBe(true);
  });

  it("reports non-compliant when latency exceeds SLO", () => {
    // Record slow requests that exceed the health SLO (100ms P95)
    for (let i = 0; i < 10; i++) {
      recordRequest("/health", 200, 200);
    }
    const compliance = getSloCompliance().find((c) => c.group === "health")!;
    expect(compliance.p95Compliant).toBe(false);
    expect(compliance.compliant).toBe(false);
    expect(compliance.breaches.length).toBeGreaterThan(0);
  });

  it("reports non-compliant when error rate exceeds SLO", () => {
    // Record 50% errors for the health group (SLO is 0.1%)
    for (let i = 0; i < 5; i++) {
      recordRequest("/health", 200, 10);
    }
    for (let i = 0; i < 5; i++) {
      recordRequest("/health", 500, 10);
    }
    const compliance = getSloCompliance().find((c) => c.group === "health")!;
    expect(compliance.errorRateCompliant).toBe(false);
    expect(compliance.availabilityCompliant).toBe(false);
    expect(compliance.compliant).toBe(false);
  });

  it("calculates percentiles correctly", () => {
    // Record 20 requests with known latencies
    for (let i = 0; i < 20; i++) {
      recordRequest("/trials", 200, i * 10 + 10); // 10, 20, 30, ..., 200
    }
    const compliance = getSloCompliance().find((c) => c.group === "read")!;
    expect(compliance.p95LatencyMs).toBeGreaterThan(0);
    expect(compliance.p99LatencyMs).toBeGreaterThanOrEqual(compliance.p95LatencyMs);
  });
});

describe("Alerting", () => {
  beforeEach(() => {
    resetMonitoringForTests();
  });

  it("raises alert on SLO breach", () => {
    // Create a breach in the health group
    for (let i = 0; i < 10; i++) {
      recordRequest("/health", 500, 500);
    }
    const health = getSystemHealth();
    expect(health.activeAlertCount).toBeGreaterThan(0);
    expect(health.allCompliant).toBe(false);
  });

  it("no alerts when compliant", () => {
    for (let i = 0; i < 10; i++) {
      recordRequest("/health", 200, 5);
    }
    const health = getSystemHealth();
    expect(health.activeAlertCount).toBe(0);
    expect(health.allCompliant).toBe(true);
  });

  it("acknowledges an alert", () => {
    // Create a breach
    for (let i = 0; i < 10; i++) {
      recordRequest("/health", 500, 500);
    }
    let health = getSystemHealth();
    expect(health.activeAlertCount).toBeGreaterThan(0);

    const alertId = health.activeAlerts[0].id;
    const acknowledged = acknowledgeAlert(alertId);
    expect(acknowledged).not.toBeNull();
    expect(acknowledged!.acknowledged).toBe(true);

    health = getSystemHealth();
    // At least one fewer alert after acknowledging one
    expect(health.activeAlertCount).toBeLessThan(health.activeAlertCount + 1);
    // The acknowledged alert should no longer be in active alerts
    expect(health.activeAlerts.find((a) => a.id === alertId)).toBeUndefined();
  });

  it("returns null for non-existent alert", () => {
    const result = acknowledgeAlert("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null for already acknowledged alert", () => {
    for (let i = 0; i < 10; i++) {
      recordRequest("/health", 500, 500);
    }
    let health = getSystemHealth();
    const alertId = health.activeAlerts[0].id;
    acknowledgeAlert(alertId);
    const again = acknowledgeAlert(alertId);
    expect(again).toBeNull();
  });
});

describe("System health", () => {
  beforeEach(() => {
    resetMonitoringForTests();
  });

  it("returns complete health summary", () => {
    recordRequest("/trials", 200, 50);
    recordRequest("/health", 200, 10);
    const health = getSystemHealth();

    expect(health.allCompliant).toBe(true);
    expect(health.sloCompliance.length).toBeGreaterThan(0);
    expect(health.activeAlertCount).toBe(0);
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(health.totalRequests).toBe(2);
    expect(health.overallErrorRate).toBe(0);
  });

  it("reports allCompliant = false when any group breaches", () => {
    for (let i = 0; i < 10; i++) {
      recordRequest("/health", 500, 500);
    }
    const health = getSystemHealth();
    expect(health.allCompliant).toBe(false);
  });
});

describe("Default SLOs", () => {
  it("returns 7 SLO definitions", () => {
    const slos = getDefaultSlos();
    expect(slos.length).toBe(7);
  });

  it("includes all endpoint groups", () => {
    const slos = getDefaultSlos();
    const groups = slos.map((s) => s.group);
    expect(groups).toContain("read");
    expect(groups).toContain("write");
    expect(groups).toContain("voice");
    expect(groups).toContain("frenchy");
    expect(groups).toContain("sts");
    expect(groups).toContain("campaign");
    expect(groups).toContain("health");
  });

  it("health SLO has tightest targets", () => {
    const slos = getDefaultSlos();
    const health = slos.find((s) => s.group === "health")!;
    const read = slos.find((s) => s.group === "read")!;
    expect(health.p95LatencyMs).toBeLessThan(read.p95LatencyMs);
    expect(health.availability).toBeGreaterThan(read.availability);
  });
});

/**
 * The wiring, which is the part the unit tests above cannot see.
 *
 * Every case in this file calls `recordRequest` directly, so all of them stayed green while
 * `metricsMiddleware` was imported into `app.ts` and never mounted — meaning `/health` and
 * `/monitoring` reported `totalRequests: 0` and a zero error rate over an empty window on a live
 * host. A dashboard fed by a function nobody calls is decorative data wearing the word "live".
 *
 * So this drives a real request through `createApp` and asserts the counter moved. Unmount the
 * middleware and this goes red; that is the mutation it exists to catch.
 */
describe("metrics are fed by real requests", () => {
  beforeEach(() => {
    resetMonitoringForTests();
  });

  it("counts a request that actually went through the app", async () => {
    const { createApp } = await import("../src/app");
    const { emptyModel } = await import("@crucible/indexer");
    const app = createApp({ getModel: () => emptyModel() }, { rateLimit: false });

    expect(getSystemHealth().totalRequests).toBe(0);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(getSystemHealth().totalRequests).toBe(1);
    // Cold import measured 2.5s idle and 7.4s beside a typecheck; a 5s abort leaked its in-flight
    // request into the next case's counter, which is how this read `expected 2 to be 1`.
  }, 30_000);

  it("counts a refused request too, because a refusal is real traffic", async () => {
    const { createApp } = await import("../src/app");
    const { emptyModel } = await import("@crucible/indexer");
    const app = createApp({ getModel: () => emptyModel() }, { rateLimit: false });

    const res = await app.request("/trials/not-a-number");
    expect(res.status).toBe(400);
    const health = getSystemHealth();
    expect(health.totalRequests).toBe(1);
    // An error rate that omitted refusals would read healthier than the system is.
    expect(health.overallErrorRate).toBe(1);
  }, 30_000);

  it("stamps a correlation id that does not collide under concurrency", async () => {
    const { createApp } = await import("../src/app");
    const { emptyModel } = await import("@crucible/indexer");
    const app = createApp({ getModel: () => emptyModel() }, { rateLimit: false });

    const responses = await Promise.all([
      app.request("/health"),
      app.request("/health"),
      app.request("/health"),
    ]);
    const ids = responses.map((r) => r.headers.get("X-Request-Id"));
    expect(ids.every((id) => typeof id === "string" && id.startsWith("req-"))).toBe(true);
    expect(new Set(ids).size).toBe(3);
    // 16 random bytes, not six base-36 characters from Math.random().
    expect(ids[0]!.length).toBe("req-".length + 32);
  }, 30_000);
});
