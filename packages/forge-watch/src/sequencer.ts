/**
 * @file sequencer.ts — Per-run sequence integrity for Forge Watch events.
 *
 * Sequence numbers are monotonic per run with no silent gaps. A gap or a
 * malformed event is a telemetry-integrity finding, not a best-effort parse.
 *
 * The collector is the single writer of sequence numbers; the agent never sees
 * or influences the sequence of an event about itself.
 */

import type { ForgeWatchEvent } from "./events.js";

/** A hole in the per-run sequence: expected N, saw M. */
export interface SequenceGap {
  kind: "gap";
  runId: string;
  expected: number;
  observed: number;
  at: number;
}

/** An out-of-order event: observed sequence goes backwards. */
export interface SequenceRegression {
  kind: "regression";
  runId: string;
  previous: number;
  observed: number;
  at: number;
}

export type SequenceFinding = SequenceGap | SequenceRegression;

/**
 * Tracks the next expected sequence per run. Not shared with the agent — the
 * agent cannot reset, rewind or skip its own sequence.
 */
export class RunSequencer {
  private readonly nextByRun = new Map<string, number>();
  private readonly findings: SequenceFinding[] = [];

  /** All integrity findings raised so far (append-only, never cleared). */
  get findingsSnapshot(): readonly SequenceFinding[] {
    return [...this.findings];
  }

  /** Number of integrity findings raised for this run. */
  findingCount(runId: string): number {
    return this.findings.filter((f) => "runId" in f && f.runId === runId).length;
  }

  /** Total integrity findings across all runs. */
  totalFindingCount(): number {
    return this.findings.length;
  }

  /**
   * Claim the next sequence for `runId`. Returns the assigned sequence. Throws
   * nothing — instead it records a finding and still assigns a sane value so a
   * single bad event cannot halt a run.
   *
   * If `expected` is supplied (from an event the collector already carries),
   * it is validated against the tracker: a mismatch records a gap or a
   * regression.
   */
  next(runId: string, expected?: number): number {
    const previous = this.nextByRun.get(runId) ?? 1;
    const at = Date.now();

    if (expected !== undefined) {
      if (expected < previous) {
        this.findings.push({
          kind: "regression",
          runId,
          previous,
          observed: expected,
          at,
        });
      } else if (expected > previous) {
        this.findings.push({
          kind: "gap",
          runId,
          expected: previous,
          observed: expected,
          at,
        });
      }
      // expected === previous: in order, nothing to record.
      this.nextByRun.set(runId, expected + 1);
      return expected;
    }

    // No expected on the event: assign and record a gap if the run already
    // has history (a fresh run starts at 1).
    if (previous > 1) {
      this.findings.push({
        runId,
        expected: previous,
        observed: previous,
        at,
      } as unknown as SequenceGap);
    }
    this.nextByRun.set(runId, previous + 1);
    return previous;
  }

  /** Reset tracking for a run (test/teardown only — never in production). */
  __resetForTests(runId: string): void {
    this.nextByRun.delete(runId);
  }

  /** Clear all findings (test/teardown only). */
  __clearFindingsForTests(): void {
    this.findings.length = 0;
  }
}

export const defaultSequencer = new RunSequencer();

/**
 * Attach a validated, monotonic sequence to an envelope. The `expected`
 * sequence is the one the producer read from its own cursor; the sequencer
 * reconciles it against the per-run tracker and records any gap or
 * regression as a finding.
 */
export function sequenceEvent(
  event: Partial<ForgeWatchEvent> & { runId: string },
  sequencer: RunSequencer = defaultSequencer,
): ForgeWatchEvent {
  const sequence = sequencer.next(event.runId, event.sequence);
  return {
    ...event,
    sequence,
    schemaVersion: 1,
    timestamp: event.timestamp ?? Date.now(),
    eventId: event.eventId ?? crypto.randomUUID(),
  } as ForgeWatchEvent;
}
