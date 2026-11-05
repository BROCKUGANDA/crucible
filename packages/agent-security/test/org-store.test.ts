/**
 * @file org-store.test.ts — In-memory organisation store tests.
 *
 * Every lookup returns absent (null/undefined) — never fabricated — when a
 * record does not exist.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createOrganisation,
  getOrganisation,
  listOrganisations,
  updateOrganisation,
  deleteOrganisation,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  createMembership,
  getMembershipByPrincipalAndOrg,
  listMemberships,
  listMembershipsForPrincipal,
  revokeMembership,
  createInvitation,
  getInvitation,
  acceptInvitation,
  revokeInvitation,
  createResourceOwnership,
  getResourceOwnership,
  listResourcesForOrg,
  organisationsForPrincipal,
  isMemberOf,
  membershipForPrincipalInOrg,
  roleForPrincipalInOrg,
  membersOf,
  listResourcesForPrincipal,
  __resetStoreForTests,
} from "../src/org-store.js";
import { newOrganisation, newWorkspace, newMembership, newInvitation, newResourceOwnership } from "../src/organisation.js";

beforeEach(() => {
  __resetStoreForTests();
});

describe("organisations", () => {
  it("creates, reads, lists, updates and deletes", () => {
    const org = newOrganisation("org-1", "Acme Corp", "acme", "0xabc");
    createOrganisation(org);
    expect(getOrganisation("org-1")).toEqual(org);
    expect(listOrganisations()).toHaveLength(1);

    const updated = updateOrganisation("org-1", { status: "suspended" });
    expect(updated?.status).toBe("suspended");
    expect(getOrganisation("org-1")?.status).toBe("suspended");

    expect(deleteOrganisation("org-1")).toBe(true);
    expect(getOrganisation("org-1")).toBeNull();
    expect(listOrganisations()).toHaveLength(0);
  });

  it("returns null for unknown organisation", () => {
    expect(getOrganisation("nope")).toBeNull();
    expect(updateOrganisation("nope", { name: "x" })).toBeNull();
    expect(deleteOrganisation("nope")).toBe(false);
  });

  it("rejects duplicate organisation", () => {
    const org = newOrganisation("org-1", "Acme", "acme", "0xabc");
    createOrganisation(org);
    expect(() => createOrganisation(org)).toThrow();
  });
});

describe("workspaces", () => {
  it("creates and lists within an org", () => {
    const org = newOrganisation("org-1", "Acme", "acme", "0xabc");
    createOrganisation(org);
    const ws = newWorkspace("ws-1", "org-1", "Main", "main", "0xabc");
    createWorkspace(ws);
    expect(getWorkspace("ws-1")).toEqual(ws);
    expect(listWorkspaces("org-1")).toHaveLength(1);
    expect(listWorkspaces("other-org")).toHaveLength(0);
  });

  it("rejects workspace with unknown organisation", () => {
    const ws = newWorkspace("ws-1", "nope", "Main", "main", "0xabc");
    expect(() => createWorkspace(ws)).toThrow();
  });

  it("rejects duplicate workspace", () => {
    const org = newOrganisation("org-1", "Acme", "acme", "0xabc");
    createOrganisation(org);
    const ws = newWorkspace("ws-1", "org-1", "Main", "main", "0xabc");
    createWorkspace(ws);
    expect(() => createWorkspace(ws)).toThrow();
  });
});

describe("memberships", () => {
  const org = newOrganisation("org-1", "Acme", "acme", "0xabc");
  const principal = "0xdef";

  beforeEach(() => {
    createOrganisation(org);
  });

  it("creates and resolves membership by principal+org", () => {
    const m = newMembership("m-1", "org-1", principal, "org.owner", "0xabc");
    createMembership(m);
    expect(getMembershipByPrincipalAndOrg(principal, "org-1")).toEqual(m);
    expect(isMemberOf(principal, "org-1")).toBe(true);
    expect(roleForPrincipalInOrg(principal, "org-1")).toBe("org.owner");
    expect(organisationsForPrincipal(principal)).toContain("org-1");
    expect(membersOf("org-1")).toContain(principal);
  });

  it("lists memberships for org and principal", () => {
    createWorkspace(newWorkspace("ws-1", "org-1", "Main", "main", "0xabc"));
    const m1 = newMembership("m-1", "org-1", principal, "org.owner", "0xabc");
    const m2 = newMembership("m-2", "org-1", principal, "org.readonly.analyst", "0xabc", "ws-1");
    createMembership(m1);
    createMembership(m2);
    expect(listMemberships("org-1")).toHaveLength(3);
    expect(listMembershipsForPrincipal(principal)).toHaveLength(2);
  });

  it("revokes membership", () => {
    const m = newMembership("m-1", "org-1", principal, "org.owner", "0xabc");
    createMembership(m);
    expect(isMemberOf(principal, "org-1")).toBe(true);
    expect(revokeMembership("m-1")).toBe(true);
    expect(isMemberOf(principal, "org-1")).toBe(false);
    expect(roleForPrincipalInOrg(principal, "org-1")).toBeNull();
  });

  it("returns null for unknown membership", () => {
    expect(getMembershipByPrincipalAndOrg(principal, "org-1")).toBeNull();
    expect(isMemberOf(principal, "org-1")).toBe(false);
    expect(roleForPrincipalInOrg(principal, "org-1")).toBeNull();
    expect(organisationsForPrincipal(principal)).toHaveLength(0);
    expect(membersOf("org-1")).toHaveLength(1);
  });

  it("expired membership is not active", () => {
    const m = newMembership("m-1", "org-1", principal, "org.owner", "0xabc", undefined, Date.now() - 1000);
    createMembership(m);
    expect(isMemberOf(principal, "org-1")).toBe(false);
  });
});

describe("invitations", () => {
  const org = newOrganisation("org-1", "Acme", "acme", "0xabc");

  beforeEach(() => {
    createOrganisation(org);
  });

  it("creates, accepts and revokes", () => {
    const inv = newInvitation("inv-1", "org-1", "org.evaluator", "0xabc", 1000 * 60 * 60);
    createInvitation(inv);
    expect(getInvitation("inv-1")).toEqual(inv);

    const accepted = acceptInvitation("inv-1", "alice@example.com");
    expect(accepted?.used).toBe(true);
    expect(accepted?.acceptedBy).toBe("alice@example.com");

    const inv2 = newInvitation("inv-2", "org-1", "org.reviewer", "0xabc", 1000 * 60 * 60);
    createInvitation(inv2);
    expect(revokeInvitation("inv-2")).toBe(true);
    expect(acceptInvitation("inv-2", "bob@example.com")).toBeNull();
  });

  it("rejects already-used invitation", () => {
    const inv = newInvitation("inv-1", "org-1", "org.evaluator", "0xabc", 1000 * 60 * 60);
    createInvitation(inv);
    acceptInvitation("inv-1", "alice@example.com");
    expect(acceptInvitation("inv-1", "alice@example.com")).toBeNull();
  });

  it("rejects expired invitation", () => {
    const inv = newInvitation("inv-1", "org-1", "org.evaluator", "0xabc", 0);
    createInvitation(inv);
    expect(acceptInvitation("inv-1", "alice@example.com")).toBeNull();
  });

  it("rejects revoked invitation", () => {
    const inv = newInvitation("inv-1", "org-1", "org.evaluator", "0xabc", 1000 * 60 * 60);
    createInvitation(inv);
    revokeInvitation("inv-1");
    expect(acceptInvitation("inv-1", "alice@example.com")).toBeNull();
  });

  it("enforces domain restriction at accept time", () => {
    const inv = newInvitation("inv-1", "org-1", "org.evaluator", "0xabc", 1000 * 60 * 60, undefined, undefined, "acme.com");
    createInvitation(inv);
    expect(acceptInvitation("inv-1", "alice@example.com")).toBeNull();
    expect(acceptInvitation("inv-1", "alice@acme.com")).not.toBeNull();
  });

  it("returns null for unknown invitation", () => {
    expect(getInvitation("nope")).toBeNull();
    expect(acceptInvitation("nope", "alice@example.com")).toBeNull();
    expect(revokeInvitation("nope")).toBe(false);
  });
});

describe("resource ownership", () => {
  const org = newOrganisation("org-1", "Acme", "acme", "0xabc");

  beforeEach(() => {
    createOrganisation(org);
  });

  it("creates and lists resources for org and principal", () => {
    const r = newResourceOwnership("run-1", "org-1", "0xdef", "private");
    createResourceOwnership(r);
    expect(getResourceOwnership("run-1")).toEqual(r);
    expect(listResourcesForOrg("org-1")).toHaveLength(1);
    expect(listResourcesForPrincipal("0xdef")).toHaveLength(1);
    expect(listResourcesForPrincipal("0xother")).toHaveLength(0);
  });

  it("rejects duplicate resource ownership", () => {
    const r = newResourceOwnership("run-1", "org-1", "0xdef", "private");
    createResourceOwnership(r);
    expect(() => createResourceOwnership(r)).toThrow();
  });

  it("returns null for unknown resource", () => {
    expect(getResourceOwnership("nope")).toBeNull();
  });
});

describe("organisation deletion cascades", () => {
  it("removes workspaces, memberships, invitations and resources", () => {
    const org = newOrganisation("org-1", "Acme", "acme", "0xabc");
    createOrganisation(org);
    createWorkspace(newWorkspace("ws-1", "org-1", "Main", "main", "0xabc"));
    createMembership(newMembership("m-1", "org-1", "0xdef", "org.owner", "0xabc"));
    createInvitation(newInvitation("inv-1", "org-1", "org.evaluator", "0xabc", 1000 * 60 * 60));
    createResourceOwnership(newResourceOwnership("run-1", "org-1", "0xdef", "private"));

    deleteOrganisation("org-1");

    expect(getWorkspace("ws-1")).toBeNull();
    expect(getMembershipByPrincipalAndOrg("0xdef", "org-1")).toBeNull();
    expect(getInvitation("inv-1")).toBeNull();
    expect(getResourceOwnership("run-1")).toBeNull();
    expect(isMemberOf("0xdef", "org-1")).toBe(false);
  });
});