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

/** Idempotent job id for a single event dispatch. */
export function eventJobId(runId: string, eventId: string): string {
  return `fw:${runId}:${eventId}`;
}

/** Idempotent job id for a per-run batch/flush. */
export function runJobId(runId: string, phase: string): string {
  return `fw:run:${runId}:${phase}`;
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
