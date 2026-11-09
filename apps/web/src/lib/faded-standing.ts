import {
  computeStanding,
  REWARD_FLOOR_ETH_WEI,
  type StandingOutcome,
} from "@crucible/smith";
import type { ApiTrial } from "@crucible/indexer";

/**
 * The §18.2 standing for one agent, computed from this host's own settlement timestamps.
 *
 * The inputs are the same facts `/api/standing/:id` reads (the index's `VerdictFinalized`
 * logs, hydrated to seconds) and the same formula — this module exists so the hall can
 * show the number beside the receipts that make it checkable, without a network round
 * trip per row. It is a derivation, not a contract read: the chain's own decay on a slash
 * is 25% of window wins inside `AlloyRegistry`, and nothing here replaces that.
 *
 * The one rule, same as everywhere else in this codebase: an outcome without a settlement
 * time is excluded and *counted*, never aged from its submission time. When nothing
 * countable remains, the figure is `null` (rendered `—`), not the 500-prior — a score
 * computed from zero inputs is not a prior, it is a guess dressed as one.
 */
export interface FadedStanding {
  /** `500 + 250 · standing`, rounded — or null when no outcome could be counted */
  display: number | null;
  /** outcomes that entered the ratio */
  counted: number;
  /** settled outcomes excluded for want of a settlement time */
  unaged: number;
  /** outcomes excluded because they settled before the current identity epoch opened (ADR-0012) */
  excludedPreEpoch: number;
  /** the half-life the decay ran on, from `params/crucible.params.json` */
  halfLifeDays: number;
}

export function fadedStanding(
  trials: readonly ApiTrial[],
  agentId: number,
  now: number,
  epochStartedAt: number | null = null,
): FadedStanding {
  const outcomes: StandingOutcome[] = [];
  let unaged = 0;

  for (const t of trials) {
    if (t.agentId !== agentId || t.status !== "settled") continue;
    if (t.settledAt === null) {
      // No settlement time means no honest age, and age is half of a decayed weight.
      unaged += 1;
      continue;
    }
    if (
      t.verdict !== "paid" &&
      t.verdict !== "slashed" &&
      t.verdict !== "refunded" &&
      t.verdict !== "none"
    ) {
      // A verdict this build does not recognise is an outcome it cannot value; refuse it
      // rather than guess at its weight.
      unaged += 1;
      continue;
    }
    outcomes.push({
      rewardWei: BigInt(t.rewardWei),
      verdict: t.verdict,
      breaksSurvived: t.breakSkeptic !== null ? 1 : 0,
      settledAt: t.settledAt,
    });
  }

  const standing = computeStanding({
    outcomes,
    floorWei: REWARD_FLOOR_ETH_WEI,
    now,
    epochStartedAt,
  });

  return {
    display: standing.counted === 0 ? null : standing.display,
    counted: standing.counted,
    unaged,
    excludedPreEpoch: standing.excludedPreEpoch,
    halfLifeDays: standing.halfLifeDays,
  };
}

