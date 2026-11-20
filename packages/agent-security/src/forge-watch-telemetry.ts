/**
 * @file forge-watch-telemetry.ts — the production telemetry pipeline.
 *
 * Forge Watch wrote telemetry to `forge_watch_events` and an outbox row in the
 * same transaction. The relay that delivers those rows existed, and the L0
 * monitor that judges them existed, and the finding table they would write to
 * existed — but nothing ran them together. `registerForgeWatchWorkers` was
 * called by no process, and the relay appeared only in a demo script. So the
 * table filled forever and no monitor job was ever dispatched: a database
 * record that is never delivered is not a telemetry pipeline (audit RUN-H1).
 *
 * This module is the wiring, as a library rather than a script, so that:
 *
 *   - the parts stay independently testable (the relay, the worker, the
 *     dead-letter store are all injected);
 *   - there is exactly ONE place that knows how a delivery is made, so the
 *     idempotency key and the payload shape are decided once;
 *   - the service that runs it (`telemetry-service.ts`) is a shell around it.
 *
 * The flow, end to end:
 *
 *   run execution
 *     → event + outbox row, one transaction      (forge-watch collector)
 *     → relay claims the row (FOR UPDATE SKIP LOCKED)
 *     → one L0 monitor job per event, idempotency key `fw:<run>:<event>`
 *     → L0 worker judges the event
 *         → findings written to `forge_watch_findings`
 *     → job exhausts its retries
 *         → written to `forge_watch_dead_letters` (durable, replayable)
 *
 * Nothing here touches money. A monitor job reads telemetry and writes
 * findings; it never signs, never sends a transaction, never touches an
 * escrow balance (ADR-0025).
 */

import {
  createOutboxRelay,
  createDeadLetterStore,
  deliveryJobId,
  monitorEventJob,
  replayJobId,
  type DeadLetter,
  type DeadLetterStore,
  type OutboxRelay,
  type OutboxRow,
  type PgExecutor,
  type QuarantinedDelivery,
} from "@crucible/forge-watch";

import { QUEUE_NAMES, addJob, type QueueName } from "./queue.js";
import {
  registerForgeWatchWorkers,
  l0Processor,
  type AcknowledgementSink,
  type DeadLetterSink,
  type FindingSink,
  type MonitorFinding,
  type MonitorProcessor,
} from "./forge-watch-workers.js";

/** Where a queued finding lands. Implemented by the host over PostgreSQL. */
export interface FindingWriter {
  insertFinding(finding: {
    findingId: string;
    runId: string;
    kind: string;
    sequence?: number;
    expected?: number;
    observed?: number;
    detail: string;
    atMs: number;
  }): Promise<void>;
}

/**
 * The idempotency key of a persisted finding.
 *
 * A monitor job is delivered at least once, so the same finding is offered
 * more than once. The key must therefore be derived from the finding's
 * CONTENT and not from when it was observed: a content-derived key makes the
 * write idempotent (the second write is a no-op), while a timestamp makes
 * every redelivery a new row and turns a redelivery into a flood.
 */
export function findingIdFor(runId: string, finding: MonitorFinding): string {
  const parts = [
    "l0",
    runId,
    finding.kind,
    finding.eventId ?? "",
    finding.expected ?? "",
    finding.observed ?? "",
  ];
  return parts.join(":");
}

/**
 * How a delivery is handed to the queue.
 *
 * Injected rather than called directly so the pipeline can be exercised
 * without a Redis server. That is not a testing convenience: the queue's
 * connection options make a command against an unreachable Redis retry for
 * as long as the client is willing to wait, so a test that reached the real
 * queue would spend its budget waiting for a server that is not there and
 * would pass or fail depending on the machine's connection refusal timing.
 */
export type Enqueue = (
  queueName: string,
  name: string,
  data: unknown,
  options?: {
    attempts?: number;
    backoff?: { delay: number; type?: "fixed" | "exponential" };
    jobId?: string;
    removeOnComplete?: number | boolean;
    removeOnFail?: number | boolean;
  },
) => Promise<unknown>;

export interface TelemetryPipelineOptions {
  /** Executes SQL against the durable store. */
  pgExecutor: PgExecutor;
  /**
   * Where a detected finding is written. Defaults to `forge_watch_findings`.
   */
  findWriter?: FindingWriter;
  /**
   * Where an exhausted job is recorded. Defaults to
   * `forge_watch_dead_letters`.
   */
  deadLetterStore?: DeadLetterStore;
  /** Register the BullMQ workers. Off in tests that only exercise the relay. */
  registerWorkers?: boolean;
  /** How a delivery is handed to the queue. Defaults to BullMQ. */
  enqueue?: Enqueue;
  /** Override the monitor processor (the L0 deterministic probes by default). */
  l0?: MonitorProcessor;
  /** Rows claimed per relay pass. */
  batchSize?: number;
  /** How long a relay claim is owned before another relay may take it. */
  leaseMs?: number;
  /** Deliveries allowed to fail before the row is quarantined. */
  maxAttempts?: number;
  now?: () => number;
  onLog?: (line: string) => void;
}

export interface TelemetryPipeline {
  /** One relay pass. Returns how many events were handed to the queue. */
  drainOnce(): Promise<number>;
  /** The workers, when they were registered. */
  workers: ReturnType<typeof registerForgeWatchWorkers>;
  /** The durable dead-letter store. */
  deadLetters: DeadLetterStore;
  /** The findings sink, exposed so a host can report what was detected. */
  findings: FindingSink;
  /** Re-queue a dead letter. Returns true when it was re-queued. */
  replay(deadLetterId: number): Promise<boolean>;
  /** Mark a dead letter handled deliberately. */
  resolve(deadLetterId: number): Promise<boolean>;
  /** The operator's queue of dead letters. */
  pendingDeadLetters(limit?: number): Promise<DeadLetter[]>;
  /** Health: queue lag and the size of the backlog. */
  stats(): Promise<TelemetryStats>;
  /**
   * Remove delivered outbox rows older than `beforeMs`.
   *
   * Only rows the relay itself marked `dispatched` are eligible: a pending,
   * dispatching or quarantined row is a delivery that has not happened or
   * has not been dealt with, and deleting it would destroy the record of a
   * problem as well as the problem.
   */
  purgeDispatched(beforeMs: number): Promise<number>;
}

export interface TelemetryStats {
  /** Outbox rows that have not been handed over yet. */
  pendingEvents: number;
  /** The oldest undelivered event, in ms since it was written. */
  oldestPendingAgeMs: number | null;
  /** Dead letters waiting for an operator. */
  pendingDeadLetters: number;
}

export function createTelemetryPipeline(
  opts: TelemetryPipelineOptions,
): TelemetryPipeline {
  const now = opts.now ?? Date.now;
  const log = opts.onLog ?? (() => {});
  const deadLetters = opts.deadLetterStore ?? createDeadLetterStore(opts.pgExecutor);
  const enqueue: Enqueue =
    opts.enqueue ?? ((queueName, name, data, options) => addJob(queueName, name, data, options));

  /**
   * The finding sink. A finding that cannot be written is logged and dropped:
   * the alternative is failing the monitor job because the findings table had
   * a problem, which would dead-letter a job whose analysis actually
   * succeeded and lose the analysis with it.
   */
  const findings: FindingSink = {
    async record(finding) {
      const writer = opts.findWriter;
      if (!writer) return;
      try {
        await writer.insertFinding({
          findingId: findingIdFor(finding.runId, finding),
          runId: finding.runId,
          kind: finding.kind,
          sequence: finding.sequence,
          expected: finding.expected,
          observed: finding.observed,
          detail: finding.detail,
          atMs: now(),
        });
      } catch (err) {
        log(
          `finding ${finding.kind} for run ${finding.runId} could not be persisted: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };

  /**
   * The durable dead-letter sink. A job that exhausted its retries goes
   * here instead of into the Redis queue and nowhere else.
   */
  const deadLetterSink: DeadLetterSink = {
    async record(input) {
      await deadLetters.record({
        source: input.source,
        jobId: input.jobId,
        jobName: input.jobName,
        payload: input.payload,
        error: input.error,
        attempts: input.attempts,
        now: now(),
      });
    },
  };

  /**
   * Deliver one outbox row: enqueue a monitor job for its event.
   *
   * The event is read back out of the durable store rather than carried in
   * the outbox row, because the outbox row's job is to say *that* an event is
   * due, and the event's content is the store's business. The job id is
   * derived from the run and the event, so a redelivery after a crash is the
   * same job rather than a second one.
   */
  async function dispatchToQueue(row: OutboxRow): Promise<void> {
    const phase = row.phase.toLowerCase();
    const queueName: QueueName =
      phase === "l1"
        ? QUEUE_NAMES.FORGE_WATCH_L1
        : phase === "l2"
          ? QUEUE_NAMES.FORGE_WATCH_L2
          : phase === "l3"
            ? QUEUE_NAMES.FORGE_WATCH_L3
            : QUEUE_NAMES.FORGE_WATCH_L0;

    await enqueue(queueName, "monitor", await monitorPayloadFor(row), {
      jobId: deliveryJobId(row.eventId, row.phase),
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
  }

  /**
   * Build the monitor payload for a claimed outbox row.
   *
   * The event is fetched from `forge_watch_events` by id. The query is
   * expressed here rather than through `PgEventStore` so the pipeline does
   * not need the store's whole surface, and so the envelope columns can be
   * selected into the narrow `MonitorEvent` shape the worker judges from.
   */
  async function monitorPayloadFor(row: OutboxRow): Promise<Record<string, unknown>> {
    const result = await opts.pgExecutor<{
      event_id: string;
      run_id: string;
      sequence: number;
      event_type: string;
      source: string;
      authorization_decision: string | null;
      tool_id: string | null;
      permission: string | null;
    }>(
      `SELECT event_id, run_id, sequence, event_type, source,
              authorization_decision, tool_id, permission
         FROM forge_watch_events WHERE event_id = $1`,
      [row.eventId],
    );
    const event = result.rows[0];
    if (!event) {
      // The outbox row references an event that is not there. That is a
      // referential problem, not a delivery problem, and retrying it will not
      // fix it — so it is thrown, and the relay's retry ceiling eventually
      // dead-letters it where an operator can see it.
      throw new Error(`outbox row ${row.id} references unknown event ${row.eventId}`);
    }
    return monitorEventJob(event.run_id, {
      eventId: event.event_id,
      sequence: event.sequence,
      eventType: event.event_type,
      source: event.source,
      authorizationDecision: (event.authorization_decision ?? undefined) as
        | "allowed"
        | "denied"
        | "pending"
        | undefined,
      toolId: event.tool_id ?? undefined,
      permission: event.permission ?? undefined,
    }) as unknown as Record<string, unknown>;
  }

  const relay: OutboxRelay = createOutboxRelay({
    pgExecutor: opts.pgExecutor,
    dispatch: dispatchToQueue,
    batchSize: opts.batchSize,
    leaseMs: opts.leaseMs,
    maxAttempts: opts.maxAttempts,
    now,
    onLog: log,
    onQuarantine: async (delivery: QuarantinedDelivery) => {
      // A delivery that failed past its ceiling is a dead letter with a
      // durable home. The event id is the identity, so the same event cannot
      // stack a second pending row.
      await deadLetters.record({
        source: "forge-watch-relay",
        eventId: delivery.row.eventId,
        jobName: `relay:${delivery.row.phase}`,
        payload: delivery.row,
        error: delivery.error,
        attempts: delivery.row.attempts,
        now: now(),
      });
    },
  });

  /**
   * The acknowledgement sink. The consumer finished with these events, so
   * the event rows carry the time. This is what makes "handed over but never
   * acknowledged" answerable from the database.
   */
  const acknowledge: AcknowledgementSink = {
    async acknowledge(_runId, eventIds, atMs) {
      try {
        await opts.pgExecutor(
          `UPDATE forge_watch_events SET dispatched_at = $2 WHERE event_id = ANY($1::text[])`,
          [eventIds, atMs],
        );
      } catch (err) {
        // The analysis succeeded; the acknowledgement is bookkeeping. A failed
        // write must not fail the job, or the analysis would be redelivered
        // and re-run for a bookkeeping problem.
        log(
          `acknowledgement of ${eventIds.length} event(s) could not be written: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };

  const workers = opts.registerWorkers === false
    ? []
    : registerForgeWatchWorkers({
        l0: opts.l0 ?? l0Processor,
        onFinding: findings,
        onAcknowledge: acknowledge,
        onDeadLetter: deadLetterSink,
      });

  /**
   * Re-queue a dead letter.
   *
   * The payload is re-enqueued with a job id derived from the dead letter's
   * id and its attempt count, so a replay is a NEW job (it must be able to run
   * again after the original failed) while two replays of the same
   * attempt are the same job (so a double-click cannot deliver twice).
   */
  async function replay(deadLetterId: number): Promise<boolean> {
    const record = await deadLetters.get(deadLetterId);
    if (!record) return false;
    if (record.status !== "pending") return false;

    await enqueue(QUEUE_NAMES.FORGE_WATCH_L0, record.jobName, record.payload, {
      jobId: replayJobId(record.id, record.attempts),
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
    return deadLetters.markReplayed(record.id, now());
  }

  async function resolve(deadLetterId: number): Promise<boolean> {
    return deadLetters.markResolved(deadLetterId, now());
  }

  async function pendingDeadLetters(limit = 100): Promise<DeadLetter[]> {
    return deadLetters.listPending(limit);
  }

  async function stats(): Promise<TelemetryStats> {
    const backlog = await opts.pgExecutor<{ pending: string; oldest: string | null }>(
      `SELECT COUNT(*)::text AS pending,
              MIN(created_at)::text AS oldest
         FROM forge_watch_outbox
        WHERE status IN ('pending', 'dispatching')`,
    );
    const row = backlog.rows[0];
    const pending = Number(row?.pending ?? 0);
    const oldest = row?.oldest ? Number(row.oldest) : null;
    const dead = await opts.pgExecutor<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM forge_watch_dead_letters WHERE status = 'pending'`,
    );

    return {
      pendingEvents: pending,
      oldestPendingAgeMs: oldest === null ? null : Math.max(0, now() - oldest),
      pendingDeadLetters: Number(dead.rows[0]?.count ?? 0),
    };
  }

  return {
    drainOnce: () => relay.drainOnce(),
    workers,
    deadLetters,
    findings,
    replay,
    resolve,
    pendingDeadLetters,
    stats,
    purgeDispatched: (beforeMs: number) => relay.purgeDispatched(beforeMs),
  };
}

/**
 * The finding sink over PostgreSQL.
 *
 * The write is idempotent on `finding_id` (ON CONFLICT DO NOTHING), which is
 * what makes an at-least-once monitor job safe to persist.
 */
export function createPgFindingWriter(
  exec: (text: string, params: unknown[]) => Promise<unknown>,
): FindingWriter {
  return {
    async insertFinding(finding) {
      await exec(
        `INSERT INTO forge_watch_findings
          (finding_id, run_id, kind, sequence, expected, observed, detail, at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (finding_id) DO NOTHING`,
        [
          finding.findingId,
          finding.runId,
          finding.kind,
          finding.sequence ?? null,
          finding.expected ?? null,
          finding.observed ?? null,
          finding.detail,
          finding.atMs,
        ],
      );
    },
  };
}
