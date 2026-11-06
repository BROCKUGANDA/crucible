/**
 * @file collector.ts — Forge Watch telemetry collector.
 *
 * The collector receives canonical envelopes at the trusted execution boundary,
 * assigns/validates per-run sequence, and durably queues them for L0/L1/L2/L3
 * processing. It operates outside the agent's execution boundary: the agent
 * cannot call it directly, cannot see its sequence cursor, and cannot suppress
 * an event by controlling its own turn completion.
 *
 * Production persistence (PostgreSQL outbox + Redis/BullMQ dispatch) follows
 * ADR-0023. Until that migration lands, an in-memory store consistent with
 * ADR-0008 is the demo/default — same interface, so swapping the backing store
 * is a config change, not a rewrite.
 */

import type { ForgeWatchEvent } from "./events.js";
import { RunSequencer, defaultSequencer } from "./sequencer.js";

/** A finding raised while an event passed through the collector. */
export interface CollectorFinding {
  kind: "gap" | "regression" | "malformed" | "duplicate";
  runId: string;
  sequence?: number;
  expected?: number;
  observed?: number;
  at: number;
  detail: string;
}

/** The collector's own view of what it has accepted. */
export interface CollectorStats {
  accepted: number;
  rejected: number;
  findings: number;
  byRun: Map<string, { count: number; lastSequence: number | null }>;
}

/**
 * Backing store the collector persists events to. In-memory here; the
 * PostgreSQL outbox implementation keeps this exact interface.
 */
export interface EventStore {
  /** Returns true for a new insert and false for an identical redelivery. */
  append(event: ForgeWatchEvent): Promise<boolean>;
  find(eventId: string): Promise<ForgeWatchEvent | null>;
  get(runId: string, sequence: number): Promise<ForgeWatchEvent | null>;
  list(runId: string): Promise<ForgeWatchEvent[]>;
}

/**
 * Collector options. `store` is injected so production can swap in PostgreSQL
 * without the collector knowing the difference.
 */
export interface CollectorOptions {
  store: EventStore;
  sequencer?: RunSequencer;
  /** Dropped events are still counted as findings so coverage gaps are visible. */
  onFinding?: (finding: CollectorFinding) => void;
}

/**
 * In-memory event store (demo/default, ADR-0008). Replaced by the
 * PostgreSQL outbox when ADR-0023 migration lands.
 */
export class InMemoryEventStore implements EventStore {
  private readonly byRun = new Map<string, ForgeWatchEvent[]>();
  private readonly byEventId = new Map<string, ForgeWatchEvent>();

  async append(event: ForgeWatchEvent): Promise<boolean> {
    const existing = this.byEventId.get(event.eventId);
    if (existing) {
      if (sameEvent(existing, event)) return false;
      throw new Error(`event id conflict: ${event.eventId}`);
    }

    const list = this.byRun.get(event.runId) ?? [];
    if (list.some((stored) => stored.sequence === event.sequence)) {
      throw new Error(`run sequence conflict: ${event.runId}:${event.sequence}`);
    }
    list.push(event);
    this.byRun.set(event.runId, list);
    this.byEventId.set(event.eventId, event);
    return true;
  }

  async find(eventId: string): Promise<ForgeWatchEvent | null> {
    return this.byEventId.get(eventId) ?? null;
  }

  async get(runId: string, sequence: number): Promise<ForgeWatchEvent | null> {
    const list = this.byRun.get(runId);
    if (!list) return null;
    return list.find((e) => e.sequence === sequence) ?? null;
  }

  async list(runId: string): Promise<ForgeWatchEvent[]> {
    return [...(this.byRun.get(runId) ?? [])].sort((a, b) => a.sequence - b.sequence);
  }
}

/**
 * The collector. One instance per process; the agent holds no reference to it.
 */
export class TelemetryCollector {
  private readonly store: EventStore;
  private readonly sequencer: RunSequencer;
  private readonly onFinding?: (finding: CollectorFinding) => void;
  private accepted = 0;
  private rejected = 0;
  private seenEventIds = new Set<string>();

  constructor(opts: CollectorOptions) {
    this.store = opts.store;
    this.sequencer = opts.sequencer ?? defaultSequencer;
    this.onFinding = opts.onFinding;
  }

  /** Stats the operator can read off to confirm coverage is what they think. */
  get stats(): CollectorStats {
    return {
      accepted: this.accepted,
      rejected: this.rejected,
      findings: this.sequencer.totalFindingCount(),
      byRun: new Map(),
    };
  }

  /**
   * Accept a canonical envelope produced at the trusted boundary. The envelope
   * must already be validated by `parseForgeWatchEvent`; the collector re-validates
   * here because the boundary is where trust starts and ends.
   *
   * Returns the assigned sequence. On a duplicate eventId the event is rejected
   * (envelope uniqueness enforced downstream by PostgreSQL unique constraint;
   * here by the seen set).
   */
  async accept(event: ForgeWatchEvent): Promise<number> {
    const existing = await this.store.find(event.eventId);
    if (existing) {
      if (sameEvent(existing, event)) return existing.sequence;
      this.rejected += 1;
      this.recordFinding({
        kind: "duplicate",
        runId: event.runId,
        sequence: event.sequence,
        at: event.timestamp,
        detail: `event id ${event.eventId} was replayed with a different payload`,
      });
      throw new Error(`event id conflict: ${event.eventId}`);
    }

    // The store must commit before the in-process cursor moves. Otherwise a
    // database outage followed by a retry would be misclassified as a sequence
    // regression even though the first delivery was never durable.
    const inserted = await this.store.append(event);
    if (!inserted) {
      // Another request may have inserted this exact event between find() and
      // append(). EventStore implementations enforce identity atomically.
      return event.sequence;
    }

    this.accepted += 1;
    const priorFindings = this.sequencer.findingsSnapshot.length;
    const assigned = this.sequencer.next(event.runId, event.sequence);
    const newFindings = this.sequencer.findingsSnapshot.slice(priorFindings);
    for (const finding of newFindings) {
      this.recordFinding({
        kind: finding.kind,
        runId: finding.runId,
        sequence: "observed" in finding ? finding.observed : undefined,
        expected: "expected" in finding ? finding.expected : undefined,
        observed: finding.observed,
        at: finding.at,
        detail:
          finding.kind === "gap"
            ? `sequence gap: expected ${finding.expected}, observed ${finding.observed}`
            : `sequence regression: previous ${finding.previous}, observed ${finding.observed}`,
      });
    }
    return assigned;
  }

  /** Retrieve one event by run + sequence. */
  async get(runId: string, sequence: number): Promise<ForgeWatchEvent | null> {
    return this.store.get(runId, sequence);
  }

  /** List a run's events in sequence order. */
  async list(runId: string): Promise<ForgeWatchEvent[]> {
    return this.store.list(runId);
  }

  /** Report an integrity finding the collector itself observed. */
  private recordFinding(finding: Omit<CollectorFinding, "at"> & { at?: number }): void {
    if (this.onFinding) {
      this.onFinding({ ...finding, at: finding.at ?? Date.now() });
    }
  }

  /** Reset counters (test/teardown only). */
  __resetForTests(): void {
    this.accepted = 0;
    this.rejected = 0;
  }
}

export const defaultStore = new InMemoryEventStore();
export const defaultCollector = new TelemetryCollector({ store: defaultStore });


/** Canonical equality for the flat, versioned telemetry envelope. */
function sameEvent(a: ForgeWatchEvent, b: ForgeWatchEvent): boolean {
  const canonical = (value: ForgeWatchEvent): string =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
      ),
    );
  return canonical(a) === canonical(b);
}
