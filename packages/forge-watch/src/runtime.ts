/**
 * @file runtime.ts — Forge Watch runtime factory (WFW-004 wiring helper).
 *
 * Creates a telemetry collector with the appropriate backing store and returns
 * an `emitEvent` hook suitable for ForgeRunner and createForgedAgent. When a PG
 * executor is provided and persistence is enabled, events go to the outbox table
 * and integrity findings can be flushed to forge_watch_findings.
 *
 * Migrations remain the host's responsibility (run via agent-security/database
 * runMigrations before starting workers) — this module never opens connections.
 */

import {
  InMemoryEventStore,
  TelemetryCollector,
  type CollectorFinding,
  type EventStore,
} from "./collector.js";
import { parseForgeWatchEvent, type ForgeWatchEvent } from "./events.js";
import { createPgEventStore, type PgExecutor } from "./pg-store.js";
import { RunSequencer } from "./sequencer.js";

export interface ForgeWatchRuntimeOptions {
  /**
   * Enable PG persistence. When unset, a provided `pgExecutor` means durable
   * (the host already wired the database — asking for a second opt-in on top is
   * how telemetry ends up in memory beside an unused database);
   * `FORGE_WATCH_PERSIST=false` is the explicit demo opt-out, and
   * `FORGE_WATCH_PERSIST=true` forces it without an executor, which throws.
   */
  persist?: boolean;
  /** Required when persistence is enabled. */
  pgExecutor?: PgExecutor;
  /** Called for collector-level findings (duplicates, etc.). */
  onFinding?: (finding: CollectorFinding) => void;
  /** Use a dedicated sequencer (tests); defaults to a new instance. */
  sequencer?: RunSequencer;
}

export interface ForgeWatchRuntime {
  store: EventStore;
  collector: TelemetryCollector;
  sequencer: RunSequencer;
  /** Compatible with ForgeRunner.emitEvent and createForgedAgent.emitEvent. */
  emitEvent(event: ForgeWatchEvent): Promise<void>;
  /** Persist sequencer integrity findings to PG (no-op without PG store). */
  flushFindings(runId?: string): Promise<number>;
  /** In-memory stats/cleanup helper. */
  close(): Promise<void>;
}

export function isForgeWatchPersistEnabled(): boolean {
  return process.env.FORGE_WATCH_PERSIST === "true";
}

/** Resolve persistence: explicit option, then explicit demo opt-out, then the executor. */
function resolvePersist(opts: ForgeWatchRuntimeOptions): boolean {
  if (opts.persist !== undefined) return opts.persist;
  if (process.env.FORGE_WATCH_PERSIST === "false") return false;
  if (opts.pgExecutor) return true;
  return isForgeWatchPersistEnabled();
}

export function createForgeWatchRuntime(
  opts: ForgeWatchRuntimeOptions = {},
): ForgeWatchRuntime {
  const persist = resolvePersist(opts);
  const sequencer = opts.sequencer ?? new RunSequencer();
  let pgStore: ReturnType<typeof createPgEventStore> | null = null;

  let store: EventStore;
  if (persist) {
    if (!opts.pgExecutor) {
      throw new Error(
        "Forge Watch persistence enabled but no pgExecutor provided",
      );
    }
    pgStore = createPgEventStore(opts.pgExecutor);
    store = pgStore;
  } else {
    if (opts.persist === undefined && process.env.FORGE_WATCH_PERSIST !== "false") {
      // A silent in-memory fallback is how a deployment reports monitoring while
      // keeping none of it. Say so unless the host opted out explicitly.
      console.warn(
        "[forge-watch] no pgExecutor — telemetry is in-memory and not durable (FORGE_WATCH_PERSIST=false silences this in a demo)",
      );
    }
    store = new InMemoryEventStore();
  }

  const collector = new TelemetryCollector({
    store,
    sequencer,
    onFinding: opts.onFinding,
  });

  async function emitEvent(event: ForgeWatchEvent): Promise<void> {
    // Validate at the boundary: a malformed event is a telemetry-integrity issue,
    // not a reason to crash the run. The runner/agent already wrap in try/catch.
    const parsed = parseForgeWatchEvent(event);
    await collector.accept(parsed);
  }

  async function flushFindings(runId?: string): Promise<number> {
    if (!pgStore) return 0;
    const findings = sequencer.findingsSnapshot.filter(
      (f) => !runId || f.runId === runId,
    );
    let n = 0;
    for (const f of findings) {
      await pgStore.insertFinding({
        findingId: `${f.kind}:${f.runId}:${"expected" in f ? f.expected : ""}:${f.observed}:${f.at}`,
        runId: f.runId,
        kind: f.kind,
        sequence: "observed" in f ? f.observed : undefined,
        expected: "expected" in f ? f.expected : undefined,
        observed: f.observed,
        detail:
          f.kind === "gap"
            ? `sequence gap: expected ${f.expected}, observed ${f.observed}`
            : `sequence regression: previous ${f.previous}, observed ${f.observed}`,
        atMs: f.at,
      });
      n += 1;
    }
    return n;
  }

  async function close(): Promise<void> {
    // In-memory stores need no teardown; PG connections are owned by the host.
  }

  return { store, collector, sequencer, emitEvent, flushFindings, close };
}
