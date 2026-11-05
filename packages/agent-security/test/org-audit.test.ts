/**
 * @file org-audit.test.ts — Append-only organisation audit history tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  newAuditEntry,
  createAuditEntry,
  getAuditEntry,
  listAuditForOrg,
  listAllAudit,
  verifyChain,
  __resetAuditStoreForTests,
} from "../src/org-audit.js";

beforeEach(() => {
  __resetAuditStoreForTests();
});

function makeEntry(id: string, action: string, orgId = "org-1") {
  return newAuditEntry(id, "0xowner", action, { trialId: 42 }, orgId, `trial-${id}`);
}

describe("audit entries", () => {
  it("creates, reads and lists", () => {
    const e = makeEntry("e-1", "org:budget:set");
    createAuditEntry(e);
    expect(getAuditEntry("e-1")).toEqual(e);
    expect(listAuditForOrg("org-1")).toHaveLength(1);
    expect(listAuditForOrg("other-org")).toHaveLength(0);
    expect(listAllAudit()).toHaveLength(1);
  });

  it("rejects duplicate entry", () => {
    const e = makeEntry("e-1", "org:budget:set");
    createAuditEntry(e);
    expect(() => createAuditEntry(e)).toThrow();
  });

  it("rejects broken chain link", () => {
    const e1 = makeEntry("e-1", "org:budget:set");
    createAuditEntry(e1);
    const e2 = newAuditEntry("e-2", "0xowner", "org:role:change", {}, "org-1", "trial-2");
    // Force wrong prevHash by creating a tampered entry.
    const tampered = { ...e2, prevHash: "wrong-hash" };
    expect(() => createAuditEntry(tampered)).toThrow();
  });
});

describe("verifyChain", () => {
  it("validates an intact chain", () => {
    createAuditEntry(makeEntry("e-1", "org:budget:set"));
    createAuditEntry(makeEntry("e-2", "org:role:change"));
    createAuditEntry(makeEntry("e-3", "org:member:remove"));
    expect(verifyChain().valid).toBe(true);
  });

  it("detects a broken chain link", () => {
    const e1 = makeEntry("e-1", "org:budget:set");
    createAuditEntry(e1);
    const e2 = makeEntry("e-2", "org:role:change");
    createAuditEntry(e2);
    // Force a broken link by creating e-3 with a wrong prevHash.
    const e3 = newAuditEntry("e-3", "0xowner", "org:member:remove", {}, "org-1", "trial-3");
    const broken = { ...e3, prevHash: "forced-wrong-hash" };
    expect(() => createAuditEntry(broken)).toThrow();
  });

  it("limits results", () => {
    createAuditEntry(makeEntry("e-1", "a"));
    createAuditEntry(makeEntry("e-2", "b"));
    createAuditEntry(makeEntry("e-3", "c"));
    expect(listAuditForOrg("org-1", 2)).toHaveLength(2);
    expect(listAllAudit(1)).toHaveLength(1);
  });
});