/**
 * @file outbox.ts — the delivery half of the transactional outbox.
 *
 * Events are persisted with an outbox row in the same transaction, but nothing
 * consumed those rows: the table filled forever and no monitor job was ever
 * dispatched. The relay claims due rows with FOR UPDATE SKIP LOCKED (two relay
 * processes never take the same row), hands each to the dispatcher, and marks
 * the row dispatched. A lease means a crashed relay's claims become claimable
 * again, and a failed dispatch is retried with a bounded backoff rather than
 * dropped.
 */

import type { PgExecutor } from "./pg-store.js";

export interface OutboxRow {
  id: number;
  eventId: string;
  phase: string;
  attempts: number;
}

export interface OutboxRelayOptions {
  pgExecutor: PgExecutor;
  /** Deliver one row; resolving marks it dispatched, throwing schedules a retry. */
  dispatch: (row: OutboxRow) => Promise<void>;
  /** Rows claimed per pass. */
  batchSize?: number;
  /** How long a claim is owned before another relay may take it. */
  leaseMs?: number;
  now?: () => number;
  onLog?: (line: string) => void;
}

export interface OutboxRelay {
  /** One drain pass. Returns how many rows were delivered. */
  drainOnce(): Promise<number>;
}

interface ClaimedRow {
  id: number;
  event_id: string;
  phase: string;
  attempts: number;
}

export function createOutboxRelay(opts: OutboxRelayOptions): OutboxRelay {
  const batchSize = opts.batchSize ?? 25;
  const leaseMs = opts.leaseMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const log = opts.onLog ?? (() => {});

  async function drainOnce(): Promise<number> {
    const at = now();
    const claimed = await opts.pgExecutor<ClaimedRow>(
      `UPDATE forge_watch_outbox SET
         status = 'dispatching', attempts = attempts + 1, lease_until = $1
       WHERE id IN (
         SELECT id FROM forge_watch_outbox
          WHERE status IN ('pending', 'dispatching')
            AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
            AND (lease_until IS NULL OR lease_until < $2)
          ORDER BY id ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id, event_id, phase, attempts`,
      [at + leaseMs, at, batchSize],
    );

    let delivered = 0;
    for (const row of claimed.rows) {
      try {
        await opts.dispatch({ id: row.id, eventId: row.event_id, phase: row.phase, attempts: row.attempts });
        await opts.pgExecutor(
          `UPDATE forge_watch_outbox
              SET status = 'dispatched', lease_until = NULL, last_error = NULL
            WHERE id = $1`,
          [row.id],
        );
        delivered += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Bounded exponential backoff: 1 min, 2, 4, 8, then 5 min per attempt.
        const backoffMs = Math.min(60_000 * row.attempts, 300_000);
        await opts.pgExecutor(
          `UPDATE forge_watch_outbox
              SET status = 'pending', lease_until = NULL, next_attempt_at = $2, last_error = $3
            WHERE id = $1`,
          [row.id, at + backoffMs, message],
        );
        log(`event ${row.event_id} dispatch failed (attempt ${row.attempts}): ${message}`);
      }
    }
    return delivered;
  }

  return { drainOnce };
}
