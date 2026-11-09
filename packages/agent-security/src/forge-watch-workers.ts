/**
 * @file forge-watch-workers.ts — Forge Watch monitor worker scaffolding (WFW-004).
 *
 * BullMQ is at-least-once: every processor MUST be idempotent. Monitor jobs
 * never touch on-chain financial outcomes, verdicts, payouts, or bonds (ADR-0025).
 */

import type { Job, Worker, WorkerOptions } from "bullmq";
import {
  createWorker,
  QUEUE_NAMES,
  FORGE_WATCH_JOB_DEFAULTS,
  isFinalFailure,
  routeToDeadLetter,
} from "./queue.js";

export interface ForgeWatchMonitorJob {
  schemaVersion: number;
  runId: string;
  trialId?: string;
  eventId?: string;
  eventIds?: string[];
  phase: string;
  enqueuedAt: number;
  /** The events this job inspects, in producer order (see dispatch.ts). */
  events?: {
    eventId: string;
    sequence: number;
    eventType: string;
    source: string;
    authorizationDecision?: "allowed" | "denied" | "pending";
    toolId?: string;
    permission?: string;
  }[];
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

/**
 * L0 deterministic probes, judged from the events carried in the job.
 *
 * Each check is a property of the envelope itself, so the worker needs no
 * store and no network:
 *   - sequence coverage: within one dispatch, sequences must be strictly
 *     increasing with no gap (a repeat is a replay; a jump is a lost event —
 *     both are telemetry-integrity findings);
 *   - forbidden egress/tool: an `egress.decision` that recorded `denied`, or a
 *     `tool.call.deny`, is a refused call the operator must see;
 *   - sandbox tamper signal: `test.modification` (the runner refuses
 *     test-touching patches, so its presence anywhere is a finding).
 * A job with no events is reported skipped, not passed.
 */
export const l0Processor: MonitorProcessor = async (job) => {
  const events = job.data.events ?? [];
  if (events.length === 0) {
    return { ok: true, skipped: true, reason: "l0:no-events" };
  }

  const findings: string[] = [];

  for (let i = 1; i < events.length; i += 1) {
    const previous = events[i - 1]!.sequence;
    const next = events[i]!.sequence;
    if (next <= previous) {
      findings.push(`l0:sequence-regression:${previous}->${next}`);
    } else if (next > previous + 1) {
      findings.push(`l0:sequence-gap:${previous}->${next}`);
    }
  }

  for (const event of events) {
    if (event.eventType === "egress.decision" && event.authorizationDecision === "denied") {
      findings.push(`l0:forbidden-egress:${event.eventId}`);
    }
    if (event.eventType === "tool.call.deny") {
      findings.push(`l0:forbidden-tool:${event.eventId}`);
    }
    if (event.eventType === "test.modification") {
      findings.push(`l0:test-modification:${event.eventId}`);
    }
  }

  if (findings.length > 0) {
    return { ok: true, skipped: false, reason: findings.join(",") };
  }
  return { ok: true, skipped: false, reason: "l0:passed" };
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

  // A job that exhausts its retry budget was deleted by `removeOnFail` and was
  // nowhere queryable. On the final failure, its payload goes to the DLQ.
  for (const worker of workers as Worker[]) {
    worker.on("failed", (job, err) => {
      if (!job) return;
      const attempts = (job.opts?.attempts ?? FORGE_WATCH_JOB_DEFAULTS.attempts) as number;
      if (!isFinalFailure(job.attemptsMade, attempts)) return;
      void routeToDeadLetter("forge-watch", job, err).catch(() => {
        // The failure that brought us here is already logged by the worker; a
        // dead letter that cannot be written must not throw from a listener.
      });
    });
  }
  return workers;
}

export { FORGE_WATCH_JOB_DEFAULTS };
