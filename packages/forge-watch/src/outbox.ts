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
 *
 * What this file adds on top of that first version, and why each part exists:
 *
 *   - **An attempt ceiling.** The original relay retried a failing delivery
 *     forever with a 5-minute backoff. A poison message — one whose payload is
 *     malformed, or whose consumer is permanently broken — therefore kept a
 *     row claiming attention every five minutes for the life of the
 *     deployment, and it was indistinguishable from a queue that was merely
 *     busy. A delivery that has failed `maxAttempts` times is now *quarantined*:
 *     the row stops being claimed and the reason is handed to
 *     `onQuarantine` so it can be dead-lettered durably.
 *   - **An acknowledgement stamp.** Marking the outbox row dispatched says
 *     "the relay handed this over". `forge_watch_events.dispatched_at` says
 *     "the consumer finished with it". The first without the second is a
 *     queue that lost a message and nobody knows; both together are what let
 *     a reconciliation ask "which events were handed over but never
 *     acknowledged".
 *   - **Retention.** A dispatched row that is never deleted is an unbounded
 *     table of history. `purgeDispatched` removes rows the table's own age
 *     proves are no longer needed; rows still pending are never touched.
 */

import type { PgExecutor } from "./pg-store.js";

export interface OutboxRow {
  id: number;
  eventId: string;
  phase: string;
  attempts: number;
}

/** A delivery that exhausted its attempt budget and was quarantined. */
export interface QuarantinedDelivery {
  row: OutboxRow;
  error: string;
}

export interface OutboxRelayOptions {
  pgExecutor: PgExecutor;
  /** Deliver one row; resolving marks it dispatched, throwing schedules a retry. */
  dispatch: (row: OutboxRow) => Promise<void>;
  /** Rows claimed per pass. */
  batchSize?: number;
  /** How long a claim is owned before another relay may take it. */
  leaseMs?: number;
  /**
   * How many times a delivery may fail before it is quarantined.
   * The default of 8 is roughly an hour of retries at the backoff below, which
   * is long enough to ride out a Redis hiccup and short enough that a
   * genuinely broken message stops cycling within a shift.
   */
  maxAttempts?: number;
  /**
   * Called when a delivery is quarantined. The relay has already stopped
   * claiming the row; this is the hook that makes the failure durable
   * somewhere an operator can find it. A throwing callback does not
   * resurrect the row — the failure is recorded either way.
   */
  onQuarantine?: (delivery: QuarantinedDelivery) => Promise<void> | void;
  now?: () => number;
  onLog?: (line: string) => void;
}

export interface OutboxRelay {
  /** One drain pass. Returns how many rows were delivered. */
  drainOnce(): Promise<number>;
  /**
   * Delete dispatched rows older than `beforeMs`. Returns how many were
   * removed. Rows that are still pending, dispatched-to-a-consumer or
   * quarantined are never removed — this deletes history, not work.
   */
  purgeDispatched(beforeMs: number): Promise<number>;
}

interface ClaimedRow {
  id: number;
  event_id: string;
  phase: string;
  attempts: number;
}

/** The outbox row states. Kept as literals so a typo cannot become a status. */
export const OUTBOX_STATUS = {
  pending: "pending",
  dispatching: "dispatching",
  dispatched: "dispatched",
  /** Failed past its attempt ceiling: no longer claimed, awaiting an operator. */
  quarantined: "quarantined",
} as const;

export function createOutboxRelay(opts: OutboxRelayOptions): OutboxRelay {
  const batchSize = opts.batchSize ?? 25;
  const leaseMs = opts.leaseMs ?? 30_000;
  const maxAttempts = opts.maxAttempts ?? 8;
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
        const row_ref = { id: row.id, eventId: row.event_id, phase: row.phase, attempts: row.attempts };

        if (row.attempts >= maxAttempts) {
          // Quarantine. The row stops being claimed and the reason is offered
          // to the durable dead-letter store. The row itself is updated first:
          // if the process dies between the two, the row is already parked
          // rather than still cycling.
          await opts.pgExecutor(
            `UPDATE forge_watch_outbox
                SET status = 'quarantined', lease_until = NULL, last_error = $2
              WHERE id = $1`,
            [row.id, message],
          );
          try {
            await opts.onQuarantine?.({ row: row_ref, error: message });
          } catch (deadLetterError) {
            // The dead-letter write failed. The row is still quarantined, so
            // the failure cannot loop forever, but the operator must hear
            // about it: a silenced dead-letter failure is how an outage
            // becomes invisible.
            log(
              `event ${row.event_id} quarantined but the dead-letter write failed: ` +
                `${deadLetterError instanceof Error ? deadLetterError.message : String(deadLetterError)}`,
            );
          }
          log(`event ${row.event_id} quarantined after ${row.attempts} attempts: ${message}`);
          continue;
        }

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

  async function purgeDispatched(beforeMs: number): Promise<number> {
    const result = await opts.pgExecutor(
      `DELETE FROM forge_watch_outbox
        WHERE status = 'dispatched' AND created_at < $1`,
      [beforeMs],
    );
    return result.rowCount ?? 0;
  }

  return { drainOnce, purgeDispatched };
}
