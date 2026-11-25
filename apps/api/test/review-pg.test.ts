/**
 * @file review-pg.test.ts — the reviewer's own state, in PostgreSQL.
 *
 * The claim under test: a claim survives a restart, and the durable store
 * says the same things the in-memory store says — including the hold: one
 * case, one reviewer.
 *
 * The store is exercised against a REAL PostgreSQL. A fake cannot tell you
 * that a column does not exist, that a NOT NULL constraint refuses a write
 * the in-memory path accepts happily, or that the uniqueness rule on the
 * CASE is enforced by anything at all. The in-memory store's uniqueness is
 * a `Map`; here it is a primary key.
 *
 * The suite is SKIPPED when there is no database to talk to, and says so
 * rather than passing quietly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool, runMigrations } from "@crucible/agent-security";
import { configureReviewStore, reviewStoreKind, type ReviewStore } from "../src/review-store.js";
import { pgReviewStore } from "../src/review-pg.js";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const suite = DATABASE_URL ? describe : describe.skip;

const REVIEWER = "0x" + "44".repeat(20);
const OTHER = "0x" + "55".repeat(20);

suite("review-pg", () => {
  let store: ReviewStore;

  beforeAll(async () => {
    await runMigrations();
    configureReviewStore(pgReviewStore());
    store = pgReviewStore();
  });

  afterAll(async () => {
    await getPool().end().catch(() => {});
  });

  beforeEach(async () => {
    await store.reset();
  });

  it("is the postgresql store once configured", () => {
    expect(reviewStoreKind()).toBe("postgresql");
  });

  it("keeps a claim across a fresh read of the table", async () => {
    await store.claim({ trialId: 1, reviewer: REVIEWER, claimedAt: 100 });
    const pool = getPool();
    const rows = await pool.query("SELECT * FROM review_claims WHERE trial_id = 1");
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].reviewer).toBe(REVIEWER);
  });

  it("a claim survives a restart — a fresh store finds the same claim", async () => {
    await store.claim({ trialId: 7, reviewer: REVIEWER, claimedAt: 111 });
    // A brand new store object over the same database: this is what a
    // restart looks like from here.
    const restarted = pgReviewStore();
    const claim = await restarted.getClaim(7);
    expect(claim?.reviewer).toBe(REVIEWER);
    expect(claim?.claimedAt).toBe(111);
  });

  it("HOLDS a case: a second reviewer cannot take a held case", async () => {
    await store.claim({ trialId: 3, reviewer: REVIEWER, claimedAt: 1 });
    await expect(
      store.claim({ trialId: 3, reviewer: OTHER, claimedAt: 2 }),
    ).rejects.toThrow(/already held by another reviewer/);
    const held = await store.getClaim(3);
    expect(held?.reviewer).toBe(REVIEWER);
  });

  it("lets the same reviewer re-claim their own case", async () => {
    await store.claim({ trialId: 4, reviewer: REVIEWER, claimedAt: 1 });
    await expect(
      store.claim({ trialId: 4, reviewer: REVIEWER, claimedAt: 5 }),
    ).resolves.toBeUndefined();
    const held = await store.getClaim(4);
    expect(held?.claimedAt).toBe(1);
  });

  it("releases a claim only for the reviewer who holds it", async () => {
    await store.claim({ trialId: 5, reviewer: REVIEWER, claimedAt: 1 });
    expect(await store.release(5, OTHER)).toBe(false);
    expect(await store.release(5, REVIEWER)).toBe(true);
    expect(await store.getClaim(5)).toBeNull();
  });

  it("keeps an abstention with the reviewer's own words", async () => {
    await store.abstain({
      trialId: 9,
      reviewer: REVIEWER,
      reason: "I built the suite",
      abstainedAt: 42,
    });
    const entries = await store.listAbstentions();
    const mine = entries.find((entry) => entry.trialId === 9);
    expect(mine?.reason).toBe("I built the suite");
    expect(mine?.abstainedAt).toBe(42);
  });

  it("a second abstention by the same reviewer replaces the first", async () => {
    await store.abstain({ trialId: 9, reviewer: REVIEWER, reason: "first", abstainedAt: 1 });
    await store.abstain({ trialId: 9, reviewer: REVIEWER, reason: "second", abstainedAt: 2 });
    const mine = (await store.listAbstentions()).filter((entry) => entry.trialId === 9);
    expect(mine.length).toBe(1);
    expect(mine[0].reason).toBe("second");
  });

  it("lists the claims", async () => {
    await store.claim({ trialId: 1, reviewer: REVIEWER, claimedAt: 1 });
    await store.claim({ trialId: 2, reviewer: OTHER, claimedAt: 2 });
    const claims = await store.listClaims();
    expect(claims.map((claim) => claim.trialId)).toEqual([1, 2]);
  });
});
