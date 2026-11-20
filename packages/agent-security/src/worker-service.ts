/**
 * @file worker-service.ts — the one background process.
 *
 * Crucible had two candidates for "the worker" and neither was right:
 *
 *   - `apps/api/src/worker.ts` claimed three queues and returned
 *     `{ status: "scheduled" }`, `{ delivered: true }`, `{ cleaned: true }`,
 *     `{ reset: true }` and `{ reconciled: true }` without doing any of
 *     those things. Seven behaviours that reported success and performed
 *     nothing.
 *   - `packages/agent-security/src/telemetry-service.ts` did one real thing
 *     properly — it delivered Forge Watch telemetry — but called itself the
 *     telemetry service, so a second scheduling path grew beside it.
 *
 * This file is the consolidation: one process, one drain loop, one scheduler,
 * one shutdown path. Every job it registers has a handler that does the work
 * or does not get registered. There is no "scheduled" here that is not done.
 *
 * The parts that stay separate:
 *
 *   - the pipeline (`forge-watch-telemetry.ts`) knows how a delivery is made;
 *   - `queue.ts` knows how a queue is opened;
 *   - the entrypoint (`apps/api/src/worker.ts`) knows which jobs this
 *     deployment wants, because that differs between a laptop and a server.
 *
 * Nothing here touches money: the worker reads telemetry, housekeeping
 * tables and the chain, and writes findings, reports and receipts
 * (ADR-0025). It never signs and never moves ETH.
 */

import { closeQueues, scheduleRecurring } from "./queue.js";
import {
  createPgFindingWriter,
  createTelemetryPipeline,
  type TelemetryPipeline,
  type TelemetryStats,
} from "./forge-watch-telemetry.js";
import { query } from "./database.js";

/** How often the relay runs. Five seconds matches the demo's cadence. */
const DEFAULT_DRAIN_INTERVAL_MS = 5_000;

/** How often the backlog is reported. */
const DEFAULT_STATS_INTERVAL_MS = 60_000;

/**
 * Dispatched outbox rows older than this are removed.
 *
 * The outbox is a delivery queue, not an archive: once a row is delivered and
 * acknowledged, keeping it forever buys nothing that `forge_watch_events`
 * does not already hold. Seven days is long enough to investigate a
 * discrepancy that surfaces late.
 */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * A job that repeats on a schedule.
 *
 * `id` is the scheduler's key: two registrations of the same id are the same
 * schedule, so a restart or a second instance updates it rather than
 * doubling it.
 */
export interface RecurringJobSpec {
  /** Stable scheduler id, e.g. `outbox-retention`. */
  id: string;
  /** The cadence. */
  everyMs: number;
  /** The queue the job is placed on. */
  queueName: string;
  /** The job name the worker switches on. */
  jobName: string;
  /** The job payload. */
  data?: unknown;
}

export interface WorkerServiceOptions {
  /** The telemetry pipeline whose workers and relay this service drives. */
  pipeline?: TelemetryPipeline;
  /** Jobs to run on a schedule. Registered before the first drain. */
  jobs?: RecurringJobSpec[];
  drainIntervalMs?: number;
  statsIntervalMs?: number;
  onLog?: (line: string) => void;
  /** Injectable clock, so a test can drive the schedule. */
  now?: () => number;
}

export interface WorkerService {
  /** Stop draining, stop the workers and close the queues. Safe to call twice. */
  stop(): Promise<void>;
  /** One drain pass, exposed so a test can drive the service. */
  drainOnce(): Promise<number>;
  /** The telemetry backlog and the dead-letter count. */
  stats(): Promise<TelemetryStats>;
  /** The ids of the registered schedules. */
  scheduledJobIds(): string[];
}

/**
 * Build the default pipeline over PostgreSQL and BullMQ.
 *
 * Kept here so the entrypoint does not have to know how a finding is
 * written, and so a test can pass its own pipeline instead.
 */
export function createDefaultPipeline(onLog?: (line: string) => void): TelemetryPipeline {
  return createTelemetryPipeline({
    pgExecutor: async (text, params) => {
      const result = await query(text, params);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    findWriter: createPgFindingWriter(async (text, params) => {
      await query(text, params);
    }),
    onLog,
  });
}

/**
 * Start the worker service.
 *
 * The relay and the workers are independent: the relay claims rows and
 * enqueues jobs, the workers consume them. Both are needed for delivery to
 * complete, so the service refuses to run without both.
 */
export async function startWorkerService(
  opts: WorkerServiceOptions = {},
): Promise<WorkerService> {
  const log = opts.onLog ?? ((line: string) => console.log(`[worker] ${line}`));

  const databaseUrl = required("DATABASE_URL");
  void databaseUrl; // read for the fail-fast; the pool resolves it itself
  const redisUrl = required("REDIS_URL");
  void redisUrl;

  const pipeline = opts.pipeline ?? createDefaultPipeline(log);

  const drainIntervalMs =
    opts.drainIntervalMs ?? positiveInt("WORKER_DRAIN_INTERVAL_MS", DEFAULT_DRAIN_INTERVAL_MS);
  const statsIntervalMs =
    opts.statsIntervalMs ?? positiveInt("WORKER_STATS_INTERVAL_MS", DEFAULT_STATS_INTERVAL_MS);

  // The schedules are registered before the first drain: a service that
  // delivers telemetry but has not armed its housekeeping has silently lost
  // the housekeeping, and the only sign of that is a table that grows forever.
  const scheduledJobIds: string[] = [];
  for (const job of opts.jobs ?? []) {
    await scheduleRecurring(job);
    scheduledJobIds.push(job.id);
  }
  if (scheduledJobIds.length > 0) {
    log(`schedules registered: ${scheduledJobIds.join(", ")}`);
  }

  let stopping = false;
  let draining: Promise<number> = Promise.resolve(0);

  async function drainOnce(): Promise<number> {
    if (stopping) return 0;
    // One drain at a time. Two concurrent passes would claim rows against
    // each other and make the queue depth look like a burst of activity.
    const run = draining.then(
      () => pipeline.drainOnce(),
      () => pipeline.drainOnce(),
    );
    draining = run.catch(() => 0);
    return run;
  }

  const drainTimer = setInterval(() => {
    void drainOnce().catch((err) => {
      log(`drain failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, drainIntervalMs);
  drainTimer.unref?.();

  const statsTimer = setInterval(() => {
    void pipeline
      .stats()
      .then((stats) => {
        log(
          `backlog ${stats.pendingEvents} undelivered` +
            (stats.oldestPendingAgeMs === null
              ? ""
              : ` (oldest ${Math.round(stats.oldestPendingAgeMs / 1000)}s)`) +
            `, ${stats.pendingDeadLetters} dead letter(s)`,
        );
      })
      .catch((err) => {
        log(`stats failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, statsIntervalMs);
  statsTimer.unref?.();

  log(
    `worker up: drain every ${drainIntervalMs}ms, ` +
      `${scheduledJobIds.length} schedule(s), queues ${pipeline.workers.length} consumer(s)`,
  );

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(drainTimer);
    clearInterval(statsTimer);
    // One last drain: the shutdown is the moment the backlog is most likely
    // to be finished with, and a row claimed but not delivered would sit
    // until its lease expired.
    //
    // This is a REAL drain, not the in-flight one awaited: the row that
    // needs delivering is the one claimed after the last interval tick, and
    // awaiting the previous pass would deliver nothing. The in-flight pass
    // is awaited first so the two do not claim against each other.
    try {
      await draining.catch(() => 0);
      const delivered = await pipeline.drainOnce();
      if (delivered > 0) log(`final drain delivered ${delivered} event(s)`);
    } catch {
      // Shutdown must not fail because the last drain could not run.
    }
    for (const worker of pipeline.workers) {
      await worker.close().catch(() => {
        // A worker that cannot close cleanly must not block shutdown.
      });
    }
    await closeQueues();
    // The schedules are deliberately left registered. They live in Redis, they
    // are keyed by id, and a worker that stops for a deploy while another
    // instance keeps running must not disarm the other instance's cadence.
    log("worker stopped");
  }

  return {
    stop,
    drainOnce,
    stats: () => pipeline.stats(),
    scheduledJobIds: () => [...scheduledJobIds],
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required by the worker service`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return parsed;
}
