import type { EventLike } from "./model.js";

/**
 * The v2 arena's read model, projected from `Arena.sol`'s logs.
 *
 * This is a second model, not a second transport: `scribe.ts` now takes its contract as a
 * `LogSource`, so the same sharded, bloom-checked, quiet-tail-proof reader serves both escrows and
 * the only thing that differs is the reducer.
 *
 * **Forward only, like the trials model.** Settlement is terminal on chain — `_settle` reverts
 * `AlreadySettled` — so a re-read `TrialClaimed` behind a `Settled` must not re-open the row. A
 * shard overlap or a reorg replays events out of order, and `applyArenaEvent` is public and
 * order-agnostic, so the guard lives here rather than in the caller.
 *
 * **Only the events this model understands are listed.** A log for an event not in
 * `ARENA_EVENT_NAMES` is never fetched, so the projection cannot silently lag behind a status it
 * did not recognise: the untracked events are named in `ARENA_UNTRACKED` beside the list.
 */
export type ArenaStatus = "open" | "claimed" | "submitted" | "docketed" | "panel" | "settled";

const STATUS_ORDER: Record<ArenaStatus, number> = {
  open: 0,
  claimed: 1,
  submitted: 2,
  docketed: 3,
  panel: 4,
  settled: 5,
};

export interface ArenaTrialRow {
  id: number;
  sponsor: string;
  rewardWei: bigint;
  feeWei: bigint;
  specDigest: string;
  skepticWindow: number;
  status: ArenaStatus;
  agent: string | null;
  bondWei: bigint;
  /** Unix seconds the agent has to submit, or 0 if unclaimed. */
  claimDeadline: number;
  runner: string | null;
  postedAtBlock: bigint;
}

export interface ArenaModel {
  trials: Map<number, ArenaTrialRow>;
  /** Bumped once per log that changed something, so a consumer can skip an unchanged tick. */
  version: number;
}

export function emptyArenaModel(): ArenaModel {
  return { trials: new Map(), version: 0 };
}

/** The events this reducer handles. Anything else is not fetched at all. */
export const ARENA_EVENT_NAMES = [
  "TrialPosted",
  "TrialClaimed",
  "RunnerSet",
  "RunSubmitted",
  "DocketFrozen",
  "PanelDrawn",
  "Settled",
] as const;

/**
 * Events the arena emits that this model deliberately does not project yet. Named rather than
 * omitted, so the gap is visible: `progress` on a row is a status, and these are the transitions
 * that do not move it (or that the demo never reaches).
 */
export const ARENA_UNTRACKED = [
  "Yielded",
  "ClaimTimedOut",
  "Cancelled",
  "Expired",
  "HoldoutRevealed",
  "HoldoutMissed",
  "BreakCommitted",
  "BreakRevealed",
  "VoteCommitted",
  "VoteRevealed",
  "SeatSlashed",
  "BreakTallied",
  "ExitRecorded",
  "Credited",
  "Withdrawn",
  "AttestorSet",
] as const;

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.length > 0) return Number(v);
  return 0;
}

function big(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string" && v.length > 0) return BigInt(v);
  return 0n;
}

function addr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.toLowerCase() : null;
}

function bytes32(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function advance(row: ArenaTrialRow, to: ArenaStatus): boolean {
  if (STATUS_ORDER[to] <= STATUS_ORDER[row.status]) return false;
  row.status = to;
  return true;
}

/**
 * Apply one log. Returns a NEW model and whether it changed, so the caller can decide whether to
 * bump a version or re-publish a snapshot.
 */
export function applyArenaEvent(model: ArenaModel, ev: EventLike): { model: ArenaModel; changed: boolean } {
  const trials = new Map(model.trials);
  const row = (id: number): ArenaTrialRow | undefined => {
    const existing = trials.get(id);
    if (!existing) return undefined;
    const copy = { ...existing };
    trials.set(id, copy);
    return copy;
  };

  let changed = false;
  const id = num(ev.args.id);

  switch (ev.eventName) {
    case "TrialPosted": {
      if (!trials.has(id)) {
        trials.set(id, {
          id,
          sponsor: addr(ev.args.sponsor) ?? "",
          rewardWei: big(ev.args.reward),
          feeWei: big(ev.args.fee),
          specDigest: bytes32(ev.args.specDigest),
          skepticWindow: num(ev.args.skepticWindow),
          status: "open",
          agent: null,
          bondWei: 0n,
          claimDeadline: 0,
          runner: null,
          postedAtBlock: ev.blockNumber,
        });
        changed = true;
      }
      break;
    }
    case "TrialClaimed": {
      const r = row(id);
      if (r) {
        // The agent is whoever the chain says claimed, on the first claim only. A re-read must not
        // rewrite the agent of a trial that has since settled.
        const next = addr(ev.args.agent);
        if (r.agent === null && next !== null) {
          r.agent = next;
          r.bondWei = big(ev.args.bond);
          r.claimDeadline = num(ev.args.claimDeadline);
          changed = true;
        }
        changed = advance(r, "claimed") || changed;
      }
      break;
    }
    case "RunnerSet": {
      const r = row(id);
      const next = addr(ev.args.runner);
      if (r && next !== null && r.runner !== next) {
        r.runner = next;
        changed = true;
      }
      break;
    }
    case "RunSubmitted": {
      const r = row(id);
      if (r) changed = advance(r, "submitted");
      break;
    }
    case "DocketFrozen": {
      const r = row(id);
      if (r) changed = advance(r, "docketed");
      break;
    }
    case "PanelDrawn": {
      const r = row(id);
      if (r) changed = advance(r, "panel");
      break;
    }
    case "Settled": {
      const r = row(id);
      if (r) changed = advance(r, "settled");
      break;
    }
    default:
      // Not in ARENA_EVENT_NAMES, so the transport never returns it. If one arrives anyway the
      // model says so by leaving `changed` false rather than by guessing.
      break;
  }

  return { model: changed ? { trials, version: model.version + 1 } : model, changed };
}

/** Replay a batch. Same contract as `model.replay`, so the two paths behave alike in a reorg. */
export function replayArena(events: readonly EventLike[], into: ArenaModel = emptyArenaModel()): ArenaModel {
  let model = into;
  for (const ev of events) model = applyArenaEvent(model, ev).model;
  return model;
}
