/**
 * Durable transaction store — pluggable interface + in-memory implementation.
 *
 * Mirrors the nonce-store pattern: async interface so a Postgres backend can
 * replace the in-memory adapter without changing callers. The in-memory adapter
 * is for single-process dev/test; production uses Postgres (migration 0005).
 *
 * Stores transaction intent, idempotency, outbox and per-account nonce. No
 * actual chain submission lives here.
 */

export type TxState = "pending" | "simulated" | "submitted" | "included" | "finalized" | "failed" | "reconciled";

export interface TxIntent {
  id: string;
  principal: string;
  tenantId: string;
  chainId: number;
  target: string;
  method: string;
  payload: Record<string, unknown>;
  state: TxState;
  idempotencyKey: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TxStore {
  createIntent(intent: TxIntent): Promise<TxIntent>;
  getIntent(id: string): Promise<TxIntent | null>;
  /** Returns existing intent if idempotency key already used by this principal. */
  findByIdempotency(principal: string, key: string): Promise<TxIntent | null>;
  updateState(id: string, state: TxState): Promise<void>;
  enqueueOutbox(intentId: string): Promise<void>;
  claimNextOutbox(now: number): Promise<{ intentId: string; attempt: number } | null>;
  markOutboxResult(intentId: string, error: string | null): Promise<void>;
  getNonce(account: string, chainId: number): Promise<number>;
  setNonce(account: string, chainId: number, nonce: number): Promise<void>;
}

export class InMemoryTxStore implements TxStore {
  private intents = new Map<string, TxIntent>();
  private outbox: { intentId: string; attempt: number; nextAttemptAt: number; lastError: string | null }[] = [];
  private nonces = new Map<string, number>();

  async createIntent(intent: TxIntent): Promise<TxIntent> {
    this.intents.set(intent.id, { ...intent });
    return { ...intent };
  }

  async getIntent(id: string): Promise<TxIntent | null> {
    const v = this.intents.get(id);
    return v ? { ...v } : null;
  }

  async findByIdempotency(principal: string, key: string): Promise<TxIntent | null> {
    for (const v of this.intents.values()) {
      if (v.principal === principal && v.idempotencyKey === key) return { ...v };
    }
    return null;
  }

  async updateState(id: string, state: TxState): Promise<void> {
    const v = this.intents.get(id);
    if (v) { v.state = state; v.updatedAt = Date.now(); }
  }

  async enqueueOutbox(intentId: string): Promise<void> {
    this.outbox.push({ intentId, attempt: 0, nextAttemptAt: Date.now(), lastError: null });
  }

  async claimNextOutbox(now: number): Promise<{ intentId: string; attempt: number } | null> {
    const idx = this.outbox.findIndex((o) => o.nextAttemptAt <= now);
    if (idx === -1) return null;
    const o = this.outbox[idx];
    if (!o) return null;
    o.attempt += 1;
    return { intentId: o.intentId, attempt: o.attempt };
  }

  async markOutboxResult(intentId: string, error: string | null): Promise<void> {
    const o = this.outbox.find((x) => x.intentId === intentId);
    if (o) o.lastError = error;
  }

  async getNonce(account: string, chainId: number): Promise<number> {
    return this.nonces.get(`${account}:${chainId}`) ?? 0;
  }

  async setNonce(account: string, chainId: number, nonce: number): Promise<void> {
    this.nonces.set(`${account}:${chainId}`, nonce);
  }
}
