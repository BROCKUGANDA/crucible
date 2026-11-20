/**
 * @file dead-letter.ts — the durable record of a delivery that failed.
 *
 * The dead letter used to be a Redis queue named "forge-watch-dlq". A payload
 * that exhausted its retries was pushed onto it, and nothing could read it
 * back: a flush, a redeploy or an eviction took the evidence with it, and
 * there was no replay because no message survived to be replayed. That is a
 * queue name, not a mechanism (audit RUN-M3).
 *
 * This store is the durable mechanism. It writes to PostgreSQL — the table
 * this repository already treats as its durable record — so a dead letter
 * survives the queue it came from, and it carries the operations an operator
 * actually needs: list what is waiting, replay a specific message, and record
 * that a message was handled deliberately.
 *
 * The store is deliberately queue-agnostic. It persists; it does not enqueue.
 * The replay action (which needs a BullMQ queue) lives with the consumer, in
 * `@crucible/agent-security`, and calls `markReplayed` once the re-queue is
 * confirmed. Keeping the persistence separate from the transport is what lets
 * the same dead letter survive a transport that is itself the thing that
 * failed.
 */

import type { PgExecutor } from "./pg-store.js";

/** What a dead letter is doing now. */
export type DeadLetterStatus = "pending" | "replayed" | "resolved";

export interface DeadLetter {
  id: number;
  source: string;
  eventId: string | null;
  jobId: string | null;
  jobName: string;
  payload: unknown;
  error: string;
  attempts: number;
  status: DeadLetterStatus;
  replayedAt: number | null;
  resolvedAt: number | null;
  createdAt: number;
}

export interface RecordDeadLetterInput {
  /** Which subsystem gave up: "forge-watch-l0", "forge-watch-relay", ... */
  source: string;
  /** The event this delivery was carrying, when it was carrying one. */
  eventId?: string | null;
  jobId?: string | null;
  jobName: string;
  payload: unknown;
  error: string;
  attempts?: number;
  now?: number;
}

export interface DeadLetterStore {
  /**
   * Persist a failure. Repeated failures of the same message update the
   * existing row rather than stacking copies: "how many times has this
   * failed" has to stay answerable, and a table of duplicates answers a
   * different question.
   */
  record(input: RecordDeadLetterInput): Promise<DeadLetter>;
  /** The operator's queue: waiting, oldest first. */
  listPending(limit?: number): Promise<DeadLetter[]>;
  /** One dead letter by id. */
  get(id: number): Promise<DeadLetter | null>;
  /**
   * Record that the message was re-queued. Returns false when the id does
   * not exist — a replay of a message that is not there must not report
   * success.
   */
  markReplayed(id: number, atMs?: number): Promise<boolean>;
  /**
   * Record that the message was handled deliberately. A resolved message is
   * history: it stays queryable, but it leaves the operator's pending queue.
   */
  markResolved(id: number, atMs?: number): Promise<boolean>;
}

interface DeadLetterRow {
  id: number;
  source: string;
  event_id: string | null;
  job_id: string | null;
  job_name: string;
  payload: unknown;
  error: string;
  attempts: number;
  status: DeadLetterStatus;
  replayed_at: string | number | null;
  resolved_at: string | number | null;
  created_at: string | number;
}

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowToDeadLetter(row: DeadLetterRow): DeadLetter {
  return {
    id: row.id,
    source: row.source,
    eventId: row.event_id,
    jobId: row.job_id,
    jobName: row.job_name,
    payload: row.payload,
    error: row.error,
    attempts: row.attempts,
    status: row.status,
    replayedAt: num(row.replayed_at),
    resolvedAt: num(row.resolved_at),
    createdAt: num(row.created_at) ?? 0,
  };
}

/**
 * Serialise a payload for a JSONB column without ever throwing.
 *
 * A payload that cannot be serialised is a value worth keeping: it is the
 * reason the delivery failed. JSON.stringify throws on a circular structure
 * and on a BigInt, and both are plausible in a job payload. The value is
 * reduced to a description instead of taking the dead-letter write down with
 * it — a failure record that fails to record is not a record.
 */
export function serialisePayload(payload: unknown): string {
  try {
    const text = JSON.stringify(payload ?? null);
    return text === undefined ? "null" : text;
  } catch {
    return JSON.stringify({
      unserialisable: true,
      type: payload === null ? "null" : typeof payload,
      detail: String(payload).slice(0, 200),
    });
  }
}

export function createDeadLetterStore(exec: PgExecutor): DeadLetterStore {
  async function record(input: RecordDeadLetterInput): Promise<DeadLetter> {
    const attempts = input.attempts ?? 1;
    const now = input.now ?? Date.now();
    const result = await exec<DeadLetterRow>(
      `INSERT INTO forge_watch_dead_letters
         (source, event_id, job_id, job_name, payload, error, attempts, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
       ON CONFLICT (source, COALESCE(event_id, job_id))
         WHERE status IN ('pending', 'replayed')
       DO UPDATE SET
         attempts = forge_watch_dead_letters.attempts + 1,
         error = EXCLUDED.error,
         job_name = EXCLUDED.job_name,
         payload = EXCLUDED.payload,
         status = 'pending'
       RETURNING *`,
      [
        input.source,
        input.eventId ?? null,
        input.jobId ?? null,
        input.jobName,
        serialisePayload(input.payload),
        input.error,
        attempts,
        now,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("dead-letter write returned no row");
    return rowToDeadLetter(row);
  }

  async function listPending(limit = 100): Promise<DeadLetter[]> {
    const result = await exec<DeadLetterRow>(
      `SELECT * FROM forge_watch_dead_letters
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    );
    return result.rows.map(rowToDeadLetter);
  }

  async function get(id: number): Promise<DeadLetter | null> {
    const result = await exec<DeadLetterRow>(
      `SELECT * FROM forge_watch_dead_letters WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? rowToDeadLetter(row) : null;
  }

  async function markReplayed(id: number, atMs = Date.now()): Promise<boolean> {
    const result = await exec(
      `UPDATE forge_watch_dead_letters
          SET status = 'replayed', replayed_at = $2
        WHERE id = $1 AND status = 'pending'`,
      [id, atMs],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async function markResolved(id: number, atMs = Date.now()): Promise<boolean> {
    const result = await exec(
      `UPDATE forge_watch_dead_letters
          SET status = 'resolved', resolved_at = $2
        WHERE id = $1`,
      [id, atMs],
    );
    return (result.rowCount ?? 0) > 0;
  }

  return { record, listPending, get, markReplayed, markResolved };
}
