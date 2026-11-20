/**
 * @file review-queue.ts — the cases waiting for a reviewer.
 *
 * Three things are true about a review, and this module keeps them apart:
 *
 *  1. **The case** is a fact the chain holds: a trial that is open for
 *     review, with its sponsor, its agent and what it committed to. The
 *     indexer re-reads it, so the queue is not a memory.
 *  2. **The reviewer's state** — who holds the case, who stepped away —
 *     is durable (ADR-0039's store).
 *  3. **The conflict** is a DECLARED FACT in its own register
 *     (ADR-0038), and it is the one thing that can bar a reviewer from a
 *     case entirely.
 *
 * The rule: a reviewer with a recorded conflict is NOT offered a case
 * involving the party they are conflicted with. Not warned about it —
 * refused. A warning is advice; a conflict that is merely displayed is a
 * conflict that a reviewer in a hurry can ignore, and the review would
 * then carry a conflict nobody was told about at the moment it mattered.
 */

import type { ReadModel, TrialRow } from "@crucible/indexer";
import { currentReviewStore } from "./review-store.js";
import {
  conflictsBetween,
  conflictsWithOrg,
  listCOIForPrincipal,
  type COIEntry,
} from "@crucible/agent-security";

/**
 * Every conflict a reviewer has with a trial's sponsor.
 *
 * Two questions, because a sponsor is not a principal in the register:
 * does the reviewer share an interest with the sponsor (both declared), and
 * has the reviewer declared an interest IN the sponsor (the reviewer's own
 * declaration names it)?
 */
export async function conflictsFor(reviewer: string, sponsor: string): Promise<COIEntry[]> {
  const sponsorAddress = sponsor.toLowerCase();
  const shared = await conflictsBetween(reviewer, sponsorAddress);
  const about = await conflictsWithOrg(reviewer, sponsorAddress);
  const seen = new Set(shared.map((entry) => entry.id));
  return [...shared, ...about.filter((entry) => !seen.has(entry.id))];
}

/** A case in the queue, as the queue shows it. */
export interface ReviewCase {
  trialId: number;
  /** The sponsor of the trial — the party a reviewer may be conflicted with. */
  sponsor: string;
  /** The agent that was evaluated, when the chain names one. */
  agent: string | null;
  status: string;
  /** The spec the trial committed to. */
  specDigest: string;
  /** The reward on offer, in wei. BigInt is never a float. */
  rewardWei: bigint;
  /** The chain's own deadline, in seconds. */
  deadline: number;
  /** Whether the sponsor has disclosed the suite. */
  disclosed: boolean;
  /** The reviewer's own state on this case. */
  state: ReviewerState;
}

export type ReviewerState =
  | { kind: "open" }
  | { kind: "yours"; claimedAt: number }
  | { kind: "held"; by: string; claimedAt: number }
  | { kind: "abstained"; reason: string; at: number };

/**
 * The cases that are open for review.
 *
 * The chain's own status decides it: a trial is `judging` while its
 * work is being judged and `challenged` while a dispute against it is
 * live. Those are the windows in which the evidence exists and nobody has
 * settled it.
 *
 * NOT `disputeOpenedAt`: that flag says a dispute was opened at some
 * point, and it stays set after the trial settles. Reading it as "the
 * dispute is still open" would put every settled trial that was ever
 * disputed back on the queue — a question the chain has already
 * answered, offered for review.
 */
export function openCases(model: ReadModel): TrialRow[] {
  const rows = [...model.trials.values()];
  return rows.filter((trial) => isOpenCase(trial)).sort((a, b) => a.id - b.id);
}

/** Is this trial's work still open for review? */
export function isOpenCase(trial: TrialRow): boolean {
  return trial.status === "judging" || trial.status === "challenged";
}

/**
 * The reviewer's state on ONE case, given everything the platform knows.
 *
 * The conflict check comes FIRST: a reviewer with a recorded conflict is
 * not offered the case at all, whatever the claim state says.
 */
export async function reviewerStateFor(
  model: ReadModel,
  trialId: number,
  reviewer: string,
): Promise<{ state: ReviewerState; conflicts: COIEntry[] }> {
  const trial = model.trials.get(trialId);
  const conflicts = trial ? await conflictsFor(reviewer, trial.sponsor) : [];
  if (conflicts.length > 0) {
    return { state: { kind: "open" }, conflicts };
  }

  const store = currentReviewStore();
  const abstentions = await store.listAbstentions();
  const abstention = abstentions.find(
    (entry) => entry.trialId === trialId && entry.reviewer === reviewer,
  );
  if (abstention) {
    return {
      state: { kind: "abstained", reason: abstention.reason, at: abstention.abstainedAt },
      conflicts,
    };
  }

  const claim = await store.getClaim(trialId);
  if (claim) {
    return {
      state:
        claim.reviewer === reviewer
          ? { kind: "yours", claimedAt: claim.claimedAt }
          : { kind: "held", by: claim.reviewer, claimedAt: claim.claimedAt },
      conflicts,
    };
  }

  return { state: { kind: "open" }, conflicts };
}

/**
 * Why a reviewer may not take a case.
 *
 * Returns null when they may. The reasons are concrete and each names
 * the fact it is based on — a warning would be advice, and advice is
 * what a reviewer in a hurry ignores.
 */
export async function refusalFor(
  model: ReadModel,
  trialId: number,
  reviewer: string,
): Promise<{ code: string; reason: string } | null> {
  const trial = model.trials.get(trialId);
  if (!trial) {
    return { code: "no-such-case", reason: "there is no such case" };
  }
  if (!isOpenCase(trial)) {
    return {
      code: "case-closed",
      reason: "this trial is settled, so there is nothing left to review",
    };
  }

  const conflicts = await conflictsFor(reviewer, trial.sponsor);
  if (conflicts.length > 0) {
    return {
      code: "conflicted",
      reason:
        "you have a recorded conflict of interest with this trial's sponsor, " +
        "so you may not review it",
    };
  }

  const abstentions = await currentReviewStore().listAbstentions();
  if (abstentions.some((e) => e.trialId === trialId && e.reviewer === reviewer)) {
    return {
      code: "abstained",
      reason: "you have already abstained from this case",
    };
  }

  const claim = await currentReviewStore().getClaim(trialId);
  if (claim) {
    if (claim.reviewer === reviewer) {
      return {
        code: "already-yours",
        reason: "you already hold this case",
      };
    }
    return {
      code: "already-held",
      reason: "another reviewer already holds this case",
    };
  }

  return null;
}

/** The declared conflicts of one reviewer — the register, as a reviewer sees it. */
export async function conflictsOf(reviewer: string): Promise<COIEntry[]> {
  return listCOIForPrincipal(reviewer);
}
