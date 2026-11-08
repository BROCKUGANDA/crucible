/**
 * @file metering.ts — Usage metering and quota enforcement (Billing/Usage).
 *
 * Tracks resource consumption per tenant/organisation and enforces quotas.
 * Follows the same store-interface pattern as campaigns so a production
 * deployment can swap the in-memory store for PostgreSQL/Redis without
 * changing the domain logic.
 *
 * Design decisions:
 *  1. **Events are append-only.** Usage is recorded as immutable events;
 *     aggregates are computed on read. This matches the financial-ledger
 *     integrity model used elsewhere in Crucible.
 *  2. **Quotas are per (tenant, metric, period).** A tenant can have
 *     different limits for different resources and billing periods.
 *  3. **Enforcement is server-authoritative.** The caller never decides
 *     whether a request is within quota; the metering service does.
 *  4. **The store is an interface.** In-memory for dev/tests, swappable
 *     for a persistent backend in production.
 */

import { randomBytes } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UsagePeriod = "hourly" | "daily" | "monthly";

export interface UsageEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly metric: string;
  readonly quantity: number;
  readonly recordedAt: number;
  readonly metadata?: Record<string, unknown>;
}

export interface Quota {
  readonly tenantId: string;
  readonly metric: string;
  readonly period: UsagePeriod;
  readonly limit: number;
  readonly used: number;
  readonly periodStart: number;
  readonly periodEnd: number;
}

export interface QuotaCheckResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly used: number;
  readonly limit: number;
  readonly reason?: string;
}

export interface UsageSummary {
  readonly tenantId: string;
  readonly metric: string;
  readonly total: number;
  readonly eventCount: number;
  readonly from: number;
  readonly to: number;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface MeteringStore {
  recordEvent(event: UsageEvent): void;
  listEvents(tenantId: string, metric?: string, from?: number, to?: number): UsageEvent[];
  getQuota(tenantId: string, metric: string, period: UsagePeriod): Quota | null;
  setQuota(quota: Quota): void;
  listQuotas(tenantId: string): Quota[];
  reset(): void;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const STATE_KEY = "__crucible_metering_store__";

interface StoreState {
  events: UsageEvent[];
  quotas: Map<string, Quota>;
}

function quotaKey(tenantId: string, metric: string, period: UsagePeriod): string {
  return `${tenantId}::${metric}::${period}`;
}

export function createMeteringStore(): MeteringStore {
  const state: StoreState = {
    events: [],
    quotas: new Map<string, Quota>(),
  };

  function periodBounds(period: UsagePeriod, now: number): { start: number; end: number } {
    const d = new Date(now);
    if (period === "hourly") {
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
      return { start, end: start + 3_600_000 };
    }
    if (period === "daily") {
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      return { start, end: start + 86_400_000 };
    }
    const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    return { start, end };
  }

  return {
    recordEvent(event: UsageEvent): void {
      state.events.push(event);
    },

    listEvents(tenantId: string, metric?: string, from?: number, to?: number): UsageEvent[] {
      return state.events.filter((e) => {
        if (e.tenantId !== tenantId) return false;
        if (metric && e.metric !== metric) return false;
        if (from != null && e.recordedAt < from) return false;
        if (to != null && e.recordedAt > to) return false;
        return true;
      });
    },

    getQuota(tenantId: string, metric: string, period: UsagePeriod): Quota | null {
      const key = quotaKey(tenantId, metric, period);
      const q = state.quotas.get(key);
      if (!q) return null;
      // Recompute used from events in the current period
      const { start, end } = periodBounds(period, Date.now());
      const used = state.events
        .filter((e) => e.tenantId === tenantId && e.metric === metric && e.recordedAt >= start && e.recordedAt < end)
        .reduce((sum, e) => sum + e.quantity, 0);
      return { ...q, used, periodStart: start, periodEnd: end };
    },

    setQuota(quota: Quota): void {
      state.quotas.set(quotaKey(quota.tenantId, quota.metric, quota.period), quota);
    },

    listQuotas(tenantId: string): Quota[] {
      const result: Quota[] = [];
      for (const q of state.quotas.values()) {
        if (q.tenantId === tenantId) result.push(q);
      }
      return result;
    },

    reset(): void {
      state.events.length = 0;
      state.quotas.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface MeteringConfig {
  store?: MeteringStore;
}

export class MeteringService {
  private readonly store: MeteringStore;

  constructor(config: MeteringConfig = {}) {
    this.store = config.store ?? createMeteringStore();
  }

  recordUsage(
    tenantId: string,
    metric: string,
    quantity: number = 1,
    metadata?: Record<string, unknown>,
  ): UsageEvent {
    if (!tenantId || !metric) throw new Error("tenantId and metric are required");
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("quantity must be positive");
    const event: UsageEvent = {
      eventId: `evt-${randomBytes(8).toString("hex")}`,
      tenantId,
      metric,
      quantity,
      recordedAt: Date.now(),
      metadata,
    };
    this.store.recordEvent(event);
    return event;
  }

  getUsage(tenantId: string, metric?: string, from?: number, to?: number): UsageSummary[] {
    const events = this.store.listEvents(tenantId, metric, from, to);
    const grouped = new Map<string, { total: number; count: number }>();
    for (const e of events) {
      const g = grouped.get(e.metric) ?? { total: 0, count: 0 };
      g.total += e.quantity;
      g.count += 1;
      grouped.set(e.metric, g);
    }
    const now = Date.now();
    const result: UsageSummary[] = [];
    for (const [m, g] of grouped) {
      result.push({
        tenantId,
        metric: m,
        total: g.total,
        eventCount: g.count,
        from: from ?? (events.length ? Math.min(...events.map((e) => e.recordedAt)) : now),
        to: to ?? now,
      });
    }
    return result;
  }

  checkQuota(tenantId: string, metric: string, quantity: number = 1): QuotaCheckResult {
    // Find the most restrictive quota across periods
    const quotas = this.store.listQuotas(tenantId).filter((q) => q.metric === metric);
    if (quotas.length === 0) {
      // No quota configured — allow by default
      return { allowed: true, remaining: Infinity, used: 0, limit: Infinity };
    }

    // Check each period; deny if any would be exceeded
    for (const q of quotas) {
      const live = this.store.getQuota(tenantId, metric, q.period);
      if (!live) continue;
      if (live.used + quantity > live.limit) {
        return {
          allowed: false,
          remaining: Math.max(0, live.limit - live.used),
          used: live.used,
          limit: live.limit,
          reason: `Quota exceeded for ${metric} (${q.period}): ${live.used}/${live.limit}`,
        };
      }
    }

    // All periods OK — compute remaining from the tightest
    let tightestRemaining = Infinity;
    let tightestUsed = 0;
    let tightestLimit = Infinity;
    for (const q of quotas) {
      const live = this.store.getQuota(tenantId, metric, q.period);
      if (!live) continue;
      const rem = live.limit - live.used;
      if (rem < tightestRemaining) {
        tightestRemaining = rem;
        tightestUsed = live.used;
        tightestLimit = live.limit;
      }
    }
    return {
      allowed: true,
      remaining: tightestRemaining,
      used: tightestUsed,
      limit: tightestLimit,
    };
  }

  setQuota(tenantId: string, metric: string, period: UsagePeriod, limit: number): Quota {
    if (limit <= 0) throw new Error("quota limit must be positive");
    const { start, end } = periodBounds(period, Date.now());
    const quota: Quota = {
      tenantId,
      metric,
      period,
      limit,
      used: 0,
      periodStart: start,
      periodEnd: end,
    };
    this.store.setQuota(quota);
    return quota;
  }

  getQuotas(tenantId: string): Quota[] {
    return this.store.listQuotas(tenantId).map((q) => {
      const live = this.store.getQuota(tenantId, q.metric, q.period);
      return live ?? q;
    });
  }

  getStore(): MeteringStore {
    return this.store;
  }
}

function periodBounds(period: UsagePeriod, now: number): { start: number; end: number } {
  const d = new Date(now);
  if (period === "hourly") {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
    return { start, end: start + 3_600_000 };
  }
  if (period === "daily") {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return { start, end: start + 86_400_000 };
  }
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return { start, end };
}
