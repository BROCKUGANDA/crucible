/**
 * The replay's view model.
 *
 * Frames arrive as chain facts; a page needs a rail, a money flow, and a decision about when
 * Frenchy is allowed to interrupt. That translation lives here, pure, so the components under
 * `components/replay` hold no rules and nothing in the page has to be re-derived to be tested.
 *
 * Two deliberate silences. There is no running escrow total: `VerdictFinalized` carries only the
 * agent's payout, so where a slash sends the reward and the break stake is not in the logs, and a
 * total assembled from what is here would be arithmetic nobody sourced. And the settlement row
 * says "credited for withdrawal", because settlement never sends ETH (ADR-0003) — a reader who is
 * told money was pushed will look for a transfer that was never made.
 */

import { momentInfo } from "@crucible/frame/moments";
import type { Frame, Replay } from "@crucible/frame";
import type { FrenchyTrigger } from "../frenchy/selector";

export interface RailRow {
  n: number;
  moment: Frame["moment"];
  /** the beat's plain line, from the moment detector */
  label: string;
  /** what this log changed, from the frame */
  what: string;
  block: number;
  txHash: string;
  /** the frame's own hash — the id a stored caption points at */
  frameHash: string;
  /** a wallet address the log named, or null */
  actor: string | null;
  /** null means this beat is not one Frenchy has a pool for, or is not worth interrupting for */
  trigger: FrenchyTrigger | null;
  speakable: boolean;
}

export interface FlowRow {
  n: number;
  moment: Frame["moment"];
  /** plain words for the movement: what went in, what came out */
  movement: string;
  direction: "in" | "out";
  /** wei as a decimal string, or null when the beat moved nothing */
  movedWei: string | null;
  /** who is accountable for the movement, as the log named them */
  who: string | null;
  /** the hash the movement is proved by, when the beat carries one */
  digest: string | null;
}

/**
 * Which of Frenchy's existing pools a beat belongs to (gates 668-677).
 *
 * The trigger vocabulary is Frenchy's, not invented here — a replay that coined its own triggers
 * would need pools that do not exist. `submitted` has no pool and gets no quip; the run arriving
 * is the least surprising beat in a trial.
 */
export function triggerFor(frame: Frame): FrenchyTrigger | null {
  switch (frame.moment) {
    case "posted":
      return "escrow_opened";
    case "claimed":
      return "work_posted";
    case "broken":
    case "disputed":
      return "dispute_opened";
    case "settled":
      if (frame.verdict === "paid") return "verdict_pass";
      if (frame.verdict === "slashed" || frame.verdict === "refunded") return "verdict_fail";
      return null;
    default:
      return null;
  }
}

export function railRows(replay: Replay): RailRow[] {
  return replay.frames.map((frame) => ({
    n: frame.index,
    moment: frame.moment,
    label: momentInfo(frame.moment).label,
    what: frame.what,
    block: frame.source.block,
    txHash: frame.source.txHash,
    frameHash: frame.frameHash,
    actor: frame.actor,
    trigger: triggerFor(frame),
    speakable: momentInfo(frame.moment).speakable,
  }));
}

/**
 * Only the beats that moved something. A skeptic's break escrows a stake; a vote seals a hash
 * and moves nothing — listing it would say "no money here" forty times.
 */
export function flowRows(replay: Replay): FlowRow[] {
  const rows: FlowRow[] = [];
  for (const frame of replay.frames) {
    const { rewardWei, bondWei, breakStakeWei, payoutWei } = frame.books;
    switch (frame.moment) {
      case "posted":
        rows.push({
          n: frame.index,
          moment: "posted",
          movement: "Prize put into escrow by the sponsor",
          direction: "in",
          movedWei: rewardWei,
          who: frame.actor,
          digest: null,
        });
        break;
      case "claimed":
        rows.push({
          n: frame.index,
          moment: "claimed",
          movement: "Bond taken from the agent's stake into escrow",
          direction: "in",
          movedWei: bondWei,
          // the claim log names no sponsor and the agent id is not an address; who is already
          // on the rail for this beat, so the flow does not reach for a name it does not have
          who: null,
          digest: null,
        });
        break;
      case "broken":
        rows.push({
          n: frame.index,
          moment: "broken",
          movement: "Stake a skeptic paid for the chance to break the claim",
          direction: "in",
          movedWei: breakStakeWei,
          who: frame.actor,
          digest: frame.digests.proofCID,
        });
        break;
      case "settled":
        rows.push({
          n: frame.index,
          moment: "settled",
          // A credit on the pull ledger, not a payment. `withdraw()` is the separate act.
          movement: "Credited to the agent for withdrawal",
          direction: "out",
          movedWei: payoutWei,
          who: null,
          digest: null,
        });
        break;
      default:
        break;
    }
  }
  return rows;
}

/**
 * The em-dash rule, applied once so a component cannot render a null as `0`. Zero is a
 * measurement; nothing is not.
 */
export function orDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : value;
}
