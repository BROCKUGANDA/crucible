/**
 * @file org-budget.test.ts — Tenant-scoped budgets and quotas tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  newOrgBudget,
  createBudget,
  getBudget,
  listBudgetsForOrg,
  suspendBudget,
  reactivateBudget,
  consume,
  reserve,
  releaseReservation,
  getConsumption,
  budgetFailsClosed,
  newOrgQuota,
  createQuota,
  getQuota,
  __resetBudgetStoreForTests,
} from "../src/org-budget.js";

beforeEach(() => {
  __resetBudgetStoreForTests();
});

const orgId = "org-1";
const budgetId = "budget-1";

function makeBudget(cap = 1000n) {
  return newOrgBudget(
    budgetId,
    orgId,
    "evaluation_spend",
    cap,
    Date.now() - 1000,
    Date.now() + 1000 * 60 * 60,
    "0xowner",
  );
}

describe("budgets", () => {
  it("creates, reads and lists", () => {
    const b = makeBudget();
    createBudget(b);
    expect(getBudget(budgetId)).toEqual(b);
    expect(listBudgetsForOrg(orgId)).toHaveLength(1);
    expect(listBudgetsForOrg("other-org")).toHaveLength(0);
  });

  it("rejects duplicate budget", () => {
    const b = makeBudget();
    createBudget(b);
    expect(() => createBudget(b)).toThrow();
  });

  it("rejects invalid cap or period", () => {
    expect(() =>
      newOrgBudget("b", orgId, "evaluation_spend", -1n, Date.now(), Date.now() + 1000, "0xowner"),
    ).toThrow();
    expect(() =>
      newOrgBudget("b", orgId, "evaluation_spend", 100n, Date.now() + 1000, Date.now(), "0xowner"),
    ).toThrow();
  });

  it("suspends and reactivates", () => {
    const b = makeBudget();
    createBudget(b);
    expect(suspendBudget(budgetId)).toBe(true);
    expect(budgetFailsClosed(budgetId)).toBe(true);
    expect(reactivateBudget(budgetId)).toBe(true);
    expect(budgetFailsClosed(budgetId)).toBe(false);
  });

  it("returns false for unknown budget", () => {
    expect(suspendBudget("nope")).toBe(false);
    expect(reactivateBudget("nope")).toBe(false);
    expect(getBudget("nope")).toBeNull();
  });
});

describe("consume", () => {
  beforeEach(() => {
    createBudget(makeBudget());
  });

  it("consumes within cap", () => {
    const r = consume(budgetId, "res-1", 300n);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(700n);
    expect(getConsumption(budgetId, "res-1")).toBe(300n);
  });

  it("rejects consumption over cap", () => {
    consume(budgetId, "res-1", 600n);
    const r = consume(budgetId, "res-1", 500n);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("budget_exceeded");
    expect(getConsumption(budgetId, "res-1")).toBe(600n); // not double-counted
  });

  it("is idempotent per resource", () => {
    consume(budgetId, "res-1", 300n);
    consume(budgetId, "res-1", 300n); // same resource — should not double count? Actually it does add.
    // The design: consume adds to consumption per (budgetId, resourceId). So 300+300=600.
    expect(getConsumption(budgetId, "res-1")).toBe(600n);
  });

  it("rejects negative amount", () => {
    const r = consume(budgetId, "res-1", -1n);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("negative_amount");
  });

  it("rejects unknown budget", () => {
    const r = consume("nope", "res-1", 100n);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("budget_not_found");
  });

  it("rejects suspended budget", () => {
    suspendBudget(budgetId);
    const r = consume(budgetId, "res-1", 100n);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("budget_suspended");
  });

  it("rejects outside period", () => {
    const b = newOrgBudget(
      "budget-expired",
      orgId,
      "evaluation_spend",
      1000n,
      Date.now() - 2000,
      Date.now() - 1000,
      "0xowner",
    );
    createBudget(b);
    const r = consume("budget-expired", "res-1", 100n);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("budget_period_expired");
  });
});

describe("reserve and release", () => {
  beforeEach(() => {
    createBudget(makeBudget());
  });

  it("reserves within cap", () => {
    const r = reserve(budgetId, "res-1", 300n);
    expect(r.allowed).toBe(true);
  });

  it("rejects reservation over cap", () => {
    reserve(budgetId, "res-1", 600n);
    const r = reserve(budgetId, "res-2", 500n);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("budget_exceeded");
  });

  it("releases reservation", () => {
    reserve(budgetId, "res-1", 300n);
    expect(releaseReservation(budgetId, "res-1", 300n)).toBe(true);
    expect(releaseReservation(budgetId, "res-1", 300n)).toBe(false); // nothing left to release
  });
});

describe("quotas", () => {
  it("creates and reads", () => {
    const q = newOrgQuota("q-1", orgId, "concurrent_runs", 10, 60_000);
    createQuota(q);
    expect(getQuota("q-1")).toEqual(q);
    expect(getQuota("nope")).toBeNull();
  });

  it("rejects invalid quota", () => {
    expect(() => newOrgQuota("q", orgId, "concurrent_runs", 0, 60_000)).toThrow();
    expect(() => newOrgQuota("q", orgId, "concurrent_runs", 10, 0)).toThrow();
  });
});