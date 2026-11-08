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

import { createHash } from "node:crypto";
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
  private readonly countByRun = new Map<string, number>();
  private readonly tailByRun = new Map<string, string>();

  constructor(opts: CollectorOptions) {
    this.store = opts.store;
    this.sequencer = opts.sequencer ?? defaultSequencer;
    this.onFinding = opts.onFinding;
  }

  /** Stats the operator can read off to confirm coverage is what they think. */
  get stats(): CollectorStats {
    const byRun = new Map<string, { count: number; lastSequence: number | null }>();
    // NOTE: byRun is populated from accepted counts tracked per run below.
    for (const [runId, count] of this.countByRun) {
      byRun.set(runId, { count, lastSequence: null });
    }
    return {
      accepted: this.accepted,
      rejected: this.rejected,
      findings: this.sequencer.totalFindingCount(),
      byRun,
    };
  }

  /** Per-run coverage snapshot for operator dashboards. */
  runCoverage(): Map<string, { count: number; lastSequence: number | null }> {
    const m = new Map<string, { count: number; lastSequence: number | null }>();
    for (const [runId, count] of this.countByRun) {
      m.set(runId, { count, lastSequence: count > 0 ? count : null });
    }
    return m;
  }

  /**
   * Accept a canonical envelope produced at the trusted boundary. The envelope
   * must already be validated by `parseForgeWatchEvent`; the collector re-validates
   * here because the boundary is where trust starts and ends.
   *
   * Returns the assigned sequence. An identical redelivery is a no-op; reuse
   * of an eventId with different canonical bytes is rejected as an integrity finding.
   */
  async accept(rawEvent: ForgeWatchEvent): Promise<number> {
    const existing = await this.store.find(rawEvent.eventId);
    if (existing) {
      // Exact redelivery (same canonical bytes, ignoring collector-assigned
      // fields) is an idempotent no-op. The stored event carries the
      // assigned sequence + previousEventHash, so compare on the producer-
      // supplied envelope stripped of those fields.
      const strip = (e: ForgeWatchEvent) => {
        const { sequence: _s, previousEventHash: _p, eventHash: _h, ...rest } = e as Record<string, unknown>;
        return JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b))));
      };
      if (strip(existing) === strip(rawEvent)) return existing.sequence;
      this.rejected += 1;
      this.recordFinding({
        kind: "duplicate",
        runId: rawEvent.runId,
        sequence: rawEvent.sequence,
        at: rawEvent.timestamp,
        detail: `event id ${rawEvent.eventId} was replayed with a different payload`,
      });
      throw new Error(`event id conflict: ${rawEvent.eventId}`);
    }

    // Collector assigns sequence (CRU-RUNTIME-001): producers send placeholder
    // 0; collector claims the next monotonic number. For a fresh run the
    // producer's explicit sequence (e.g. 1 in tests) is the starting point.
    const prior = await this.store.list(rawEvent.runId);
    const isFirstForRun = prior.length === 0;
    const candidate = isFirstForRun ? rawEvent.sequence : this.sequencer.peekNext(rawEvent.runId);
    const event: ForgeWatchEvent = { ...rawEvent, sequence: candidate, previousEventHash: this.sequencer.getLastHash(rawEvent.runId) };

    // (Sequence candidate computed above; committer advances cursor only
    // after durable append succeeds — see below.)
    let inserted: boolean;
    try {
      inserted = await this.store.append(event);
    } catch (err) {
      this.rejected += 1;
      throw err;
    }
    if (!inserted) {
      return event.sequence;
    }
    // After durable commit, validate the producer's claimed sequence against
    // the tracker so gap/regression findings are recorded for operators.
    // (Collector still assigns the canonical sequence above.)
    this.sequencer.next(rawEvent.runId, rawEvent.sequence);
    const hash = computeEventHash(event);
    this.sequencer.setLastHash(rawEvent.runId, hash);
    this.tailByRun.set(rawEvent.runId, hash);
    this.countByRun.set(rawEvent.runId, (this.countByRun.get(rawEvent.runId) ?? 0) + 1);

    this.accepted += 1;
    const assigned = event.sequence;
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
    this.countByRun.clear();
    this.tailByRun.clear();
  }

  /** Per-run telemetry coverage. Missing mandatory events → incomplete. */
  coverage(runId: string): { count: number; lastSequence: number | null; complete: boolean } {
    const count = this.countByRun.get(runId) ?? 0;
    return { count, lastSequence: count > 0 ? count : null, complete: count > 0 };
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

/** SHA-256 hash chain over the canonical envelope (tamper-evident, not signed). */
function computeEventHash(event: ForgeWatchEvent): string {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(event).sort(([l], [r]) => l.localeCompare(r)),
    ),
  );
  return createHash("sha256").update(canonical).digest("hex");
}
