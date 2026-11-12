/**
 * @file tx-store-pg.test.ts — the Postgres-backed transaction store.
 *
 * These cases assert against a live PostgreSQL and are reported SKIPPED with a
 * reason when `DATABASE_URL` is unset, matching `database.test.ts` and
 * `cache.test.ts`. The suite deliberately does NOT fall back to a localhost
 * default: an unasked-for dial of localhost means the suite would run migrations
 * and write rows against whatever happens to own that port.
 *
 * The schema is provisioned here rather than assumed. CI starts an empty
 * PostgreSQL and no other api test boots the server (which is what normally
 * calls `runMigrations`), so a store test that assumed the tables existed would
 * fail with "relation does not exist".
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { Client, Pool } from "pg";
import { runMigrations } from "@crucible/agent-security";
import { PostgresTxStore } from "../src/tx-store-pg.js";

const url = process.env.DATABASE_URL ?? null;

async function probe(): Promise<{ ok: boolean; reason: string }> {
  if (!url) {
    return {
      ok: false,
      reason:
        "DATABASE_URL is unset, and this suite will not dial a localhost default unasked",
    };
  }
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const res = await client.query("SELECT 1 AS one");
    return { ok: res.rows[0]?.one === 1, reason: "SELECT 1 answered" };
  } catch (err) {
    return { ok: false, reason: `${url} refused the probe: ${(err as Error).message}` };
  } finally {
    await client.end().catch(() => {});
  }
}

const live = await probe();
if (!live.ok) {
  console.log(
    `SKIPPING tx store (postgres): ${live.reason}. These cases assert behaviour against the ` +
      "real server and there is no server to assert them against. They report SKIPPED, not passed.",
  );
}

const testLive = it.skipIf(!live.ok);

describe("tx store (postgres)", () => {
  let pool: Pool;
  let store: PostgresTxStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url! });
    store = new PostgresTxStore(pool);
    await runMigrations();
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM tx_outbox");
    await pool.query("DELETE FROM chain_nonces");
    await pool.query("DELETE FROM tx_intents");
  });

  testLive("creates and reads intent", async () => {
    await store.createIntent({
      id: "i1", principal: "p", tenantId: "t", chainId: 1, target: "0x", method: "m",
      payload: { a: 1 }, state: "pending", idempotencyKey: "k1", createdAt: 1, updatedAt: 1,
    });
    const got = await store.getIntent("i1");
    expect(got?.state).toBe("pending");
    expect(got?.payload).toEqual({ a: 1 });
  });

  testLive("idempotency lookup returns existing", async () => {
    await store.createIntent({
      id: "i1", principal: "p", tenantId: "t", chainId: 1, target: "0x", method: "m",
      payload: {}, state: "pending", idempotencyKey: "k1", createdAt: 1, updatedAt: 1,
    });
    const found = await store.findByIdempotency("p", "k1");
    expect(found?.id).toBe("i1");
    const missing = await store.findByIdempotency("p", "nope");
    expect(missing).toBeNull();
  });

  testLive("updates state", async () => {
    await store.createIntent({
      id: "i1", principal: "p", tenantId: "t", chainId: 1, target: "0x", method: "m",
      payload: {}, state: "pending", idempotencyKey: null, createdAt: 1, updatedAt: 1,
    });
    await store.updateState("i1", "finalized");
    const got = await store.getIntent("i1");
    expect(got?.state).toBe("finalized");
  });

  testLive("outbox enqueue + claim + result", async () => {
    await store.createIntent({
      id: "i1", principal: "p", tenantId: "t", chainId: 1, target: "0x", method: "m",
      payload: {}, state: "pending", idempotencyKey: null, createdAt: 1, updatedAt: 1,
    });
    await store.enqueueOutbox("i1");
    const claimed = await store.claimNextOutbox(Date.now() + 1000);
    expect(claimed?.intentId).toBe("i1");
    expect(claimed?.attempt).toBe(1);
    await store.markOutboxResult("i1", "boom");
  });

  testLive("nonce get/set", async () => {
    expect(await store.getNonce("0xabc", 1)).toBe(0);
    await store.setNonce("0xabc", 1, 5);
    expect(await store.getNonce("0xabc", 1)).toBe(5);
    expect(await store.getNonce("0xabc", 2)).toBe(0);
    // upsert
    await store.setNonce("0xabc", 1, 9);
    expect(await store.getNonce("0xabc", 1)).toBe(9);
  });

  testLive("idempotency unique constraint", async () => {
    await store.createIntent({
      id: "i1", principal: "p", tenantId: "t", chainId: 1, target: "0x", method: "m",
      payload: {}, state: "pending", idempotencyKey: "k1", createdAt: 1, updatedAt: 1,
    });
    await expect(store.createIntent({
      id: "i2", principal: "p", tenantId: "t", chainId: 1, target: "0x", method: "m",
      payload: {}, state: "pending", idempotencyKey: "k1", createdAt: 1, updatedAt: 1,
    })).rejects.toThrow();
  });
});
