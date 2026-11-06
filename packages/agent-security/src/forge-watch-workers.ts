/**
 * @file forge-watch-workers.ts — Forge Watch monitor worker scaffolding (WFW-004).
 *
 * BullMQ is at-least-once: every processor MUST be idempotent. Monitor jobs
 * never touch on-chain financial outcomes, verdicts, payouts, or bonds (ADR-0025).
 */

import type { Job, WorkerOptions } from "bullmq";
import { createWorker, QUEUE_NAMES, FORGE_WATCH_JOB_DEFAULTS } from "./queue.js";

export interface ForgeWatchMonitorJob {
  schemaVersion: number;
  runId: string;
  trialId?: string;
  eventId?: string;
  eventIds?: string[];
  phase: string;
  enqueuedAt: number;
}

export interface MonitorProcessorResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
}

export type MonitorProcessor = (
  job: Job<ForgeWatchMonitorJob>,
) => Promise<MonitorProcessorResult>;

/**
 * Wrap a processor with minimal idempotency hygiene. The underlying analysis
 * must still be idempotent by jobId/event identity.
 */
export function idempotentMonitorProcessor(
  fn: MonitorProcessor,
): (job: Job<ForgeWatchMonitorJob>) => Promise<void> {
  return async (job) => {
    const data = job.data;
    if (!data || typeof data.runId !== "string" || data.schemaVersion !== 1) {
      // Malformed payload: dead-letter by throwing after attempts exhausted.
      throw new Error("invalid forge-watch monitor job payload");
    }
    await fn(job);
  };
}

/** Placeholder L0 fast-probe processor (no financial side effects). */
export const l0Processor: MonitorProcessor = async (job) => {
  // WFW-004 scaffold: real L0 checks land in subsequent workstreams.
  void job.id;
  return { ok: true, skipped: false, reason: "l0-scaffold" };
};

/** Register scaffold workers. Call from worker process startup when Redis is configured. */
export function registerForgeWatchWorkers(opts?: {
  l0?: MonitorProcessor;
  l1?: MonitorProcessor;
  l2?: MonitorProcessor;
  l3?: MonitorProcessor;
}) {
  const workers = [];
  const wopts = (concurrency: number) => ({ concurrency } as Partial<WorkerOptions>);
  workers.push(
    createWorker(
      QUEUE_NAMES.FORGE_WATCH_L0,
      idempotentMonitorProcessor(opts?.l0 ?? l0Processor),
      wopts(5),
    ),
  );
  if (opts?.l1) {
    workers.push(
      createWorker(
        QUEUE_NAMES.FORGE_WATCH_L1,
        idempotentMonitorProcessor(opts.l1),
        wopts(2),
      ),
    );
  }
  if (opts?.l2) {
    workers.push(
      createWorker(
        QUEUE_NAMES.FORGE_WATCH_L2,
        idempotentMonitorProcessor(opts.l2),
        wopts(1),
      ),
    );
  }
  if (opts?.l3) {
    workers.push(
      createWorker(
        QUEUE_NAMES.FORGE_WATCH_L3,
        idempotentMonitorProcessor(opts.l3),
        wopts(1),
      ),
    );
  }
  return workers;
}

export { FORGE_WATCH_JOB_DEFAULTS };
