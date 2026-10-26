import { applyEventInto, emptyModel, hasAppliedLog, type EventLike, type ReadModel } from "./model.js";
import { canonicalJson, digestOf } from "./canonical.js";
import { buildSnapshot, snapshotSignature, type AlloyState } from "./api.js";

/**
 * Two projections of one chain, and the rule that makes them comparable.
 *
 * The chain is the sequencer: every indexer is a stateless consumer of one ordered event stream, so
 * N of them running side by side must converge on the identical read model. The property that makes
 * a *second* one possible at all is that replaying a log cannot change a state that log already
 * produced. Both are assertable with what already existed — no database, no queue, no new service
 * (ADR-0008 and ADR-0006 stand).
 *
 * What lives here:
 *
 *  - `compareSequence` / `canonicalOrder` — the one statement of "the chain's order". `scribe.ts`
 *    merges its shards with it and every replica below reorders with it, so the rule has one home.
 *  - `Replica` — one projection with a cursor: reorders the batch it is handed, dedupes through the
 *    fold's own ledger, refuses anything that has fallen behind it.
 *  - `compareViews` / `assertConverged` — the disagreement check. It reports; it never picks.
 */

/** A position in the chain's own sequence. */
export interface SequencePoint {
  blockNumber: bigint;
  logIndex: number;
}

/**
 * Block height first, log index second, transaction hash last.
 *
 * Among logs a node really returned this is a total order — `logIndex` is unique within a block, so
 * the first two keys settle every pair. The hash tie-break only ever fires on an input that claims
 * two logs at one position, which no chain produces: there the choice is between arrival order,
 * which two replicas cannot agree on, and a deterministic comparison of the bytes that are there.
 * The hash wins because it is the same on every machine.
 */
export function compareSequence(a: EventLike, b: EventLike): number {
  if (a.blockNumber < b.blockNumber) return -1;
  if (a.blockNumber > b.blockNumber) return 1;
  if (a.logIndex !== b.logIndex) return a.logIndex - b.logIndex;
  return a.transactionHash < b.transactionHash ? -1 : a.transactionHash > b.transactionHash ? 1 : 0;
}

/** `events` in chain order. Returns a copy — the caller's array is never rearranged. */
export function canonicalOrder(events: readonly EventLike[]): EventLike[] {
  return [...events].sort(compareSequence);
}

function pointOf(ev: EventLike): SequencePoint {
  return { blockNumber: ev.blockNumber, logIndex: ev.logIndex };
}

function isBefore(a: SequencePoint, b: SequencePoint): boolean {
  return a.blockNumber < b.blockNumber || (a.blockNumber === b.blockNumber && a.logIndex < b.logIndex);
}

/** Why a delivery was not folded. One reason today, named anyway, so a second one is an addition. */
export type RefusalReason = "below-cursor";

export interface Refusal {
  readonly reason: RefusalReason;
  readonly event: EventLike;
  /** The cursor the event fell behind, at the moment of the refusal. */
  readonly cursor: SequencePoint;
}

/** What one `deliver` did, counted rather than remembered. */
export interface Delivery {
  /** Events handed to this call. */
  readonly delivered: number;
  /** Events folded into the projection. */
  readonly folded: number;
  /** Events this projection had already folded — a re-read range, an overlapping shard boundary. */
  readonly duplicates: number;
  /** Events refused because they had fallen behind the cursor. */
  readonly refusals: readonly Refusal[];
  /** The projection's version after the batch. */
  readonly version: number;
}

/** The snapshot options a replica signs. `now` defaults to 0 so a view is a function of the model alone. */
export interface ReplicaSnapshotOptions {
  now?: number;
  feeBps?: number | null;
  headTimestamp?: number | null;
  alloyState?: (agentId: number) => AlloyState;
  disclosure?: { trialId: number; specCID?: string; testsCID?: string }[];
}

/**
 * Everything a second projection of the same chain can be asked about.
 *
 * `state` is the canonical serialisation and `digest` its keccak — the pair a reconciliation needs,
 * because a digest says *whether* two replicas agree and only the bytes say *where*. `signature` is
 * the SSE frame gate: two replicas disagreeing about it means subscribers get a duplicate frame or
 * miss one. It is `null` for a projection with no stream surface (the arena model), rather than an
 * invented string that would always agree.
 */
export interface ReplicaView {
  readonly name: string;
  readonly version: number;
  readonly digest: string;
  readonly state: string;
  readonly signature: string | null;
}

/** The view of any projection: its canonical bytes and its version. */
export function projectionView(name: string, model: { version: number }): ReplicaView {
  const state = canonicalJson(model);
  return { name, version: model.version, digest: digestOf(state), state, signature: null };
}

/** The view of the trials projection, including the signature its subscribers compare. */
export function replicaView(
  name: string,
  model: ReadModel,
  opts: ReplicaSnapshotOptions = {},
): ReplicaView {
  const snapshot = buildSnapshot(model, { ...opts, now: opts.now ?? 0 });
  return { ...projectionView(name, model), signature: snapshotSignature(snapshot) };
}

export interface ReplicaOptions {
  /** Names this projection in a divergence report. Two replicas called "a" are one replica. */
  readonly name: string;
  /**
   * Called for every refused event, and for nothing else.
   *
   * A refusal is operator-visible: it means the transport handed this replica a log from behind its
   * cursor, which is either a reorg (and the answer is a rebuild, per ADR-0010) or a bug. Silence is
   * how the first one becomes a stale read model nobody noticed.
   */
  onRefusal?: (refusal: Refusal) => void;
}

export interface Replica {
  readonly name: string;
  /** The projection. `deliver` is the only writer. */
  readonly model: ReadModel;
  /** The highest position folded so far, or null while nothing has been. */
  readonly cursor: SequencePoint | null;
  readonly totals: { delivered: number; folded: number; duplicates: number; refusals: number };
  /** Reorders, dedupes, folds, and refuses whatever has fallen behind the cursor. */
  deliver(events: readonly EventLike[]): Delivery;
  view(opts?: ReplicaSnapshotOptions): ReplicaView;
}

/**
 * One stateless consumer of the ordered event stream.
 *
 * The out-of-order policy, stated once: **reorder within a batch, refuse across batches.**
 *
 * A batch is a window of the chain, so its internal order is an artifact of how the transport merged
 * its shards, and sorting recovers the fact. A batch that *starts* below the cursor is not an
 * ordering accident: this projection has already folded past that point, and folding backwards into
 * a live model joins a past prefix to a future one — a state the chain never had, which is the one
 * thing a read model is not allowed to report. On a reorg the cursor goes backwards too (the Scribe
 * resets the model and rebuilds from `fromBlock`, ADR-0010), so a rewind is a rebuild, never a fold.
 */
export function createReplica(config: ReplicaOptions): Replica {
  const model = emptyModel();
  const totals = { delivered: 0, folded: 0, duplicates: 0, refusals: 0 };
  let cursor: SequencePoint | null = null;

  return {
    name: config.name,
    get model() {
      return model;
    },
    get cursor() {
      return cursor;
    },
    get totals() {
      return { ...totals };
    },
    deliver(events: readonly EventLike[]): Delivery {
      const ordered = canonicalOrder(events);
      const refusals: Refusal[] = [];
      let folded = 0;
      let duplicates = 0;

      for (const ev of ordered) {
        // Identity before position: re-reading a range the cursor stopped in front of is routine and
        // is not a refusal. `hasAppliedLog` asks the projection's own ledger instead of keeping a
        // second one here, so the answer is the same one the fold is about to reach.
        if (hasAppliedLog(model, ev)) {
          duplicates += 1;
          continue;
        }
        if (cursor !== null && isBefore(pointOf(ev), cursor)) {
          const refusal: Refusal = { reason: "below-cursor", event: ev, cursor };
          refusals.push(refusal);
          totals.refusals += 1;
          config.onRefusal?.(refusal);
          continue;
        }
        applyEventInto(model, ev);
        folded += 1;
        const at = pointOf(ev);
        if (cursor === null || isBefore(cursor, at)) cursor = at;
      }

      totals.delivered += ordered.length;
      totals.folded += folded;
      totals.duplicates += duplicates;
      return { delivered: ordered.length, folded, duplicates, refusals, version: model.version };
    },
    view(opts: ReplicaSnapshotOptions = {}) {
      return replicaView(config.name, model, opts);
    },
  };
}

/**
 * Every way these projections disagree, as sentences. Empty means agreement.
 *
 * Fewer than two projections is *not* agreement: it is a claim that was never tested, and a check
 * that reports success for a single replica would report success for zero traffic forever.
 * Comparison is against the first view, and every difference is reported rather than only the first
 * — an operator needs to know which replica drifted and how far, not just that one of them did.
 */
export function compareViews(views: readonly ReplicaView[]): string[] {
  if (views.length < 2) {
    return [
      views.length === 0
        ? "no projections were given, so nothing was compared"
        : "one projection was given: convergence is a claim about two or more",
    ];
  }

  const baseline = views[0]!;
  const differences: string[] = [];

  for (const other of views.slice(1)) {
    if (other.version !== baseline.version) {
      differences.push(
        `replica "${other.name}" is at version ${other.version}, "${baseline.name}" is at ${baseline.version}`,
      );
    }
    if (other.digest !== baseline.digest) {
      differences.push(
        `replica "${other.name}" reads the chain differently from "${baseline.name}": ${describeDiff(baseline, other)}`,
      );
    }
    if (baseline.signature !== null && other.signature !== null) {
      if (other.signature !== baseline.signature) {
        differences.push(
          `replica "${other.name}" publishes SSE signature "${other.signature}" where "${baseline.name}" publishes "${baseline.signature}" — subscribers get a duplicate frame or miss one`,
        );
      }
    } else if (baseline.signature !== other.signature) {
      differences.push(
        `replica "${other.name}" ${other.signature === null ? "exposes no SSE signature" : "exposes an SSE signature"} while "${baseline.name}" ${baseline.signature === null ? "exposes none" : "exposes one"} — the two are not the same surface, so their frames cannot be compared`,
      );
    }
  }
  return differences;
}

/** The first byte where two canonical forms part company, with enough context to find the field. */
function describeDiff(a: ReplicaView, b: ReplicaView): string {
  const limit = Math.min(a.state.length, b.state.length);
  let i = 0;
  while (i < limit && a.state[i] === b.state[i]) i += 1;

  if (i === limit) {
    if (a.state.length === b.state.length) return "the digests differ but every byte matches, which cannot happen";
    const longer = a.state.length > b.state.length ? a : b;
    const shorter = a.state.length > b.state.length ? b : a;
    return `"${shorter.name}" ends at ${shorter.state.length} bytes inside "${longer.name}"'s ${longer.state.length}: …${shorter.state.slice(Math.max(0, limit - 40))}…`;
  }
  return (
    `at byte ${i}: "${a.name}" holds …${a.state.slice(Math.max(0, i - 40), i + 40)}… and ` +
    `"${b.name}" holds …${b.state.slice(Math.max(0, i - 40), i + 40)}…`
  );
}

/** The error `assertConverged` throws, carrying the report rather than only a sentence. */
export class ReplicaDivergenceError extends Error {
  readonly differences: readonly string[];
  readonly views: readonly ReplicaView[];

  constructor(views: readonly ReplicaView[], differences: readonly string[]) {
    super(`replicas diverged: ${differences.join("; ")}`);
    this.name = "ReplicaDivergenceError";
    this.differences = differences;
    this.views = views;
  }
}

/**
 * Throws unless every projection agrees on every byte.
 *
 * The one call a host makes with its replicas, or the one a gate makes over the fold paths it just
 * ran. It never picks a winner: "answer with whichever replica replied first" is precisely the
 * failure this exists to make loud, because the two answers differing is the finding.
 */
export function assertConverged(views: readonly ReplicaView[]): void {
  const differences = compareViews(views);
  if (differences.length > 0) throw new ReplicaDivergenceError(views, differences);
}

/**
 * The answer a host may serve, or a failure.
 *
 * A host with N replicas calls this rather than indexing its own array. Returning `views[0]` when
 * the replicas disagree is how an active-active pair ends up serving whichever replied first, and a
 * reader cannot tell — the payload looks identical and one of them is wrong. Agreement is not a vote
 * either: every view must match the first on every byte, so what comes back is the chain's answer
 * rather than one process's.
 */
export function agreedView(views: readonly ReplicaView[]): ReplicaView {
  assertConverged(views);
  return views[0]!;
}
