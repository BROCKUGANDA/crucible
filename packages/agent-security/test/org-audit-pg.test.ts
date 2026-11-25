/**
 * @file org-audit-pg.test.ts — the audit chain, in PostgreSQL.
 *
 * The claims under test:
 *
 *   - an audit entry survives a restart;
 *   - the chain CONTINUES across a restart — the head is the last entry in
 *     the table, not a field in this process's memory, or every entry
 *     written before the restart would be orphaned;
 *   - two writers cannot both link to the same head (the append is
 *     serialised and the link is checked inside the transaction);
 *   - the chain verifies after all of that.
 *
 * The store is exercised against a REAL PostgreSQL. A fake cannot tell you
 * that a sequence does not order the way a timestamp does, or that an
 * advisory lock does not hold.
 *
 * The suite is SKIPPED when there is no database to talk to, and says so
 * rather than passing quietly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool, runMigrations } from "../src/database.js";
import {
  configureAuditStore,
  auditStoreKind,
  currentAuditStore,
  newAuditEntry,
  createAuditEntry,
  verifyChain,
  listAllAudit,
  listAuditForOrg,
  __resetAuditStoreForTests,
} from "../src/org-audit.js";
import { pgAuditStore } from "../src/org-audit-pg.js";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const suite = DATABASE_URL ? describe : describe.skip;

suite("org-audit-pg", () => {
  beforeAll(async () => {
    await runMigrations();
    configureAuditStore(pgAuditStore());
  });

  afterAll(async () => {
    await getPool().end().catch(() => {});
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM org_audit_entries");
    await __resetAuditStoreForTests();
  });

  it("says that the chain is durable", () => {
    expect(auditStoreKind()).toBe("postgresql");
  });

  it("keeps an entry across a fresh read", async () => {
    const entry = await newAuditEntry("e-pg-1", "0xowner", "org:budget:set", { budgetId: "b-1" }, "org-1");
    await createAuditEntry(entry);

    const found = await currentAuditStore().get("e-pg-1");
    expect(found).not.toBeNull();
    expect(found?.action).toBe("org:budget:set");
    expect(found?.hash).toBe(entry.hash);
    expect(found?.metadata).toEqual({ budgetId: "b-1" });
  });

  it("continues the chain across a restart — the head is the last entry, not a field in memory", async () => {
    const first = await newAuditEntry("e-pg-a", "0xowner", "org:member:invite", {}, "org-1");
    await createAuditEntry(first);

    // A FRESH store over the same table: this is what another process, or
    // this process after a restart, sees.
    configureAuditStore(pgAuditStore());
    const second = await newAuditEntry("e-pg-b", "0xowner", "org:member:accept", {}, "org-1");
    expect(second.prevHash).toBe(first.hash);
    await createAuditEntry(second);

    const entries = await listAllAudit();
    expect(entries.map((entry) => entry.id)).toEqual(["e-pg-a", "e-pg-b"]);
    expect((await verifyChain()).valid).toBe(true);
  });

  it("orders the entries by insertion, not by the clock", async () => {
    // Two entries written in the same millisecond must still have a
    // defined order: the chain's order is the order they were appended.
    const first = await newAuditEntry("e-order-1", "0xowner", "a", {}, "org-1");
    await createAuditEntry(first);
    const second = await newAuditEntry("e-order-2", "0xowner", "b", {}, "org-1");
    await createAuditEntry(second);

    const entries = await listAllAudit();
    expect(entries.map((entry) => entry.id)).toEqual(["e-order-1", "e-order-2"]);
    expect((await verifyChain()).valid).toBe(true);
  });

  it("refuses an entry that does not link to the head", async () => {
    const first = await newAuditEntry("e-link-1", "0xowner", "a", {}, "org-1");
    await createAuditEntry(first);
    const second = await newAuditEntry("e-link-2", "0xowner", "b", {}, "org-1");
    const tampered = { ...second, prevHash: "0".repeat(64) };
    await expect(createAuditEntry(tampered)).rejects.toThrow("prevHash");
  });

  it("does not let two writers fork the chain", async () => {
    // Both writers read the same head. The append is serialised, so the
    // second one is refused rather than linking to a head that is no
    // longer the head — a forked chain verifies as broken.
    const head = await newAuditEntry("e-fork-0", "0xowner", "a", {}, "org-1");
    await createAuditEntry(head);

    const one = await newAuditEntry("e-fork-1", "0xowner", "b", {}, "org-1");
    const two = await newAuditEntry("e-fork-2", "0xowner", "c", {}, "org-1");
    expect(one.prevHash).toBe(two.prevHash);

    await createAuditEntry(one);
    await expect(createAuditEntry(two)).rejects.toThrow("prevHash");

    const entries = await listAllAudit();
    expect(entries).toHaveLength(2);
    expect((await verifyChain()).valid).toBe(true);
  });

  it("the store itself refuses an entry that does not link — not only the domain layer", async () => {
    // The domain layer checks the link before calling the store, and the
    // store checks it AGAIN inside its transaction. The second check is
    // what stops two writers forking the chain, so it is the one that has
    // to be proven: it is reached here by writing straight to the store.
    const head = await newAuditEntry("e-store-0", "0xowner", "a", {}, "org-1");
    await currentAuditStore().append(head);

    const next = await newAuditEntry("e-store-1", "0xowner", "b", {}, "org-1");
    const tampered = { ...next, prevHash: "0".repeat(64) };
    await expect(currentAuditStore().append(tampered)).rejects.toThrow("prevHash");
  });

  it("detects a row that was changed behind the chain's back", async () => {
    // The whole point of the chain: a row edited in the database — by an
    // administrator, by a bug, or by an attacker with the credentials —
    // does not verify.
    const entry = await newAuditEntry("e-tamper-1", "0xowner", "org:budget:set", { budgetId: "b-1" }, "org-1");
    await createAuditEntry(entry);

    await getPool().query("UPDATE org_audit_entries SET action = $1 WHERE id = $2", [
      "org:budget:delete",
      "e-tamper-1",
    ]);

    const verdict = await verifyChain();
    expect(verdict.valid).toBe(false);
    expect(verdict.brokenAt).toBe("e-tamper-1");
    expect(verdict.reason).toBe("hash_mismatch");
  });

  it("lists an organisation's entries, and no other organisation's", async () => {
    const mine = await newAuditEntry("e-org-1", "0xowner", "a", {}, "org-1");
    await createAuditEntry(mine);
    const theirs = await newAuditEntry("e-org-2", "0xother", "b", {}, "org-2");
    await createAuditEntry(theirs);

    expect((await listAuditForOrg("org-1")).map((entry) => entry.id)).toEqual(["e-org-1"]);
    expect((await listAuditForOrg("org-2")).map((entry) => entry.id)).toEqual(["e-org-2"]);
  });

  it("verifies the chain after a restart, with the entries in the database", async () => {
    for (const id of ["e-v-1", "e-v-2", "e-v-3"]) {
      const entry = await newAuditEntry(id, "0xowner", "org:budget:set", { budgetId: id }, "org-1");
      await createAuditEntry(entry);
    }
    configureAuditStore(pgAuditStore());
    const verdict = await verifyChain();
    expect(verdict.valid).toBe(true);
    expect(verdict.brokenAt).toBeUndefined();
  });
});
