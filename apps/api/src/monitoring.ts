/**
 * @file monitoring.ts — SLO definitions, metrics collection, and alerting (RV-001).
 *
 * Builds on the existing health/readiness endpoints and DLQ to provide:
 *
 *   1. **SLO definitions** — response time and availability targets per endpoint group.
 *   2. **Metrics collection** — request latency, error rates, and throughput tracking.
 *   3. **Alerting thresholds** — when a metric breaches an SLO, an alert is raised.
 *   4. **Health enrichment** — the `/health` endpoint reports SLO compliance.
 *
 * Design decisions:
 *
 *   1. **Metrics are in-memory with a sliding window.** A production deployment
 *      would ship to Prometheus/Datadog, but the in-memory window gives immediate
 *      feedback for development and single-process deployments.
 *   2. **SLOs are per-endpoint-group, not per-route.** Grouping by domain (read,
 *      write, voice, frenchy) keeps the surface manageable and matches how
 *      operators think about their system.
 *   3. **Alerts are sticky until acknowledged.** A breach is recorded once per
 *      window, not on every request. The operator sees "SLO breached" not a
 *      firehose of identical alerts.
 *   4. **The monitor is passive.** It does not block requests, modify responses,
 *      or inject latency. It only observes and records.
 */

import { randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Endpoint groups for SLO tracking. */
export type EndpointGroup = "read" | "write" | "voice" | "frenchy" | "sts" | "campaign" | "health";

/** Runtime list of all endpoint groups (types don't exist at runtime). */
const ENDPOINT_GROUPS: EndpointGroup[] = [
  "read",
  "write",
  "voice",
  "frenchy",
  "sts",
  "campaign",
  "health",
];

/** SLO definition for an endpoint group. */
export interface SloDefinition {
  /** The endpoint group this SLO applies to. */
  group: EndpointGroup;

  /** P95 response time target in milliseconds. */
  p95LatencyMs: number;

  /** P99 response time target in milliseconds. */
  p99LatencyMs: number;

  /** Error rate target (0.0-1.0). E.g., 0.01 = 1% error rate. */
  errorRate: number;

  /** Availability target (0.0-1.0). E.g., 0.999 = 99.9% availability. */
  availability: number;

  /** Window size in seconds for SLO calculation. */
  windowSeconds: number;
}

/** A single request metric sample. */
export interface RequestMetric {
  /** Wall-clock timestamp. */
  at: number;

  /** Endpoint group. */
  group: EndpointGroup;

  /** Request path. */
  path: string;

  /** Response status code. */
  status: number;

  /** Response time in milliseconds. */
  latencyMs: number;

  /** Whether the request resulted in an error (4xx/5xx). */
  isError: boolean;
}

/** SLO compliance status for an endpoint group. */
export interface SloCompliance {
  /** The endpoint group. */
  group: EndpointGroup;

  /** Whether the SLO is currently met. */
  compliant: boolean;

  /** P95 latency vs target. */
  p95LatencyMs: number;
  p95TargetMs: number;
  p95Compliant: boolean;

  /** P99 latency vs target. */
  p99LatencyMs: number;
  p99TargetMs: number;
  p99Compliant: boolean;

  /** Error rate vs target. */
  errorRate: number;
  errorRateTarget: number;
  errorRateCompliant: boolean;

  /** Availability vs target. */
  availability: number;
  availabilityTarget: number;
  availabilityCompliant: boolean;

  /** Total requests in window. */
  requestCount: number;

  /** Breach reasons if non-compliant. */
  breaches: string[];
}

/** An alert record. */
export interface Alert {
  /** Alert ID. */
  id: string;

  /** Wall-clock timestamp when the alert was raised. */
  raisedAt: number;

  /** The endpoint group that breached. */
  group: EndpointGroup;

  /** The SLO metric that breached. */
  metric: string;

  /** The actual value. */
  actual: number;

  /** The target value. */
  target: number;

  /** Human-readable description. */
  message: string;

  /** Whether the alert has been acknowledged. */
  acknowledged: boolean;

  /** When the alert was acknowledged, if applicable. */
  acknowledgedAt?: number;
}

/** Overall system health summary. */
export interface SystemHealth {
  /** Whether all SLOs are compliant. */
  allCompliant: boolean;

  /** SLO compliance per endpoint group. */
  sloCompliance: SloCompliance[];

  /** Active (unacknowledged) alerts. */
  activeAlerts: Alert[];

  /** Total active alerts count. */
  activeAlertCount: number;

  /** System uptime in seconds. */
  uptimeSeconds: number;

  /** Total requests processed. */
  totalRequests: number;

  /** Overall error rate. */
  overallErrorRate: number;
}

// ---------------------------------------------------------------------------
// Default SLO definitions
// ---------------------------------------------------------------------------

/**
 * Default SLO definitions for Crucible endpoint groups.
 *
 * These are conservative targets suitable for a production AI evaluation platform.
 * Adjust based on your actual traffic patterns and SLA commitments.
 */
const DEFAULT_SLOS: SloDefinition[] = [
  {
    group: "read",
    p95LatencyMs: 500,
    p99LatencyMs: 1000,
    errorRate: 0.01,
    availability: 0.999,
    windowSeconds: 300,
  },
  {
    group: "write",
    p95LatencyMs: 1000,
    p99LatencyMs: 2000,
    errorRate: 0.005,
    availability: 0.999,
    windowSeconds: 300,
  },
  {
    group: "voice",
    p95LatencyMs: 2000,
    p99LatencyMs: 5000,
    errorRate: 0.02,
    availability: 0.99,
    windowSeconds: 300,
  },
  {
    group: "frenchy",
    p95LatencyMs: 3000,
    p99LatencyMs: 8000,
    errorRate: 0.02,
    availability: 0.99,
    windowSeconds: 300,
  },
  {
    group: "sts",
    p95LatencyMs: 5000,
    p99LatencyMs: 10000,
    errorRate: 0.02,
    availability: 0.99,
    windowSeconds: 300,
  },
  {
    group: "campaign",
    p95LatencyMs: 500,
    p99LatencyMs: 1000,
    errorRate: 0.01,
    availability: 0.999,
    windowSeconds: 300,
  },
  {
    group: "health",
    p95LatencyMs: 100,
    p99LatencyMs: 200,
    errorRate: 0.001,
    availability: 0.9999,
    windowSeconds: 60,
  },
];

// ---------------------------------------------------------------------------
// Path-to-group mapping
// ---------------------------------------------------------------------------

function resolveGroup(path: string): EndpointGroup {
  if (path === "/health" || path === "/healthz" || path === "/ready" || path === "/readyz") {
    return "health";
  }
  if (path.startsWith("/voice")) {
    return "voice";
  }
  if (path.startsWith("/frenchy")) {
    return "frenchy";
  }
  if (path.startsWith("/sts")) {
    return "sts";
  }
  if (path.startsWith("/campaigns")) {
    return "campaign";
  }
  // Write endpoints
  if (path.startsWith("/trials") && (path.includes("/new") || path.includes("/transition"))) {
    return "write";
  }
  if (path.startsWith("/forge") || path.startsWith("/engrams") || path.startsWith("/orgs")) {
    return "write";
  }
  // Default to read
  return "read";
}

// ---------------------------------------------------------------------------
// Metrics store
// ---------------------------------------------------------------------------

/** In-memory metrics store with sliding window. */
class MetricsStore {
  private readonly samples: RequestMetric[] = [];
  private readonly alerts: Alert[] = [];
  private readonly sloDefinitions = new Map<string, SloDefinition>();
  private readonly startTime = Date.now();
  private totalRequests = 0;
  private totalErrors = 0;

  constructor(slos: SloDefinition[] = DEFAULT_SLOS) {
    for (const slo of slos) {
      this.sloDefinitions.set(slo.group, slo);
    }
  }

  /** Record a request metric. */
  record(metric: RequestMetric): void {
    this.samples.push(metric);
    this.totalRequests++;
    if (metric.isError) {
      this.totalErrors++;
    }
  }

  /** Get samples within a time window for a group. */
  getSamples(group: EndpointGroup, windowMs: number): RequestMetric[] {
    const cutoff = Date.now() - windowMs;
    return this.samples.filter((s) => s.group === group && s.at >= cutoff);
  }

  /** Calculate percentile from a sorted array. */
  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)]!;
  }

  /** Calculate SLO compliance for a group. */
  checkCompliance(group: EndpointGroup): SloCompliance | null {
    const slo = this.sloDefinitions.get(group);
    if (!slo) return null;

    const samples = this.getSamples(group, slo.windowSeconds * 1000);
    if (samples.length === 0) {
      return {
        group,
        compliant: true,
        p95LatencyMs: 0,
        p95TargetMs: slo.p95LatencyMs,
        p95Compliant: true,
        p99LatencyMs: 0,
        p99TargetMs: slo.p99LatencyMs,
        p99Compliant: true,
        errorRate: 0,
        errorRateTarget: slo.errorRate,
        errorRateCompliant: true,
        availability: 1.0,
        availabilityTarget: slo.availability,
        availabilityCompliant: true,
        requestCount: 0,
        breaches: [],
      };
    }

    const latencies = samples.map((s) => s.latencyMs);
    const p95 = this.percentile(latencies, 95);
    const p99 = this.percentile(latencies, 99);
    const errorCount = samples.filter((s) => s.isError).length;
    const errorRate = errorCount / samples.length;
    const availability = 1.0 - errorRate;

    const breaches: string[] = [];
    const p95Compliant = p95 <= slo.p95LatencyMs;
    const p99Compliant = p99 <= slo.p99LatencyMs;
    const errorRateCompliant = errorRate <= slo.errorRate;
    const availabilityCompliant = availability >= slo.availability;

    if (!p95Compliant) breaches.push(`P95 latency ${p95.toFixed(0)}ms > ${slo.p95LatencyMs}ms`);
    if (!p99Compliant) breaches.push(`P99 latency ${p99.toFixed(0)}ms > ${slo.p99LatencyMs}ms`);
    if (!errorRateCompliant)
      breaches.push(`Error rate ${(errorRate * 100).toFixed(2)}% > ${(slo.errorRate * 100).toFixed(2)}%`);
    if (!availabilityCompliant)
      breaches.push(
        `Availability ${(availability * 100).toFixed(3)}% < ${(slo.availability * 100).toFixed(3)}%`,
      );

    return {
      group,
      compliant: breaches.length === 0,
      p95LatencyMs: Math.round(p95),
      p95TargetMs: slo.p95LatencyMs,
      p95Compliant,
      p99LatencyMs: Math.round(p99),
      p99TargetMs: slo.p99LatencyMs,
      p99Compliant,
      errorRate: Math.round(errorRate * 10000) / 10000,
      errorRateTarget: slo.errorRate,
      errorRateCompliant,
      availability: Math.round(availability * 10000) / 10000,
      availabilityTarget: slo.availability,
      availabilityCompliant,
      requestCount: samples.length,
      breaches,
    };
  }

  /** Check all SLOs and raise alerts for breaches. */
  checkAllAndAlert(): Alert[] {
    const newAlerts: Alert[] = [];
    const now = Date.now();

    for (const group of ENDPOINT_GROUPS) {
      const compliance = this.checkCompliance(group);
      if (!compliance || compliance.compliant) continue;

      // Check if we already have an active alert for this group+metric
      for (const breach of compliance.breaches) {
        // Derive the metric key from the breach message prefix, robust to the
        // rest of the message changing (e.g. reworded thresholds).
        const metric = breach.startsWith("P95") ? "P95"
          : breach.startsWith("P99") ? "P99"
          : breach.startsWith("Error") ? "errorRate"
          : breach.startsWith("Availability") ? "availability"
          : breach;
        const existing = this.alerts.find(
          (a) =>
            a.group === group &&
            a.metric === metric &&
            !a.acknowledged &&
            now - a.raisedAt < 300_000, // 5-minute cooldown
        );

        if (!existing) {
          const alert: Alert = {
            id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            raisedAt: now,
            group,
            metric,
            actual: 0,
            target: 0,
            message: breach,
            acknowledged: false,
          };
          this.alerts.push(alert);
          newAlerts.push(alert);
        }
      }
    }

    // Prune old alerts (older than 24 hours)
    const cutoff = now - 86_400_000;
    while (this.alerts.length > 0 && this.alerts[0]!.raisedAt < cutoff) {
      this.alerts.shift();
    }

    return newAlerts;
  }

  /** Acknowledge an alert. */
  acknowledgeAlert(alertId: string): Alert | null {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (!alert || alert.acknowledged) return null;
    alert.acknowledged = true;
    alert.acknowledgedAt = Date.now();
    return alert;
  }

  /** Get active (unacknowledged) alerts. */
  getActiveAlerts(): Alert[] {
    return this.alerts.filter((a) => !a.acknowledged);
  }

  /** Get system health summary. */
  getSystemHealth(): SystemHealth {
    const complianceList: SloCompliance[] = [];
    let allCompliant = true;

    for (const group of ENDPOINT_GROUPS) {
      const compliance = this.checkCompliance(group);
      if (compliance) {
        complianceList.push(compliance);
        if (!compliance.compliant) allCompliant = false;
      }
    }

    const activeAlerts = this.getActiveAlerts();
    const uptimeSeconds = (Date.now() - this.startTime) / 1000;
    const overallErrorRate =
      this.totalRequests > 0 ? this.totalErrors / this.totalRequests : 0;

    return {
      allCompliant,
      sloCompliance: complianceList,
      activeAlerts,
      activeAlertCount: activeAlerts.length,
      uptimeSeconds: Math.round(uptimeSeconds),
      totalRequests: this.totalRequests,
      overallErrorRate: Math.round(overallErrorRate * 10000) / 10000,
    };
  }

  /** Prune old samples to prevent memory growth. */
  prune(maxAgeSeconds: number = 600): void {
    const cutoff = Date.now() - maxAgeSeconds * 1000;
    const idx = this.samples.findIndex((s) => s.at >= cutoff);
    if (idx > 0) {
      this.samples.splice(0, idx);
    }
  }

  /** Clear all data (for tests). */
  clear(): void {
    this.samples.length = 0;
    this.alerts.length = 0;
    this.totalRequests = 0;
    this.totalErrors = 0;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Optional external alert notifier (webhook, etc.). */
let alertNotifier: ((alerts: Alert[]) => void | Promise<void>) | null = null;

export function setAlertNotifier(fn: ((alerts: Alert[]) => void | Promise<void>) | null): void {
  alertNotifier = fn;
}

export function getAlertNotifier(): ((alerts: Alert[]) => void | Promise<void>) | null {
  return alertNotifier;
}

/** The global metrics store, shared across the process. */
let globalStore: MetricsStore | null = null;

/**
 * Get the global metrics store, creating it if necessary.
 */
export function getMetricsStore(): MetricsStore {
  if (!globalStore) {
    globalStore = new MetricsStore();
  }
  return globalStore;
}

/**
 * Record a request metric.
 *
 * Call this at the end of each request handler to record latency and status.
 */
export function recordRequest(
  path: string,
  status: number,
  latencyMs: number,
): void {
  const store = getMetricsStore();
  store.record({
    at: Date.now(),
    group: resolveGroup(path),
    path,
    status,
    latencyMs,
    isError: status >= 400,
  });
}

/**
 * Get SLO compliance for all endpoint groups.
 */
export function getSloCompliance(): SloCompliance[] {
  const store = getMetricsStore();
  const compliance: SloCompliance[] = [];

  for (const group of ENDPOINT_GROUPS) {
    const c = store.checkCompliance(group);
    if (c) compliance.push(c);
  }

  return compliance;
}

/**
 * Get system health summary including SLO compliance and active alerts.
 */
export function getSystemHealth(): SystemHealth {
  const store = getMetricsStore();
  store.prune(); // evict samples older than the default 10-minute window; unbounded growth is a leak
  const newAlerts = store.checkAllAndAlert();
  if (newAlerts.length > 0 && alertNotifier) {
    try {
      void alertNotifier(newAlerts);
    } catch {
      // notifier failures must not break health reads
    }
  }
  return store.getSystemHealth();
}

/**
 * Acknowledge an alert.
 */
export function acknowledgeAlert(alertId: string): Alert | null {
  return getMetricsStore().acknowledgeAlert(alertId);
}

/**
 * Get the default SLO definitions.
 */
export function getDefaultSlos(): SloDefinition[] {
  return DEFAULT_SLOS;
}

/**
 * Reset the metrics store for tests.
 */
export function resetMonitoringForTests(): void {
  globalStore = new MetricsStore();
}

/**
 * Hono middleware for automatic metrics collection.
 *
 * Mounted in `app.ts` for every route. That sentence is the whole reason this function is worth
 * having: `recordRequest` had exactly one production caller — this middleware — and the middleware
 * was imported but never mounted, so `/health` and `/monitoring` reported `totalRequests: 0` and an
 * error rate of zero over an empty window while the tests stayed green by calling `recordRequest`
 * directly. A dashboard fed by a function nobody calls is decorative sample data wearing the word
 * "live", which is the specific thing this repository refuses to ship.
 *
 * Adds `X-Request-Id` and `X-Response-Time`. The id is 16 random bytes, not `Math.random()` sliced
 * to six base-36 characters: six characters collide under concurrency, and a correlation id whose
 * whole job is to distinguish one request from another must not be the thing that fails to.
 */
export function metricsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    c.header("X-Request-Id", `req-${randomBytes(16).toString("hex")}`);

    await next();

    const latencyMs = Date.now() - start;
    c.header("X-Response-Time", `${latencyMs}ms`);
    recordRequest(c.req.path, c.res.status, latencyMs);
  };
}
