/**
 * @file org-store-pg.test.ts — the tenancy model, in PostgreSQL.
 *
 * The claim under test: who may see what survives a restart, and two
 * processes agree about it.
 *
 * The store is exercised against a REAL PostgreSQL. A fake pool cannot tell
 * you that a column does not exist, that a constraint refuses a legitimate
 * write, or that a membership written by one process is invisible to the
 * next.
 *
 * The suite is SKIPPED when there is no database to talk to, and says so
 * rather than passing quietly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool, runMigrations } from "../src/database.js";
import {
  configureOrgPersistence,
  hydrateOrgStore,
  orgPersistenceKind,
  createOrganisationDurable,
  createMembershipDurable,
  revokeMembershipDurable,
  createInvitationDurable,
  acceptInvitationDurable,
  createWorkspaceDurable,
  createResourceOwnershipDurable,
  updateOrganisationDurable,
  deleteOrganisationDurable,
  getOrganisation,
  listOrganisations,
  getMembershipByPrincipalAndOrg,
  isMemberOf,
  listMemberships,
  organisationsForPrincipal,
  membersOf,
  getInvitation,
  getWorkspace,
  getResourceOwnership,
  __resetStoreForTests,
} from "../src/org-store.js";
import { pgOrgPersistence } from "../src/org-store-pg.js";
import { newOrganisation, newWorkspace, newMembership, newInvitation, newResourceOwnership } from "../src/organisation.js";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const suite = DATABASE_URL ? describe : describe.skip;

const OWNER = "0x1111111111111111111111111111111111111111";
const MEMBER = "0x2222222222222222222222222222222222222222";

suite("org-store-pg", () => {
  beforeAll(async () => {
    await runMigrations();
    configureOrgPersistence(pgOrgPersistence);
  });

  afterAll(async () => {
    configureOrgPersistence(null);
    __resetStoreForTests();
    await getPool().end().catch(() => {});
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM organisations");
    __resetStoreForTests();
  });

  it("says that the tenancy model is durable", () => {
    expect(orgPersistenceKind()).toBe("postgresql");
  });

  it("writes an organisation and its owner's membership", async () => {
    const org = newOrganisation("org-pg-1", "Persistent Org", "persistent-org", OWNER);
    await createOrganisationDurable(org);

    const row = await getPool().query("SELECT * FROM organisations WHERE id = $1", ["org-pg-1"]);
    expect(row.rows.length).toBe(1);
    expect(row.rows[0]?.slug).toBe("persistent-org");
    expect(row.rows[0]?.owner_id).toBe(OWNER);

    // The owner's membership is written with it, in the same transaction.
    const memberships = await getPool().query("SELECT * FROM memberships WHERE org_id = $1", ["org-pg-1"]);
    expect(memberships.rows.length).toBe(1);
    expect(memberships.rows[0]?.principal_id).toBe(OWNER);
    expect(memberships.rows[0]?.role).toBe("org.owner");
  });

  it("refuses a second organisation with the same id", async () => {
    const org = newOrganisation("org-pg-2", "One", "one", OWNER);
    await createOrganisationDurable(org);
    const again = newOrganisation("org-pg-2", "Two", "two", OWNER);
    await expect(createOrganisationDurable(again)).rejects.toThrow(/already exists/);
  });

  it("refuses a membership for an unknown organisation", async () => {
    const membership = newMembership("mem-pg-x", "org-does-not-exist", MEMBER, "org.member", OWNER);
    await expect(createMembershipDurable(membership)).rejects.toThrow(/unknown organisation/);
  });

  it("refuses a second ACTIVE membership for the same principal", async () => {
    const org = newOrganisation("org-pg-3", "Three", "three", OWNER);
    await createOrganisationDurable(org);
    await createMembershipDurable(
      newMembership("mem-pg-3a", "org-pg-3", MEMBER, "org.member", OWNER),
    );
    // A second live membership for the same principal in the same org is
    // one of two things: a mistake or an escalation. Both are refused.
    await expect(
      createMembershipDurable(newMembership("mem-pg-3b", "org-pg-3", MEMBER, "org.admin", OWNER)),
    ).rejects.toThrow(/already an active member/);
  });

  it("keeps a revoked membership as history and allows the principal to come back", async () => {
    const org = newOrganisation("org-pg-4", "Four", "four", OWNER);
    await createOrganisationDurable(org);
    const first = newMembership("mem-pg-4a", "org-pg-4", MEMBER, "org.member", OWNER);
    await createMembershipDurable(first);
    await revokeMembershipDurable(first.id);

    // The revoked membership is still a row: history, not amnesia. Two rows
    // in total — the owner's own, and the revoked one.
    const rows = await getPool().query(
      "SELECT * FROM memberships WHERE org_id = $1 AND principal_id = $2",
      ["org-pg-4", MEMBER],
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]?.revoked_at).not.toBeNull();

    // And the principal may be given a membership again.
    const second = newMembership("mem-pg-4b", "org-pg-4", MEMBER, "org.member", OWNER);
    await createMembershipDurable(second);
    const after = await getPool().query(
      "SELECT * FROM memberships WHERE org_id = $1 AND principal_id = $2",
      ["org-pg-4", MEMBER],
    );
    // Two rows for this principal: the revoked one and the new one. The
    // owner has a third of their own.
    expect(after.rows.length).toBe(2);
    expect(after.rows.filter((r: Record<string, unknown>) => r.revoked_at === null).length).toBe(1);
    expect(isMemberOf(MEMBER, "org-pg-4")).toBe(true);
  });

  it("writes an invitation, and its acceptance", async () => {
    const org = newOrganisation("org-pg-5", "Five", "five", OWNER);
    await createOrganisationDurable(org);
    const invitation = newInvitation(
      "inv-pg-5",
      "org-pg-5",
      "org.member",
      OWNER,
      60_000,
      undefined,
      undefined,
      undefined,
    );
    await createInvitationDurable(invitation);

    const row = await getPool().query("SELECT * FROM invitations WHERE id = $1", ["inv-pg-5"]);
    expect(row.rows.length).toBe(1);
    expect(row.rows[0]?.used).toBe(false);

    const accepted = await acceptInvitationDurable("inv-pg-5", MEMBER);
    expect(accepted).not.toBeNull();
    const after = await getPool().query("SELECT * FROM invitations WHERE id = $1", ["inv-pg-5"]);
    expect(after.rows[0]?.used).toBe(true);
    expect(after.rows[0]?.accepted_by).toBe(MEMBER);
  });

  it("refuses an invitation that was already used", async () => {
    const org = newOrganisation("org-pg-6", "Six", "six", OWNER);
    await createOrganisationDurable(org);
    const invitation = newInvitation("inv-pg-6", "org-pg-6", "org.member", OWNER, 60_000);
    await createInvitationDurable(invitation);
    expect(await acceptInvitationDurable("inv-pg-6", MEMBER)).not.toBeNull();
    // Single use: a replayed acceptance is detectable and refused.
    expect(await acceptInvitationDurable("inv-pg-6", MEMBER)).toBeNull();
  });

  it("writes a workspace and a resource ownership", async () => {
    const org = newOrganisation("org-pg-7", "Seven", "seven", OWNER);
    await createOrganisationDurable(org);
    const workspace = newWorkspace("ws-pg-7", "org-pg-7", "Workspace", "workspace", OWNER);
    await createWorkspaceDurable(workspace);
    const resource = newResourceOwnership("res-pg-7", "org-pg-7", OWNER, "private");
    await createResourceOwnershipDurable(resource);

    const ws = await getPool().query("SELECT * FROM workspaces WHERE id = $1", ["ws-pg-7"]);
    expect(ws.rows.length).toBe(1);
    const res = await getPool().query("SELECT * FROM resources WHERE resource_id = $1", ["res-pg-7"]);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]?.visibility).toBe("private");
  });

  it("refills the cache from the database — this is what a restart looks like", async () => {
    const org = newOrganisation("org-pg-8", "Eight", "eight", OWNER);
    await createOrganisationDurable(org);
    await createMembershipDurable(newMembership("mem-pg-8", "org-pg-8", MEMBER, "org.member", OWNER));

    // The process restarts: the cache is empty, the database is not.
    __resetStoreForTests();
    expect(listOrganisations().length).toBe(0);
    expect(isMemberOf(MEMBER, "org-pg-8")).toBe(false);

    const hydrated = await hydrateOrgStore();
    expect(hydrated.organisations).toBe(1);
    expect(hydrated.memberships).toBe(2);

    // And now the process knows what it knew before.
    expect(getOrganisation("org-pg-8")?.name).toBe("Eight");
    expect(isMemberOf(MEMBER, "org-pg-8")).toBe(true);
    expect(organisationsForPrincipal(MEMBER)).toContain("org-pg-8");
    expect(membersOf("org-pg-8")).toContain(MEMBER);
    expect(getMembershipByPrincipalAndOrg(MEMBER, "org-pg-8")?.role).toBe("org.member");
  });

  it("does not keep a membership that the database no longer has", async () => {
    const org = newOrganisation("org-pg-9", "Nine", "nine", OWNER);
    await createOrganisationDurable(org);
    await createMembershipDurable(newMembership("mem-pg-9", "org-pg-9", MEMBER, "org.member", OWNER));
    expect(isMemberOf(MEMBER, "org-pg-9")).toBe(true);

    // The row is deleted behind the cache's back — by an operator, or by a
    // second process. The cache must not keep saying yes.
    await getPool().query("DELETE FROM memberships WHERE id = $1", ["mem-pg-9"]);
    __resetStoreForTests();
    await hydrateOrgStore();
    expect(isMemberOf(MEMBER, "org-pg-9")).toBe(false);
    expect(listMemberships("org-pg-9").length).toBe(1); // the owner's own membership
  });

  it("updates and deletes an organisation", async () => {
    const org = newOrganisation("org-pg-10", "Ten", "ten", OWNER);
    await createOrganisationDurable(org);

    const updated = await updateOrganisationDurable("org-pg-10", { name: "Renamed", status: "suspended" });
    expect(updated?.name).toBe("Renamed");
    const row = await getPool().query("SELECT * FROM organisations WHERE id = $1", ["org-pg-10"]);
    expect(row.rows[0]?.name).toBe("Renamed");
    expect(row.rows[0]?.status).toBe("suspended");

    expect(await deleteOrganisationDurable("org-pg-10")).toBe(true);
    const gone = await getPool().query("SELECT * FROM organisations WHERE id = $1", ["org-pg-10"]);
    expect(gone.rows.length).toBe(0);
    // The cascade took the membership with it.
    const memberships = await getPool().query("SELECT * FROM memberships WHERE org_id = $1", ["org-pg-10"]);
    expect(memberships.rows.length).toBe(0);
  });

  it("does not make a write visible when the database refuses it", async () => {
    // A membership row inserted straight into the database, bypassing the
    // store: the cache does not know about it, so the domain check passes
    // and the write reaches the database — which refuses it, because one
    // ACTIVE membership per principal per organisation is a database rule
    // as well as a domain one. This is what two processes writing at once
    // look like.
    const org = newOrganisation("org-pg-12", "Twelve", "twelve", OWNER);
    await createOrganisationDurable(org);
    await getPool().query(
      `INSERT INTO memberships (id, org_id, principal_id, role, created_at, created_by)
       VALUES ('mem-pg-12-direct', $1, $2, 'org.member', 1, $3)`,
      ["org-pg-12", MEMBER, OWNER],
    );

    await expect(
      createMembershipDurable(newMembership("mem-pg-12", "org-pg-12", MEMBER, "org.admin", OWNER)),
    ).rejects.toThrow();

    // The refused write is NOT visible. The cache is never ahead of the
    // database: a record that exists only in the cache is a record that a
    // restart would lose, and a caller told "created" would have been told
    // a lie.
    expect(getMembershipByPrincipalAndOrg(MEMBER, "org-pg-12")).toBeNull();
  });

  it("forgets a record the database no longer has", async () => {
    const org = newOrganisation("org-pg-13", "Thirteen", "thirteen", OWNER);
    await createOrganisationDurable(org);
    expect(getOrganisation("org-pg-13")).not.toBeNull();

    // The row is deleted behind the cache's back — by an operator, or by a
    // second process. Refilling the cache must drop it: a record the
    // database does not have is not a record.
    await getPool().query("DELETE FROM organisations WHERE id = $1", ["org-pg-13"]);
    await hydrateOrgStore();
    expect(getOrganisation("org-pg-13")).toBeNull();
    expect(listOrganisations().find((o) => o.id === "org-pg-13")).toBeUndefined();
  });

  it("refuses the non-durable path while a durable backing is attached", async () => {
    // The guard: a write that only reaches the cache is a write a restart
    // would lose, and it is refused rather than documented.
    const { createOrganisation } = await import("../src/org-store.js");
    const org = newOrganisation("org-pg-11", "Eleven", "eleven", OWNER);
    expect(() => createOrganisation(org)).toThrow(/durable backing is configured/);
  });
});