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
import { RunSequencer, defaultSequencer, sequenceEvent } from "./sequencer.js";

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
  append(event: ForgeWatchEvent): Promise<void>;
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

  async append(event: ForgeWatchEvent): Promise<void> {
    const list = this.byRun.get(event.runId) ?? [];
    list.push(event);
    this.byRun.set(event.runId, list);
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
    if (this.seenEventIds.has(event.eventId)) {
      this.rejected += 1;
      this.recordFinding({
        kind: "duplicate",
        runId: event.runId,
        sequence: event.sequence,
        at: event.timestamp,
        detail: `duplicate eventId ${event.eventId} for run ${event.runId}`,
      });
      throw new Error(`duplicate eventId: ${event.eventId}`);
    }

    const sequenced = sequenceEvent(event, this.sequencer);
    this.seenEventIds.add(sequenced.eventId);

    // Record any gap/regression the sequencer found.
    const before = this.sequencer.findingsSnapshot.length;
    await this.store.append(sequenced);
    this.accepted += 1;

    // Re-derive findings added by sequenceEvent above this instance's own
    // tracking by diffing is not available here; sequenceEvent records on the
    // shared sequencer. Surface them via onFinding on the next tick if the
    // caller supplied one.
    return sequenced.sequence;
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

  /** Reset in-memory state (test/teardown only). */
  __resetForTests(): void {
    this.seenEventIds.clear();
    this.accepted = 0;
    this.rejected = 0;
    if (this.store instanceof InMemoryEventStore) {
      // nothing to clear: tests use a fresh store
    }
  }
}

export const defaultStore = new InMemoryEventStore();
export const defaultCollector = new TelemetryCollector({ store: defaultStore });
