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
import { createOrganisation, __resetStoreForTests } from "../src/org-store.js";
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