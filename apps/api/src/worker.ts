/**
 * @file worker.ts — THE background process. One entrypoint, one set of queues.
 *
 * This file used to be a stub. It registered three workers whose processors
 * returned `{ status: "scheduled" }`, `{ delivered: true }`,
 * `{ captured: true }`, `{ cleaned: true }`, `{ reset: true }` and
 * `{ reconciled: true }` — none of which did the thing they named. It also
 * re-added itself with a delay to repeat, and BullMQ keeps completed jobs by
 * default, so the re-added job carried an id a completed job already held:
 * the add was swallowed and a "hourly" job ran exactly once, silently.
 *
 * Nothing ran it either. The compose `worker` service built the API image and
 * the API entrypoint always starts `dist/server.js`, so the "worker" was a
 * second API server.
 *
 * What this does now:
 *
 *   - delivers Forge Watch telemetry (the relay, the L0 monitor, findings,
 *     acknowledgements and the durable dead letter — see
 *     `packages/agent-security/src/forge-watch-telemetry.ts`);
 *   - sweeps delivered outbox rows on a schedule;
 *   - reports the dead-letter backlog on a schedule;
 *   - reconciles the chain against the commercial ledger on a schedule
 *     (`funding-reconciliation.ts`), because a sponsor's money has to be a
 *     chain fact and not an API claim.
 *
 * Run it with `npm run worker:service`. It refuses to start without a
 * database and a queue: a worker that cannot reach either would sit there
 * appearing healthy.
 */

import { createWorker, QUEUE_NAMES } from "@crucible/agent-security";
import {
  createDefaultPipeline,
  startWorkerService,
  DEFAULT_RETENTION_MS,
  type TelemetryPipeline,
} from "@crucible/agent-security";
import type { Worker } from "bullmq";
import { runFundingReconciliation } from "./funding-reconciliation.js";

const log = (line: string) => console.log(`[worker] ${line}`);

/** How often the outbox is swept and the dead-letter backlog reported. */
const HOUSEKEEPING_INTERVAL_MS = 15 * 60 * 1_000;

/** How often the chain is compared against the commercial ledger. */
const RECONCILIATION_INTERVAL_MS = 10 * 60 * 1_000;

/**
 * The maintenance consumer.
 *
 * Every branch here does the work it names. A branch that cannot yet do its
 * work is not registered — it is not registered as a job that returns
 * "ok".
 *
 * It is created inside `main()` rather than at module scope: the pipeline it
 * closes over has to exist first, and a module-scope worker would begin
 * consuming before the process had finished starting.
 */
function createMaintenanceWorker(pipeline: TelemetryPipeline): Worker {
  const worker = createWorker(
    QUEUE_NAMES.MAINTENANCE,
    async (job) => {
      switch (job.name) {
        case "outbox-retention": {
          const cutoff = Date.now() - DEFAULT_RETENTION_MS;
          const removed = await pipeline.purgeDispatched(cutoff);
          log(`outbox retention: removed ${removed} delivered row(s) older than ${DEFAULT_RETENTION_MS}ms`);
          return;
        }
        case "dead-letter-report": {
          const pending = await pipeline.pendingDeadLetters(100);
          if (pending.length === 0) {
            log("dead letters: none pending");
            return;
          }
          log(`dead letters: ${pending.length} pending`);
          for (const record of pending) {
            log(
              `  #${record.id} ${record.source} ${record.jobName}: ${record.error} ` +
                `(${record.attempts} attempt(s))`,
            );
          }
          return;
        }
        case "funding-reconciliation": {
          const report = await runFundingReconciliation();
          if (!report.ran) {
            log(`funding reconciliation did not run: ${report.reason}`);
            return;
          }
          log(
            `funding reconciliation: ${report.checked} claim(s) checked, ` +
              `${report.verified} verified, ${report.mismatched} mismatched, ` +
              `${report.unverifiable} unverifiable`,
          );
          for (const drift of report.drifts) {
            log(`  drift ${drift.programId}: ${drift.reason}`);
          }
          return;
        }
        default:
          // An unknown job name is worth saying out loud: it means a job was
          // scheduled by something this build does not know about. Silently
          // ignoring it is how a schedule rots.
          log(`unknown maintenance job: ${job.name}`);
      }
    },
    { concurrency: 1 },
  );

  worker.on("error", (err) => {
    log(`maintenance worker error: ${err instanceof Error ? err.message : String(err)}`);
  });
  worker.on("failed", (job, err) => {
    log(`maintenance job ${job?.name} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  return worker;
}

async function main(): Promise<void> {
  // The pipeline is created once and shared by the service and the jobs.
  const pipeline = createDefaultPipeline(log);
  const maintenanceWorker = createMaintenanceWorker(pipeline);

  const service = await startWorkerService({
    pipeline,
    jobs: [
      {
        id: "outbox-retention",
        everyMs: HOUSEKEEPING_INTERVAL_MS,
        queueName: QUEUE_NAMES.MAINTENANCE,
        jobName: "outbox-retention",
      },
      {
        id: "dead-letter-report",
        everyMs: HOUSEKEEPING_INTERVAL_MS,
        queueName: QUEUE_NAMES.MAINTENANCE,
        jobName: "dead-letter-report",
      },
      {
        id: "funding-reconciliation",
        everyMs: RECONCILIATION_INTERVAL_MS,
        queueName: QUEUE_NAMES.MAINTENANCE,
        jobName: "funding-reconciliation",
      },
    ],
    onLog: log,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, draining`);
    await maintenanceWorker.close().catch(() => {
      // A worker that cannot close cleanly must not block the shutdown.
    });
    await service.stop().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
