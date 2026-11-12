/**
 * Postgres-backed durable transaction store.
 *
 * Implements the same TxStore interface as InMemoryTxStore, but persists to the
 * tables defined in migration 0005. Used in production (DATABASE_URL set); the
 * in-memory store remains for single-process dev/test.
 *
 * Tests run against a real Postgres (DATABASE_URL). Set DATABASE_URL to a test
 * database before running; tests clean up their own rows.
 */

import { Pool, type PoolClient } from "pg";
import type { TxStore, TxIntent, TxState } from "./tx-store.js";

export class PostgresTxStore implements TxStore {
  constructor(private readonly pool: Pool) {}

  async createIntent(intent: TxIntent): Promise<TxIntent> {
    await this.pool.query(
      `INSERT INTO tx_intents (id, principal, tenant_id, chain_id, target, method, payload, state, idempotency_key, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [intent.id, intent.principal, intent.tenantId, intent.chainId, intent.target, intent.method,
       JSON.stringify(intent.payload), intent.state, intent.idempotencyKey, intent.createdAt, intent.updatedAt],
    );
    return { ...intent };
  }

  async getIntent(id: string): Promise<TxIntent | null> {
    const r = await this.pool.query(`SELECT * FROM tx_intents WHERE id=$1`, [id]);
    if (r.rows.length === 0) return null;
    return rowToIntent(r.rows[0]);
  }

  async findByIdempotency(principal: string, key: string): Promise<TxIntent | null> {
    const r = await this.pool.query(
      `SELECT * FROM tx_intents WHERE principal=$1 AND idempotency_key=$2 LIMIT 1`,
      [principal, key],
    );
    if (r.rows.length === 0) return null;
    return rowToIntent(r.rows[0]);
  }

  async updateState(id: string, state: TxState): Promise<void> {
    await this.pool.query(
      `UPDATE tx_intents SET state=$1, updated_at=$2 WHERE id=$3`,
      [state, Date.now(), id],
    );
  }

  async enqueueOutbox(intentId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO tx_outbox (intent_id) VALUES ($1)`,
      [intentId],
    );
  }

  async claimNextOutbox(now: number): Promise<{ intentId: string; attempt: number } | null> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        `SELECT id, intent_id, attempt FROM tx_outbox WHERE next_attempt_at <= $1 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [now],
      );
      if (r.rows.length === 0) { await client.query("COMMIT"); return null; }
      const row = r.rows[0];
      const newAttempt = (row.attempt as number) + 1;
      await client.query(`UPDATE tx_outbox SET attempt=$1 WHERE id=$2`, [newAttempt, row.id]);
      await client.query("COMMIT");
      return { intentId: row.intent_id as string, attempt: newAttempt };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async markOutboxResult(intentId: string, error: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE tx_outbox SET last_error=$1 WHERE intent_id=$2`,
      [error, intentId],
    );
  }

  async getNonce(account: string, chainId: number): Promise<number> {
    const r = await this.pool.query(
      `SELECT nonce FROM chain_nonces WHERE account=$1 AND chain_id=$2`,
      [account, chainId],
    );
    if (r.rows.length === 0) return 0;
    return Number(r.rows[0].nonce);
  }

  async setNonce(account: string, chainId: number, nonce: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO chain_nonces (account, chain_id, nonce, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (account, chain_id) DO UPDATE SET nonce=EXCLUDED.nonce, updated_at=EXCLUDED.updated_at`,
      [account, chainId, nonce, Date.now()],
    );
  }
}

function rowToIntent(r: any): TxIntent {
  return {
    id: r.id,
    principal: r.principal,
    tenantId: r.tenant_id,
    chainId: r.chain_id,
    target: r.target,
    method: r.method,
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    state: r.state,
    idempotencyKey: r.idempotency_key,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
