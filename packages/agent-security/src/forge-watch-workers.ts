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

/**
 * A telemetry-integrity problem, as a record rather than a phrase.
 *
 * The L0 processor already detected every one of these — a lost event, a
 * replayed one, a denied egress, a denied tool call, a touched test — and then
 * returned them as one comma-joined string in `reason`. A string is a fine
 * thing to log and a useless thing to persist: it cannot be counted, queried
 * by kind, or written into `forge_watch_findings`, whose columns want exactly
 * these fields. So the same detection is now also emitted as a structured
 * finding. `reason` remains, derived from these findings, because the log
 * line it produces is what an operator reads first.
 */
export interface MonitorFinding {
  /** Stable kind, matching the `kind` convention of forge_watch_findings. */
  kind: string;
  /** Human-readable detail. Names the event or the sequence pair involved. */
  detail: string;
  /** The event the finding is about, when it is about one event. */
  eventId?: string;
  sequence?: number;
  expected?: number;
  observed?: number;
}

export interface MonitorProcessorResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  /** The findings behind `reason`, structured for persistence. */
  findings?: MonitorFinding[];
}

/**
 * Where a finished delivery is acknowledged.
 *
 * The relay marking an outbox row dispatched records that the event was
 * handed to the queue. The acknowledgement records that the consumer finished
 * with it, and lives on the event row (`forge_watch_events.dispatched_at`) so
 * that "handed over but never acknowledged" is a question the database can
 * answer rather than a feeling.
 */
export interface AcknowledgementSink {
  acknowledge(runId: string, eventIds: string[], atMs: number): Promise<void>;
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
  onFinding?: FindingSink,
  onAcknowledge?: AcknowledgementSink,
): (job: Job<ForgeWatchMonitorJob>) => Promise<void> {
  return async (job) => {
    const data = job.data;
    if (!data || typeof data.runId !== "string" || data.schemaVersion !== 1) {
      // Malformed payload: dead-letter by throwing after attempts exhausted.
      throw new Error("invalid forge-watch monitor job payload");
    }
    const result = await fn(job);
    // A finding the processor detected has to reach the sink here, while the
    // run it belongs to is still in hand. Returning them on the result and
    // letting the caller persist them was the previous design, and the caller
    // discarded the result — so the detection died in the worker. The sink is
    // called from inside the processor, where the run id is known.
    if (onFinding && result.findings && result.findings.length > 0) {
      for (const finding of result.findings) {
        await onFinding.record({ ...finding, runId: data.runId });
      }
    }
    // The acknowledgement is the other half of delivery. The relay marking a
    // row dispatched says the event was HANDED OVER; this says the consumer
    // FINISHED with it. Only the pair makes "handed over but never
    // acknowledged" a question the database can answer.
    if (onAcknowledge) {
      const eventIds = (data.events ?? []).map((event) => event.eventId);
      if (eventIds.length > 0) {
        await onAcknowledge.acknowledge(data.runId, eventIds, Date.now());
      }
    }
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

  const findings: MonitorFinding[] = [];

  for (let i = 1; i < events.length; i += 1) {
    const previous = events[i - 1]!.sequence;
    const next = events[i]!.sequence;
    if (next <= previous) {
      findings.push({
        kind: "sequence-regression",
        detail: `sequence regression: previous ${previous}, observed ${next}`,
        sequence: next,
        expected: previous,
        observed: next,
      });
    } else if (next > previous + 1) {
      // `expected` carries the last contiguous sequence, not the one that was
      // missing. That is the convention the sequencer already writes into
      // `forge_watch_findings` (kind "gap", expected = previous, observed =
      // the sequence seen), and a table whose two kinds of gap disagree
      // about what "expected" means cannot be read.
      findings.push({
        kind: "gap",
        detail: `sequence gap: expected ${previous}, observed ${next}`,
        sequence: next,
        expected: previous,
        observed: next,
      });
    }
  }

  for (const event of events) {
    if (event.eventType === "egress.decision" && event.authorizationDecision === "denied") {
      findings.push({
        kind: "forbidden-egress",
        detail: `egress denied for event ${event.eventId}`,
        eventId: event.eventId,
        sequence: event.sequence,
      });
    }
    if (event.eventType === "tool.call.deny") {
      findings.push({
        kind: "forbidden-tool",
        detail: `tool call denied for event ${event.eventId}`,
        eventId: event.eventId,
        sequence: event.sequence,
      });
    }
    if (event.eventType === "test.modification") {
      findings.push({
        kind: "test-modification",
        detail: `test modification attempted by event ${event.eventId}`,
        eventId: event.eventId,
        sequence: event.sequence,
      });
    }
  }

  if (findings.length > 0) {
    // The log phrase is derived from the structured findings so the two can
    // never disagree about what was detected.
    return {
      ok: true,
      skipped: false,
      reason: findings.map(label).join(","),
      findings,
    };
  }
  return { ok: true, skipped: false, reason: "l0:passed" };
};

/**
 * The short phrase a finding is logged as.
 *
 * Kept byte-identical to the prose the processor produced before the findings
 * became structured, so an operator comparing a log across the change sees the
 * same words, and so the existing assertions on `reason` still describe the
 * behaviour rather than restating it.
 */
export function label(finding: MonitorFinding): string {
  switch (finding.kind) {
    case "sequence-regression":
      return `l0:sequence-regression:${finding.expected}->${finding.observed}`;
    case "gap":
      return `l0:sequence-gap:${finding.expected}->${finding.observed}`;
    case "forbidden-egress":
      return `l0:forbidden-egress:${finding.eventId}`;
    case "forbidden-tool":
      return `l0:forbidden-tool:${finding.eventId}`;
    case "test-modification":
      return `l0:test-modification:${finding.eventId}`;
    default:
      return `l0:${finding.kind}`;
  }
}

/**
 * Where a detected finding goes.
 *
 * The L0 processor detected telemetry-integrity problems and handed them back
 * as prose that only ever reached a log line. `forge_watch_findings` existed
 * and nothing wrote to it from the worker path, so the table was always
 * empty and a denied egress or a lost event was invisible to anything that
 * did not have the log. This is the sink that makes the detection a record.
 */
export interface FindingSink {
  /** Persist one finding. Rejecting must not fail the job: the finding is
   * already detected, and the alternative is losing the detection too. */
  record(finding: MonitorFinding & { runId: string }): Promise<void>;
}

/**
 * Where an exhausted job goes.
 *
 * The default is the Redis queue that used to be the whole mechanism. The
 * durable store is the better one — it survives the queue, and an operator can
 * replay from it — so the pipeline passes one in. Both are supported because
 * the queue is still the fast path for something that only needs to be seen
 * once.
 */
export interface DeadLetterSink {
  record(input: {
    source: string;
    jobId: string | null;
    jobName: string;
    payload: unknown;
    error: string;
    attempts: number;
  }): Promise<void>;
}

/**
 * The shape of the worker factory the registration uses.
 *
 * Injected so the production wiring — which processor is bound to which queue,
 * and whether the finding sink is actually handed to it — can be exercised
 * without a Redis server. A test that asserts on the wrapper function alone
 * proved the wrapper works; it did not prove the registration passes the
 * sink, and that skipped step is exactly where the finding was lost.
 */
export type WorkerFactory = (
  name: string,
  processor: (job: Job<ForgeWatchMonitorJob>) => Promise<void>,
  options?: Partial<WorkerOptions>,
) => Worker;

/** Register scaffold workers. Call from worker process startup when Redis is configured. */
export function registerForgeWatchWorkers(opts?: {
  l0?: MonitorProcessor;
  l1?: MonitorProcessor;
  l2?: MonitorProcessor;
  l3?: MonitorProcessor;
  /** Persist the findings a processor detected. */
  onFinding?: FindingSink;
  /** Record that the consumer finished with the events the job carried. */
  onAcknowledge?: AcknowledgementSink;
  /** Where an exhausted job is recorded. Defaults to the Redis DLQ queue. */
  onDeadLetter?: DeadLetterSink;
  /** Override how a worker is created. Tests pass a fake; production does not. */
  createWorker?: WorkerFactory;
}) {
  const workers = [];
  const make = opts?.createWorker ?? createWorker;
  const wopts = (concurrency: number) => ({ concurrency } as Partial<WorkerOptions>);
  workers.push(
    make(
      QUEUE_NAMES.FORGE_WATCH_L0,
      idempotentMonitorProcessor(opts?.l0 ?? l0Processor, opts?.onFinding, opts?.onAcknowledge),
      wopts(5),
    ),
  );
  if (opts?.l1) {
    workers.push(
      make(
        QUEUE_NAMES.FORGE_WATCH_L1,
        idempotentMonitorProcessor(opts.l1, opts?.onFinding, opts?.onAcknowledge),
        wopts(2),
      ),
    );
  }
  if (opts?.l2) {
    workers.push(
      make(
        QUEUE_NAMES.FORGE_WATCH_L2,
        idempotentMonitorProcessor(opts.l2, opts?.onFinding, opts?.onAcknowledge),
        wopts(1),
      ),
    );
  }
  if (opts?.l3) {
    workers.push(
      make(
        QUEUE_NAMES.FORGE_WATCH_L3,
        idempotentMonitorProcessor(opts.l3, opts?.onFinding, opts?.onAcknowledge),
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
      const message = err instanceof Error ? err.message : String(err);
      const deadLetter = opts?.onDeadLetter;
      if (deadLetter) {
        void deadLetter
          .record({
            source: "forge-watch",
            jobId: job.id ?? null,
            jobName: job.name,
            payload: job.data,
            error: message,
            attempts: job.attemptsMade,
          })
          .catch(() => {
            // The failure that brought us here is already logged by the worker; a
            // dead letter that cannot be written must not throw from a listener.
          });
        return;
      }
      void routeToDeadLetter("forge-watch", job, err).catch(() => {
        // The failure that brought us here is already logged by the worker; a
        // dead letter that cannot be written must not throw from a listener.
      });
    });
  }
  return workers;
}

export { FORGE_WATCH_JOB_DEFAULTS };
