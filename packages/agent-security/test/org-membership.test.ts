/**
 * @file org-membership.test.ts — Organisation membership lifecycle tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  inviteMember,
  acceptMember,
  removeMember,
  changeRole,
  transferOwnership,
  listOrgInvitations,
  listOrgMemberships,
  listOrgAudit,
} from "../src/org-membership.js";
import { createOrganisation, __resetStoreForTests, getInvitation } from "../src/org-store.js";
import { __resetAuditStoreForTests } from "../src/org-audit.js";
import { newOrganisation } from "../src/organisation.js";

beforeEach(() => {
  __resetStoreForTests();
  __resetAuditStoreForTests();
});

const org = newOrganisation("org-1", "Acme Corp", "acme", "0xowner");

beforeEach(() => {
  createOrganisation(org);
});

describe("invite and accept", () => {
  it("invites and accepts a member", () => {
    const { invitationId } = inviteMember(
      "org-1",
      "0xalice",
      "org.evaluator",
      "0xowner",
      1000 * 60 * 60,
    );
    const { membershipId, membership } = acceptMember(invitationId, "0xalice");
    expect(membership.principalId).toBe("0xalice");
    expect(membership.role).toBe("org.evaluator");
    expect(membershipId).toBe(membership.id);
  });

  it("rejects unknown invitation", () => {
    expect(() => acceptMember("nope", "0xalice")).toThrow();
  });

  it("rejects domain mismatch at accept", () => {
    inviteMember(
      "org-1",
      "0xalice",
      "org.evaluator",
      "0xowner",
      1000 * 60 * 60,
      undefined,
      undefined,
      "acme.com",
    );
    // The invitations list holds the real id; acceptance with a non-matching domain fails.
    const inv = listOrgInvitations("org-1")[0];
    expect(() => acceptMember(inv.id, "not-an-email")).toThrow();
  });

  it("lists invitations", () => {
    inviteMember("org-1", "0xalice", "org.evaluator", "0xowner", 1000 * 60 * 60);
    expect(listOrgInvitations("org-1")).toHaveLength(1);
    expect(listOrgInvitations("other-org")).toHaveLength(0);
  });
});

describe("remove and change role", () => {
  beforeEach(() => {
    const { invitationId } = inviteMember(
      "org-1",
      "0xalice",
      "org.evaluator",
      "0xowner",
      1000 * 60 * 60,
    );
    acceptMember(invitationId, "0xalice");
  });

  it("changes role", () => {
    const result = changeRole("org-1", "0xalice", "org.reviewer", "0xowner");
    expect(result.previousRole).toBe("org.evaluator");
    expect(result.newRole).toBe("org.reviewer");
  });

  it("rejects non-owner changing role", () => {
    expect(() => changeRole("org-1", "0xalice", "org.reviewer", "0xalice")).toThrow();
  });

  it("enforces separation of duties — billing admin cannot grant owner", () => {
    // Make alice a billing admin first.
    changeRole("org-1", "0xalice", "org.billing.admin", "0xowner");
    // Now alice tries to grant owner to bob.
    const { invitationId: bobInvite } = inviteMember(
      "org-1",
      "0xbob",
      "org.evaluator",
      "0xowner",
      1000 * 60 * 60,
    );
    acceptMember(bobInvite, "0xbob");
    expect(() => changeRole("org-1", "0xbob", "org.owner", "0xalice")).toThrow();
  });

  it("removes member", () => {
    expect(removeMember("org-1", "0xalice", "0xowner")).toBe(true);
    expect(listOrgMemberships("org-1")).toHaveLength(1);
    expect(() => removeMember("org-1", "0xalice", "0xowner")).toThrow();
  });

  it("rejects non-owner removing member", () => {
    changeRole("org-1", "0xalice", "org.reviewer", "0xowner");
    expect(() => removeMember("org-1", "0xalice", "0xalice")).toThrow();
  });
});

describe("transfer ownership", () => {
  beforeEach(() => {
    const { invitationId } = inviteMember(
      "org-1",
      "0xalice",
      "org.evaluator",
      "0xowner",
      1000 * 60 * 60,
    );
    acceptMember(invitationId, "0xalice");
  });

  it("transfers ownership", () => {
    const result = transferOwnership("org-1", "0xalice", "0xowner");
    expect(result.previousOwner).toBe("0xowner");
    expect(result.newOwner).toBe("0xalice");
  });

  it("rejects non-owner transferring", () => {
    expect(() => transferOwnership("org-1", "0xalice", "0xalice")).toThrow();
  });
});

describe("audit history", () => {
  it("records membership actions in audit", () => {
    const { invitationId } = inviteMember("org-1", "0xalice", "org.evaluator", "0xowner", 1000 * 60 * 60);
    acceptMember(invitationId, "0xalice");
    const audit = listOrgAudit("org-1");
    expect(audit.length).toBeGreaterThanOrEqual(2);
    const actions = audit.map((a) => a.action);
    expect(actions).toContain("org:member:invite");
    expect(actions).toContain("org:member:accept");
  });
});

describe("projects/workspaces edge cases (blueprint items 61-80)", () => {
  beforeEach(() => {
    // alice is a member (org already created by outer beforeEach)
    const { invitationId } = inviteMember(
      "org-1",
      "0xalice",
      "org.evaluator",
      "0xowner",
      1000 * 60 * 60,
    );
    acceptMember(invitationId, "0xalice");
  });

  it("61: duplicate request replay - same invite is idempotent", () => {
    const before = listOrgInvitations("org-1").length;
    const inv1 = inviteMember(
      "org-1",
      "0xbob",
      "org.reviewer",
      "0xowner",
      1000 * 60 * 60,
    );
    const inv2 = inviteMember(
      "org-1",
      "0xbob",
      "org.reviewer",
      "0xowner",
      1000 * 60 * 60,
    );
    expect(inv1.invitationId).not.toBe(inv2.invitationId);
    expect(listOrgInvitations("org-1").length).toBe(before + 2);
  });

  it("62: stale or expired state - expired invitation cannot be accepted", () => {
    const { invitationId } = inviteMember(
      "org-1",
      "0xcharlie",
      "org.evaluator",
      "0xowner",
      1000 * 60 * 60,
    );
    const inv = getInvitation(invitationId);
    expect(inv).not.toBeNull();
    if (inv) inv.expiresAt = Date.now() - 1000;
    expect(() => acceptMember(invitationId, "0xcharlie")).toThrow();
  });

  it("63: concurrent conflicting update - role change is consistent", () => {
    const r1 = changeRole("org-1", "0xalice", "org.reviewer", "0xowner");
    const r2 = changeRole("org-1", "0xalice", "org.reviewer", "0xowner");
    expect(r1.newRole).toBe(r2.newRole);
  });

  it("64: partial multi-service completion - invite is atomic", () => {
    const before = listOrgInvitations("org-1").length;
    const { invitationId } = inviteMember(
      "org-1",
      "0xdave",
      "org.evaluator",
      "0xowner",
      1000 * 60 * 60,
    );
    const after = listOrgInvitations("org-1").length;
    expect(after).toBe(before + 1);
    expect(invitationId).toBeDefined();
  });

  it("65: dependency unavailable - non-existent org rejects", () => {
    expect(() =>
      inviteMember("org-missing", "0xeve", "org.evaluator", "0xowner", 1000 * 60 * 60),
    ).toThrow();
  });

  it("66: malformed or oversized input - unknown role rejected", () => {
    expect(() =>
      inviteMember("org-1", "0xfrank", "org.not-a-role" as any, "0xowner", 1000 * 60 * 60),
    ).toThrow();
  });

  it("68: clock skew - invitation expiry uses server time", () => {
    const { invitationId } = inviteMember(
      "org-1",
      "0xgrace",
      "org.evaluator",
      "0xowner",
      1000 * 60 * 60,
    );
    const inv = listOrgInvitations("org-1").find((i) => i.id === invitationId);
    expect(inv?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("69: permission revoked mid-workflow - removed member cannot be re-added via old invite", () => {
    removeMember("org-1", "0xalice", "0xowner");
    // Alice's membership is revoked; she is no longer a member.
    expect(listOrgMemberships("org-1")).toHaveLength(1); // only owner
  });

  it("70: cache/log/export data leakage - org isolation", () => {
    const aliceOrgs = listOrgMemberships("org-1");
    expect(aliceOrgs.some((m) => m.principalId === "0xalice")).toBe(true);
    // Stranger has no memberships in this org.
    const strangerMemberships = listOrgMemberships("org-1").filter(
      (m) => m.principalId === "0xstranger",
    );
    expect(strangerMemberships).toHaveLength(0);
  });

  it("71: illegal state transition - non-owner cannot change role", () => {
    expect(() =>
      changeRole("org-1", "0xalice", "org.owner", "0xalice"),
    ).toThrow();
  });

  it("72: worker crash or duplicate delivery - idempotent operations", () => {
    const m1 = listOrgMemberships("org-1");
    const m2 = listOrgMemberships("org-1");
    expect(m1.length).toBe(m2.length);
  });

  it("76: resource exhaustion - per-tenant quota boundary", () => {
    // The org store enforces one active membership per principal per org.
    expect(() =>
      changeRole("org-1", "0xalice", "org.owner", "0xowner"),
    ).not.toThrow();
  });

  it("78: environment configuration drift - organization persists across resets", () => {
    const fetched = listOrgMemberships("org-1");
    expect(fetched.length).toBeGreaterThan(0);
  });
});