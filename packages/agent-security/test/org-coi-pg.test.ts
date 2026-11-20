/**
 * @file org-coi-pg.test.ts — the conflict-of-interest register, in PostgreSQL.
 *
 * The claim under test: a declaration survives a restart, and the check
 * that depends on it still works afterwards. A conflict declared on Monday
 * and forgotten by Tuesday is a conflict that stopped being checked on
 * Tuesday, and the check is the whole point of the register.
 *
 * The suite is SKIPPED when there is no database to talk to, and says so
 * rather than passing quietly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool, runMigrations } from "../src/database.js";
import {
  configureCOIStore,
  coiStoreKind,
  currentCOIStore,
  newCOIEntry,
  recordCOI,
  getCOIEntry,
  listCOIForPrincipal,
  listCOIForOrg,
  revokeCOI,
  conflictsBetween,
  seatIsConflicted,
  __resetCOIStoreForTests,
} from "../src/org-coi.js";
import { pgCOIStore } from "../src/org-coi-pg.js";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const suite = DATABASE_URL ? describe : describe.skip;

suite("org-coi-pg", () => {
  beforeAll(async () => {
    await runMigrations();
    configureCOIStore(pgCOIStore());
  });

  afterAll(async () => {
    await getPool().end().catch(() => {});
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM org_coi_entries");
    await __resetCOIStoreForTests();
  });

  it("says that the register is durable", () => {
    expect(coiStoreKind()).toBe("postgresql");
  });

  it("keeps a declaration across a fresh read", async () => {
    const entry = newCOIEntry("coi-pg-1", "0xalice", "employer", "works at Acme", "0xalice", "org-1");
    await recordCOI(entry);

    const found = await getCOIEntry("coi-pg-1");
    expect(found).not.toBeNull();
    expect(found?.type).toBe("employer");
    expect(found?.description).toBe("works at Acme");
    expect(found?.orgId).toBe("org-1");
    expect(found?.active).toBe(true);
  });

  it("still finds the conflict after a restart", async () => {
    const alice = newCOIEntry("coi-pg-a", "0xalice", "employer", "works at Acme", "0xalice", "org-1");
    const bob = newCOIEntry("coi-pg-b", "0xbob", "employer", "works at Acme", "0xbob", "org-1");
    await recordCOI(alice);
    await recordCOI(bob);

    // A FRESH store over the same table: another process, or this one
    // after a restart.
    configureCOIStore(pgCOIStore());
    const conflicts = await conflictsBetween("0xalice", "0xbob");
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].id).toBe("coi-pg-b");
  });

  it("refuses a duplicate declaration", async () => {
    const entry = newCOIEntry("coi-pg-dup", "0xalice", "employer", "works at Acme", "0xalice", "org-1");
    await recordCOI(entry);
    await expect(recordCOI(entry)).rejects.toThrow("already exists");
  });

  it("withdraws a declaration without deleting it", async () => {
    const entry = newCOIEntry("coi-pg-rev", "0xalice", "employer", "works at Acme", "0xalice", "org-1");
    await recordCOI(entry);
    expect(await revokeCOI("coi-pg-rev")).toBe(true);

    const found = await getCOIEntry("coi-pg-rev");
    expect(found).not.toBeNull();
    expect(found?.active).toBe(false);
    // And it is no longer a conflict.
    const bob = newCOIEntry("coi-pg-rev-b", "0xbob", "employer", "works at Acme", "0xbob", "org-1");
    await recordCOI(bob);
    expect((await conflictsBetween("0xalice", "0xbob")).length).toBe(0);
  });

  it("lists a principal's declarations and an organisation's", async () => {
    const mine = newCOIEntry("coi-pg-m", "0xalice", "employer", "works at Acme", "0xalice", "org-1");
    const theirs = newCOIEntry("coi-pg-t", "0xbob", "employer", "works at Acme", "0xbob", "org-1");
    await recordCOI(mine);
    await recordCOI(theirs);

    expect((await listCOIForPrincipal("0xalice")).map((e) => e.id)).toEqual(["coi-pg-m"]);
    expect((await listCOIForOrg("org-1")).map((e) => e.id)).toEqual(["coi-pg-m", "coi-pg-t"]);
    expect((await listCOIForOrg("org-2")).length).toBe(0);
  });

  it("says which side a seat candidate is conflicted against", async () => {
    const seat = newCOIEntry("coi-pg-seat", "0xseat", "employer", "works at Acme", "0xseat", "org-1");
    const sponsor = newCOIEntry("coi-pg-sponsor", "0xsponsor", "employer", "works at Acme", "0xsponsor", "org-1");
    await recordCOI(seat);
    await recordCOI(sponsor);

    const verdict = await seatIsConflicted("0xseat", "0xsponsor", "0xagent");
    expect(verdict.conflicted).toBe(true);
    expect(verdict.against).toEqual(["sponsor"]);
    expect(verdict.entries.length).toBe(1);
  });

  it("keeps the register's store the one the API would use", async () => {
    expect(currentCOIStore().kind).toBe("postgresql");
  });
});
