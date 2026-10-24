import { hashCanonical } from "@crucible/crypto";
import { VERDICT } from "@crucible/smith";

import type { ChainLog } from "./events.js";
import { big, num, text, weiString } from "./events.js";
import type { MomentKind } from "./moments.js";
import { momentInfo, momentOf } from "./moments.js";

/**
 * The frame reducer.
 *
 * A trial's own logs, in chain order, folded into one frame per beat. Nothing here reads a
 * node, a clock or a model: the same logs produce the same frames on any machine, which is
 * what lets a stored commentary line prove later which frame it spoke about.
 *
 * Two rules inherited from the rest of this repository. Money is a decimal string and is
 * never recomputed when the chain emitted it — `payoutWei` is the `agentPayout` of
 * `VerdictFinalized`, the same reason `TrialRow.payoutWei` exists in the indexer. And a
 * number the logs do not carry is `null`, which the surface renders as an em dash, never as
 * zero.
 */

export type VerdictWord = "none" | "paid" | "slashed" | "refunded";

/** The numbers come from `@crucible/smith`, the one table the contract's tests are written
 *  against. Only the English is this package's. */
function verdictWord(raw: unknown): VerdictWord {
  switch (num(raw)) {
    case VERDICT.Paid:
      return "paid";
    case VERDICT.Slashed:
      return "slashed";
    case VERDICT.Refunded:
      return "refunded";
    default:
      return "none";
  }
}

export interface FrameBooks {
  rewardWei: string | null;
  bondWei: string | null;
  breakStakeWei: string | null;
  /** what the chain paid the agent, from the verdict log — not an arithmetic re-derivation */
  payoutWei: string | null;
  /** only when the chain settled a payout against a known reward; otherwise unknown */
  feeWei: string | null;
}

export interface Frame {
  index: number;
  moment: MomentKind;
  /** one plain line, no figures, no event names */
  what: string;
  source: { block: number; txHash: string; logIndex: number; event: string };
  /** the address that acted in this beat, as the log carried it */
  actor: string | null;
  books: FrameBooks;
  digests: { runHash: string | null; proofCID: string | null };
  panel: { committed: number; revealed: number; forBreak: number };
  verdict: VerdictWord | null;
  /** JCS + SHA-256 over this frame without this field, via the one crypto door (gate 625) */
  frameHash: string;
}

export interface Replay {
  trialId: number;
  frames: Frame[];
  /**
   * The log set holds no `TrialCreated`, so the index started after the trial was posted and
   * the early beats are gone. Reported, not hidden — the same honesty the indexer owes when
   * it meets a verdict for a trial it never saw.
   */
  incomplete: boolean;
  summary: {
    verdict: VerdictWord | null;
    rewardWei: string | null;
    payoutWei: string | null;
    feeWei: string | null;
    moments: Partial<Record<MomentKind, number>>;
    /** frames a commentary line is worth composing for */
    speakable: number;
  };
  /** the chain of frame hashes, so one number fingerprints the whole replay */
  replayHash: string;
}

const EVENT_WORDS: Record<string, string> = {
  TrialCreated: "The trial was posted.",
  TrialClaimed: "An agent took it.",
  RunSubmitted: "A run came in.",
  BreakFiled: "A skeptic filed a break.",
  DisputeOpened: "The dispute opened.",
  VoteCommitted: "A seat sealed its answer.",
  VoteRevealed: "A seat opened its answer.",
  VerdictFinalized: "The verdict was recorded.",
};

/** Chain order, then log order within the block. Not stable sort by arrival: a shard overlap
 *  arrives out of order and a replay that follows arrival renders the verdict before the run. */
export function orderLogs(logs: ChainLog[]): ChainLog[] {
  const seen = new Set<string>();
  const unique: ChainLog[] = [];
  for (const log of logs) {
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(log);
  }
  return unique.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
}

/**
 * Fold one trial's logs into frames.
 *
 * Logs for other trials are ignored rather than rejected: a caller that fetched by topic range
 * will see neighbours, and a reducer that threw on them would make the route's error path the
 * normal path.
 */
export function reduceReplay(trialId: number, logs: ChainLog[]): Replay {
  const books: FrameBooks = {
    rewardWei: null,
    bondWei: null,
    breakStakeWei: null,
    payoutWei: null,
    feeWei: null,
  };
  const digests = { runHash: null as string | null, proofCID: null as string | null };
  const panel = { committed: 0, revealed: 0, forBreak: 0 };
  const frames: Frame[] = [];
  let verdict: VerdictWord | null = null;
  let incomplete = true;

  for (const log of orderLogs(logs)) {
    if (num(log.args.id) !== trialId) continue;
    const moment = momentOf(log.eventName);
    if (moment === null) continue;
    const what = EVENT_WORDS[log.eventName] ?? "";

    switch (log.eventName) {
      case "TrialCreated":
        incomplete = false;
        books.rewardWei = weiString(log.args.reward);
        books.bondWei = weiString(log.args.bond);
        digests.runHash = null;
        break;
      case "TrialClaimed":
        books.bondWei = weiString(log.args.bond) ?? books.bondWei;
        break;
      case "RunSubmitted":
        digests.runHash = text(log.args.runHash);
        break;
      case "BreakFiled":
        books.breakStakeWei = weiString(log.args.stake);
        digests.proofCID = text(log.args.proofCID);
        break;
      case "VoteCommitted":
        panel.committed += 1;
        break;
      case "VoteRevealed":
        panel.revealed += 1;
        if (log.args.breakWins === true) panel.forBreak += 1;
        break;
      case "VerdictFinalized": {
        verdict = verdictWord(log.args.verdict);
        books.payoutWei = weiString(log.args.agentPayout);
        const reward = big(books.rewardWei);
        const payout = big(books.payoutWei);
        // The fee is the chain's own subtraction, and only meaningful when the agent was
        // paid. A slash pays nothing, so there is no fee to report — and printing 0 here
        // would say the house charged nothing when the question was never asked.
        books.feeWei = verdict === "paid" && reward !== null && payout !== null ? (reward - payout).toString() : null;
        break;
      }
      default:
        break;
    }

    const body = {
      index: frames.length,
      moment,
      what,
      source: {
        block: Number(log.blockNumber),
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        event: log.eventName,
      },
      actor: text(log.args.sponsor) ?? text(log.args.skeptic) ?? text(log.args.judge),
      books: { ...books },
      digests: { ...digests },
      panel: { ...panel },
      verdict,
    };
    frames.push({ ...body, frameHash: hashCanonical(body) });
  }

  const moments: Partial<Record<MomentKind, number>> = {};
  for (const frame of frames) moments[frame.moment] = (moments[frame.moment] ?? 0) + 1;

  return {
    trialId,
    frames,
    incomplete,
    summary: {
      verdict,
      rewardWei: books.rewardWei,
      payoutWei: books.payoutWei,
      feeWei: books.feeWei,
      moments,
      speakable: frames.filter((f) => momentInfo(f.moment).speakable).length,
    },
    replayHash: hashCanonical(frames.map((f) => f.frameHash)),
  };
}

/** The frames a commentator should speak, in order. */
export function speakableFrames(replay: Replay): Frame[] {
  return replay.frames.filter((frame) => momentInfo(frame.moment).speakable);
}
