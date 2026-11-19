/**
 * @file dispatch.ts — Forge Watch monitor dispatch helpers (WFW-004).
 *
 * BullMQ is at-least-once: job IDs and processors must be idempotent. Financial
 * outcomes are never touched by monitor jobs (ADR-0025).
 */

export const FORGE_WATCH_QUEUE_NAMES = {
  L0: "forge-watch-l0",
  L1: "forge-watch-l1",
  L2: "forge-watch-l2",
  L3: "forge-watch-l3",
  DLQ: "forge-watch-dlq",
} as const;

export type ForgeWatchQueueLevel = keyof typeof FORGE_WATCH_QUEUE_NAMES;

/**
 * Make one part of a job id safe to use in a colon-separated id.
 *
 * BullMQ refuses a custom job id that contains a colon unless the id splits
 * into exactly three parts — a rule that exists for repeatable jobs and that
 * is easy to break by accident: an id with two parts is rejected outright,
 * and so is a three-part id whose first part itself contains a colon. Both
 * failures happen at `queue.add`, as a thrown error rather than a warning,
 * so an id that "looks fine" can still be undeliverable.
 *
 * A colon inside a part is therefore replaced rather than escaped. The ids
 * this file produces are `fw:<run>:<event>` and `fw:run:<run>:<phase>`, so
 * the shape BullMQ accepts is kept exactly, and a run id or event id that
 * carries a colon cannot turn a deliverable job into an undeliverable one.
 */
export function jobIdPart(value: string): string {
  return value.replace(/:/g, "_");
}

/** Idempotent job id for a single event dispatch. */
export function eventJobId(runId: string, eventId: string): string {
  return `fw:${jobIdPart(runId)}:${jobIdPart(eventId)}`;
}

/** Idempotent job id for a per-run batch/flush. */
export function runJobId(runId: string, phase: string): string {
  return `fw:run:${jobIdPart(runId)}:${jobIdPart(phase)}`;
}

/**
 * The idempotency key for one delivered event.
 *
 * No colons at all: BullMQ's rule about colon-bearing ids is a quirk of its
 * repeatable-job keys, and a delivery key has no business looking like one.
 * The key is what makes a redelivery after a crash the SAME job rather than
 * a second one, so it must be derived from the event and nothing else — no
 * timestamp, no attempt counter.
 */
export function deliveryJobId(eventId: string, phase: string): string {
  return `fw-${jobIdPart(eventId)}-${jobIdPart(phase)}`;
}

/**
 * The idempotency key for a replayed dead letter.
 *
 * The attempt count is part of it on purpose: a replay must be able to run
 * again after the original failed, so it cannot reuse the original key. Two
 * replays of the same attempt are the same key, so a double-click cannot
 * deliver twice.
 */
export function replayJobId(deadLetterId: number, attempts: number): string {
  return `dlq-${deadLetterId}-${attempts}`;
}

/**
 * The part of an event a monitor needs to make a deterministic judgement.
 * Carried in the job because the L0 worker has no store access; without it the
 * worker can only report pass.
 */
export interface MonitorEvent {
  eventId: string;
  sequence: number;
  eventType: string;
  source: string;
  authorizationDecision?: "allowed" | "denied" | "pending";
  toolId?: string;
  permission?: string;
}

export interface MonitorJobPayload {
  schemaVersion: 1;
  runId: string;
  trialId?: string;
  eventId?: string;
  eventIds?: string[];
  phase: "l0" | "l1" | "l2" | "l3" | "finding-flush";
  enqueuedAt: number;
  /** The events this job is meant to inspect, in producer order. */
  events?: MonitorEvent[];
}

export function monitorJob(
  payload: Omit<MonitorJobPayload, "schemaVersion" | "enqueuedAt">,
): MonitorJobPayload {
  return {
    schemaVersion: 1,
    enqueuedAt: Date.now(),
    ...payload,
  };
}

/**
 * A single-event L0 job carrying everything the worker needs to decide.
 */
export function monitorEventJob(
  runId: string,
  event: MonitorEvent,
  phase: MonitorJobPayload["phase"] = "l0",
): MonitorJobPayload {
  return monitorJob({
    runId,
    eventId: event.eventId,
    phase,
    events: [event],
  });
}
