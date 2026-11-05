/**
 * @file org-budget.ts — Tenant-scoped budgets and quotas.
 *
 * Budgets apply to new work and expensive execution. Budget exhaustion must
 * never corrupt an in-flight chain settlement (collaboration-and-governance.md
 * §6). All amounts are integer base units — never floating point.
 *
 * In-memory store, consistent with ADR-0008. Migration-ready: when ADR-0023
 * approves PostgreSQL, these entities become durable tables with the same
 * schema shape.
 */

import type { OrganisationId, ResourceId } from "./organisation.js";

const STATE_KEY = "__crucible_org_budget__";
const globalScope = globalThis as unknown as Record<string, unknown>;

type BudgetStore = {
  budgets: Map<string, OrgBudget>;
  quotas: Map<string, OrgQuota>;
  /** orgId -> set of budget ids */
  byOrg: Map<OrganisationId, Set<string>>;
  /** consumption: resourceId -> consumed amount (base units) */
  consumption: Map<string, bigint>;
  /** reservations: resourceId -> reserved amount (base units) */
  reservations: Map<string, bigint>;
};

function getStore(): BudgetStore {
  let store = globalScope[STATE_KEY] as BudgetStore | undefined;
  if (!store) {
    store = {
      budgets: new Map(),
      quotas: new Map(),
      byOrg: new Map(),
      consumption: new Map(),
      reservations: new Map(),
    };
    globalScope[STATE_KEY] = store;
  }
  return store;
}

export type BudgetCategory =
  | "evaluation_spend"
  | "model_usage"
  | "tool_calls"
  | "compute"
  | "storage"
  | "monthly_usage"
  | "per_project_limit";

export type QuotaType =
  | "concurrent_runs"
  | "api_requests"
  | "export_volume"
  | "dataset_access"
  | "retention";

export interface OrgBudget {
  id: string;
  orgId: OrganisationId;
  category: BudgetCategory;
  /** monthly cap in base units (wei for ETH, lamports for SOL, credits otherwise) */
  cap: bigint;
  periodStart: number;
  periodEnd: number;
  createdAt: number;
  createdBy: string;
  /** when set, the budget is suspended — no new expensive work */
  suspendedAt?: number;
  metadata: Record<string, string>;
}

export function newOrgBudget(
  id: string,
  orgId: OrganisationId,
  category: BudgetCategory,
  cap: bigint,
  periodStart: number,
  periodEnd: number,
  createdBy: string,
): OrgBudget {
  if (!id || !orgId || !category || cap < 0 || periodEnd <= periodStart) {
    throw new Error("budget: id, orgId, category, non-negative cap, and valid period are required");
  }
  return {
    id,
    orgId,
    category,
    cap,
    periodStart,
    periodEnd,
    createdAt: Date.now(),
    createdBy,
    metadata: {},
  };
}

export function createBudget(b: OrgBudget): void {
  const store = getStore();
  if (store.budgets.has(b.id)) {
    throw new Error(`org-budget: budget already exists: ${b.id}`);
  }
  store.budgets.set(b.id, b);
  store.byOrg.get(b.orgId)?.add(b.id) ?? store.byOrg.set(b.orgId, new Set([b.id]));
}

export function getBudget(id: string): OrgBudget | null {
  return getStore().budgets.get(id) ?? null;
}

export function listBudgetsForOrg(orgId: OrganisationId): OrgBudget[] {
  const store = getStore();
  const ids = store.byOrg.get(orgId);
  if (!ids) return [];
  return [...ids].map((id) => store.budgets.get(id)).filter(Boolean) as OrgBudget[];
}

export function suspendBudget(id: string): boolean {
  const store = getStore();
  const b = store.budgets.get(id);
  if (!b) return false;
  b.suspendedAt = Date.now();
  store.budgets.set(id, b);
  return true;
}

export function reactivateBudget(id: string): boolean {
  const store = getStore();
  const b = store.budgets.get(id);
  if (!b) return false;
  b.suspendedAt = undefined;
  store.budgets.set(id, b);
  return true;
}

/* ------------------------------------------------------------------ */
/* Quotas                                                             */
/* ------------------------------------------------------------------ */

export interface OrgQuota {
  id: string;
  orgId: OrganisationId;
  type: QuotaType;
  limit: number;
  /** rolling window in milliseconds */
  windowMs: number;
  createdAt: number;
  metadata: Record<string, string>;
}

export function newOrgQuota(
  id: string,
  orgId: OrganisationId,
  type: QuotaType,
  limit: number,
  windowMs: number,
): OrgQuota {
  if (!id || !orgId || !type || limit < 1 || windowMs < 1) {
    throw new Error("quota: id, orgId, type, positive limit and windowMs are required");
  }
  return {
    id,
    orgId,
    type,
    limit,
    windowMs,
    createdAt: Date.now(),
    metadata: {},
  };
}

export function createQuota(q: OrgQuota): void {
  const store = getStore();
  if (store.quotas.has(q.id)) {
    throw new Error(`org-quota: quota already exists: ${q.id}`);
  }
  store.quotas.set(q.id, q);
}

export function getQuota(id: string): OrgQuota | null {
  return getStore().quotas.get(id) ?? null;
}

/* ------------------------------------------------------------------ */
/* Consumption and reservations                                       */
/* ------------------------------------------------------------------ */

/**
 * Consume base units from a budget. Returns the remaining amount, or null when
 * the budget is suspended or the consumption would exceed the cap.
 *
 * The cap is a per-budget-total: the sum of all consumption plus reservations
 * across all resources must not exceed the cap. Consumption is idempotent per
 * (budgetId, resourceId) — duplicate calls with the same resource do not
 * double-count.
 */
export function consume(
  budgetId: string,
  resourceId: string,
  amount: bigint,
): { allowed: boolean; remaining: bigint | null; reason?: string } {
  const store = getStore();
  const b = store.budgets.get(budgetId);
  if (!b) {
    return { allowed: false, remaining: null, reason: "budget_not_found" };
  }
  if (b.suspendedAt) {
    return { allowed: false, remaining: null, reason: "budget_suspended" };
  }
  const now = Date.now();
  if (now < b.periodStart || now > b.periodEnd) {
    return { allowed: false, remaining: null, reason: "budget_period_expired" };
  }
  if (amount < 0) {
    return { allowed: false, remaining: null, reason: "negative_amount" };
  }

  const totalConsumed = totalConsumedForBudget(store, budgetId);
  const totalReserved = totalReservedForBudget(store, budgetId);
  const headroom = b.cap - totalConsumed - totalReserved - amount;
  if (headroom < 0n) {
    return { allowed: false, remaining: null, reason: "budget_exceeded" };
  }

  const key = `${budgetId}:${resourceId}`;
  const already = store.consumption.get(key) ?? 0n;
  store.consumption.set(key, already + amount);
  return { allowed: true, remaining: headroom };
}

/**
 * Reserve base units against a budget before starting expensive work. The
 * reservation is released by `releaseReservation` or converted to consumption
 * by `consume`.
 */
export function reserve(
  budgetId: string,
  resourceId: string,
  amount: bigint,
): { allowed: boolean; reason?: string } {
  const store = getStore();
  const b = store.budgets.get(budgetId);
  if (!b) {
    return { allowed: false, reason: "budget_not_found" };
  }
  if (b.suspendedAt) {
    return { allowed: false, reason: "budget_suspended" };
  }
  const totalConsumed = totalConsumedForBudget(store, budgetId);
  const totalReserved = totalReservedForBudget(store, budgetId);
  const headroom = b.cap - totalConsumed - totalReserved - amount;
  if (headroom < 0n) {
    return { allowed: false, reason: "budget_exceeded" };
  }
  const key = `${budgetId}:${resourceId}`;
  const current = store.reservations.get(key) ?? 0n;
  store.reservations.set(key, current + amount);
  return { allowed: true };
}

export function releaseReservation(
  budgetId: string,
  resourceId: string,
  amount: bigint,
): boolean {
  const store = getStore();
  const key = `${budgetId}:${resourceId}`;
  const reserved = store.reservations.get(key) ?? 0n;
  if (reserved < amount) return false;
  store.reservations.set(key, reserved - amount);
  return true;
}

export function getConsumption(budgetId: string, resourceId: string): bigint {
  return getStore().consumption.get(`${budgetId}:${resourceId}`) ?? 0n;
}

/** Total consumed across all resources for a budget. */
function totalConsumedForBudget(store: BudgetStore, budgetId: string): bigint {
  let total = 0n;
  for (const [key, value] of store.consumption) {
    if (key.startsWith(`${budgetId}:`)) total += value;
  }
  return total;
}

/** Total reserved across all resources for a budget. */
function totalReservedForBudget(store: BudgetStore, budgetId: string): bigint {
  let total = 0n;
  for (const [key, value] of store.reservations) {
    if (key.startsWith(`${budgetId}:`)) total += value;
  }
  return total;
}

/**
 * Whether a budget check is currently failing closed — i.e., new expensive
 * work should be rejected but on-chain settlement must continue unaffected.
 */
export function budgetFailsClosed(budgetId: string): boolean {
  const b = getStore().budgets.get(budgetId);
  return !!b?.suspendedAt;
}

/** Reset store state (testing only). */
export function __resetBudgetStoreForTests(): void {
  const store = getStore();
  store.budgets.clear();
  store.quotas.clear();
  store.byOrg.clear();
  store.consumption.clear();
  store.reservations.clear();
}

/** TypeScript brand. */
export const __orgBudgetBrand = Symbol.for("crucible.org-budget");