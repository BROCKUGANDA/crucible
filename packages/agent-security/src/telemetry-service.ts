/**
 * @file telemetry-service.ts — the process that delivers Forge Watch telemetry.
 *
 * Forge Watch telemetry was written to PostgreSQL and never delivered. The
 * relay existed, the monitor workers existed, and nothing ran either of them:
 * `registerForgeWatchWorkers` was called from no process, and the outbox
 * relay appeared only inside a demo script. The table filled forever, and
 * "telemetry is durable" was true in the sense that a row nobody read is
 * durable.
 *
 * This is the process that closes that gap: it claims due outbox rows, hands
 * each event to the L0 monitor queue, persists the findings the monitor
 * detects, and dead-letters a delivery that cannot be made.
 *
 * It is a service and not a script because it has a lifetime: it drains on an
 * interval, drains once more on shutdown, and reports its backlog as it
 * goes. It touches no money — it reads telemetry and writes findings (ADR-0025).
 *
 * Run it with `npm run telemetry:service`. It refuses to start without a
 * database and a queue: a telemetry service that cannot reach either is a
 * process that would sit there appearing healthy.
 */

import { closeQueues, getQueue, QUEUE_NAMES } from "./queue.js";
import { query } from "./database.js";
import {
  createPgFindingWriter,
  createTelemetryPipeline,
  type TelemetryPipeline,
} from "./forge-watch-telemetry.js";

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
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required by the telemetry service`);
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

export interface TelemetryServiceOptions {
  pipeline?: TelemetryPipeline;
  drainIntervalMs?: number;
  statsIntervalMs?: number;
  retentionMs?: number;
  onLog?: (line: string) => void;
}

export interface TelemetryService {
  /** Stop draining and close the queues. Safe to call twice. */
  stop(): Promise<void>;
  /** One drain pass, exposed so a test can drive the service. */
  drainOnce(): Promise<number>;
}

/**
 * Start the telemetry service.
 *
 * The relay and the workers are independent: the relay claims rows and
 * enqueues jobs, the workers consume them. Both are needed for delivery to
 * complete, so the service refuses to run without both.
 */
export async function startTelemetryService(
  opts: TelemetryServiceOptions = {},
): Promise<TelemetryService> {
  const log = opts.onLog ?? ((line: string) => console.log(`[telemetry] ${line}`));

  const databaseUrl = required("DATABASE_URL");
  void databaseUrl; // read for the fail-fast; the pool resolves it itself
  const redisUrl = required("REDIS_URL");
  void redisUrl;

  const pipeline =
    opts.pipeline ??
    createTelemetryPipeline({
      pgExecutor: async (text, params) => {
        const result = await query(text, params);
        return { rows: result.rows, rowCount: result.rowCount };
      },
      findWriter: createPgFindingWriter(async (text, params) => {
        await query(text, params);
      }),
    });

  const drainIntervalMs = opts.drainIntervalMs ?? positiveInt("TELEMETRY_DRAIN_INTERVAL_MS", DEFAULT_DRAIN_INTERVAL_MS);
  const statsIntervalMs = opts.statsIntervalMs ?? positiveInt("TELEMETRY_STATS_INTERVAL_MS", DEFAULT_STATS_INTERVAL_MS);
  const retentionMs = opts.retentionMs ?? positiveInt("TELEMETRY_RETENTION_MS", DEFAULT_RETENTION_MS);

  // Opening the queues proves Redis is reachable before the service claims to
  // be running. A telemetry service that reports healthy while its queue is
  // unreachable is worse than one that refuses to start.
  await getQueue(QUEUE_NAMES.FORGE_WATCH_L0).waitUntilReady();
  await getQueue(QUEUE_NAMES.FORGE_WATCH_L1).waitUntilReady();
  await getQueue(QUEUE_NAMES.FORGE_WATCH_L2).waitUntilReady();
  await getQueue(QUEUE_NAMES.FORGE_WATCH_L3).waitUntilReady();

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
    `telemetry service up: drain every ${drainIntervalMs}ms, retention ${Math.round(retentionMs / 86_400_000)}d`,
  );

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(drainTimer);
    clearInterval(statsTimer);
    // One last drain: the shutdown is the moment the backlog is most likely
    // to be finished with, and a row claimed but not delivered would sit
    // until its lease expired.
    try {
      const delivered = await draining.catch(() => 0);
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
    log("telemetry service stopped");
  }

  return { stop, drainOnce };
}
