/**
 * @file org-roles.test.ts — Ten-role matrix and separation-of-duties tests.
 */

import { describe, it, expect } from "vitest";
import {
  ORG_ROLE_RANK,
  rolePermissions,
  separationOfDutiesDenial,
  parseOrgRole,
  orgRoleToSecurityRole,
  identityStatePermissions,
  identityStateAllows,
} from "../src/org-roles.js";

describe("ORG_ROLE_RANK", () => {
  it("ranks all ten roles", () => {
    const roles = [
      "org.owner",
      "org.billing.admin",
      "org.benchmark.author",
      "org.evaluator",
      "org.runner.operator",
      "org.reviewer",
      "org.auditor",
      "org.readonly.analyst",
      "org.external.collaborator",
      "org.platform.operator",
    ];
    for (const r of roles) {
      expect(typeof ORG_ROLE_RANK[r]).toBe("number");
    }
    expect(ORG_ROLE_RANK["org.owner"]).toBe(4);
    expect(ORG_ROLE_RANK["org.readonly.analyst"]).toBe(0);
  });
});

describe("rolePermissions", () => {
  it("owner has the broadest set", () => {
    const perms = rolePermissions("org.owner");
    expect(perms).toContain("org:manage");
    expect(perms).toContain("org:transfer:ownership");
    expect(perms).toContain("org:budget:set");
  });

  it("billing admin cannot change roles", () => {
    const perms = rolePermissions("org.billing.admin");
    expect(perms).toContain("org:budget:set");
    expect(perms).not.toContain("org:role:change");
    expect(perms).not.toContain("org:transfer:ownership");
  });

  it("reviewer cannot run evaluations", () => {
    const perms = rolePermissions("org.reviewer");
    expect(perms).toContain("reviewer:file:break");
    expect(perms).not.toContain("evaluation:run");
  });

  it("readonly analyst has no write permissions", () => {
    const perms = rolePermissions("org.readonly.analyst");
    expect(perms).toContain("org:read");
    const writePerms = perms.filter((p) => p.includes(":set") || p.includes(":change") || p.includes(":create"));
    expect(writePerms).toHaveLength(0);
  });

  it("no role carries funds:withdraw on-chain (money stays wallet-signed)", () => {
    const allRoles = [
      "org.owner",
      "org.billing.admin",
      "org.benchmark.author",
      "org.evaluator",
      "org.runner.operator",
      "org.reviewer",
      "org.auditor",
      "org.readonly.analyst",
      "org.external.collaborator",
      "org.platform.operator",
    ];
    for (const r of allRoles) {
      expect(rolePermissions(r as any)).not.toContain("funds:withdraw");
    }
  });
});

describe("separationOfDutiesDenial", () => {
  it("blocks billing admin granting owner role", () => {
    expect(
      separationOfDutiesDenial("org.billing.admin", "org.owner", "grant-role"),
    ).toBe("separation-of-duties");
  });

  it("blocks runner operator grading own run", () => {
    expect(
      separationOfDutiesDenial("org.runner.operator", "org.runner.operator", "grade-own-run"),
    ).toBe("separation-of-duties");
  });

  it("blocks benchmark author publishing own benchmark", () => {
    expect(
      separationOfDutiesDenial("org.benchmark.author", "org.benchmark.author", "publish-own-benchmark"),
    ).toBe("separation-of-duties");
  });

  it("returns null for allowed pairings", () => {
    expect(
      separationOfDutiesDenial("org.owner", "org.billing.admin", "grant-role"),
    ).toBeNull();
    expect(
      separationOfDutiesDenial("org.evaluator", "org.reviewer", "grade-own-run"),
    ).toBeNull();
  });
});

describe("parseOrgRole", () => {
  it("parses valid roles", () => {
    expect(parseOrgRole("org.owner")).toBe("org.owner");
    expect(parseOrgRole("org.evaluator")).toBe("org.evaluator");
  });

  it("returns null for unknown role", () => {
    expect(parseOrgRole("not-a-role")).toBeNull();
    expect(parseOrgRole(123)).toBeNull();
    expect(parseOrgRole(undefined)).toBeNull();
  });
});

describe("orgRoleToSecurityRole", () => {
  it("maps org roles to agent-security roles", () => {
    expect(orgRoleToSecurityRole("org.owner")).toBe("operator");
    expect(orgRoleToSecurityRole("org.billing.admin")).toBe("admin");
    expect(orgRoleToSecurityRole("org.evaluator")).toBe("verifier");
    expect(orgRoleToSecurityRole("org.reviewer")).toBe("skeptic");
  });

  it("returns null for unknown role", () => {
    expect(orgRoleToSecurityRole("not-a-role" as any)).toBeNull();
  });
});

describe("identity state permissions (blueprint items 1-20)", () => {
  it("ANONYMOUS gets public read-only permissions", () => {
    const perms = identityStatePermissions("ANONYMOUS");
    expect(perms).toContain("trials:read:public");
    expect(perms).toContain("agents:read:public");
    expect(perms).toContain("scorecards:read:public");
    expect(perms).toContain("leaderboards:read:public");
    expect(perms).toContain("hall:read:public");
    expect(perms).toContain("engrams:read:public");
    expect(perms).toContain("docs:read");
    // Anonymous cannot do wallet-aware or org actions.
    expect(perms).not.toContain("chain:read:public");
    expect(perms).not.toContain("transaction:prepare");
    expect(perms).not.toContain("workspace:read:own");
    expect(perms).not.toContain("org:read");
  });

  it("WALLET_CONNECTED inherits anonymous plus chain reads and transaction prep", () => {
    const perms = identityStatePermissions("WALLET_CONNECTED");
    expect(perms).toContain("trials:read:public");
    expect(perms).toContain("chain:read:public");
    expect(perms).toContain("transaction:prepare");
    expect(perms).not.toContain("workspace:read:own");
  });

  it("SIWE_AUTHENTICATED inherits wallet-connected plus own workspace", () => {
    const perms = identityStatePermissions("SIWE_AUTHENTICATED");
    expect(perms).toContain("chain:read:public");
    expect(perms).toContain("transaction:prepare");
    expect(perms).toContain("workspace:read:own");
    expect(perms).not.toContain("org:read");
  });

  it("TENANT_MEMBER inherits authenticated plus org read", () => {
    const perms = identityStatePermissions("TENANT_MEMBER");
    expect(perms).toContain("workspace:read:own");
    expect(perms).toContain("org:read");
  });

  it("higher states inherit all lower state permissions", () => {
    const anon = identityStatePermissions("ANONYMOUS");
    const wallet = identityStatePermissions("WALLET_CONNECTED");
    const siwe = identityStatePermissions("SIWE_AUTHENTICATED");
    const tenant = identityStatePermissions("TENANT_MEMBER");
    expect(wallet).toEqual(expect.arrayContaining(anon));
    expect(siwe).toEqual(expect.arrayContaining(wallet));
    expect(tenant).toEqual(expect.arrayContaining(siwe));
  });

  it("identityStateAllows returns true for held permissions", () => {
    expect(identityStateAllows("ANONYMOUS", "trials:read:public")).toBe(true);
    expect(identityStateAllows("WALLET_CONNECTED", "chain:read:public")).toBe(true);
    expect(identityStateAllows("SIWE_AUTHENTICATED", "workspace:read:own")).toBe(true);
    expect(identityStateAllows("TENANT_MEMBER", "org:read")).toBe(true);
  });

  it("identityStateAllows returns false for unheld permissions", () => {
    expect(identityStateAllows("ANONYMOUS", "chain:read:public")).toBe(false);
    expect(identityStateAllows("ANONYMOUS", "org:read")).toBe(false);
    expect(identityStateAllows("WALLET_CONNECTED", "workspace:read:own")).toBe(false);
    expect(identityStateAllows("SIWE_AUTHENTICATED", "org:read")).toBe(false);
  });
});
