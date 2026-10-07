import type { ApiSnapshot } from "@crucible/indexer";
import { tierNumeral } from "@/lib/theme/roman";
import type { SettlementMark } from "./palette";

/**
 * What the scene is allowed to know about the chain.
 *
 * The drawing is architecture, so it needs no data. Three things do carry a reading, and all
 * three are derived here — in a pure function with a test — rather than inline in a
 * component, because "the crowd got denser" and "the seal turned gold" are claims about the
 * index. A claim that cannot be asserted against a fixture is a claim that will silently
 * report empty.
 *
 * Every field is `null` when the snapshot has not arrived. `null` must stay `null`: coercing
 * it to zero would print an unmeasured arena as an empty one, which reads as a fact.
 */

/** The ring is drawn full at this many registered smiths. */
export const CROWD_SATURATION = 24;

export interface ArenaFacts {
  /** The colour of the most recently *mined* settlement, or bronze while none exists. */
  mark: SettlementMark;
  /** 0..1 crowd fill from the registered-smith count. The HUD names this mapping. */
  crowd: number;
  /** Numeral inside the seal: the leading name's tier. Null when no registry read backs it. */
  seal: string | null;
  trials: number | null;
  smiths: number | null;
  settled: number | null;
  /** Block number of the settlement `mark` came from, so the reading is checkable. */
  markBlock: number | null;
}

const NO_FACTS: ArenaFacts = {
  mark: "none",
  crowd: 0,
  seal: null,
  trials: null,
  smiths: null,
  settled: null,
  markBlock: null,
};

export function deriveFacts(snapshot: ApiSnapshot | null | undefined): ArenaFacts {
  if (!snapshot) return NO_FACTS;

  // The newest settlement by block number, taken across the whole hall rather than from the
  // top entry: rank is a reputation order, and "most recent" is a chain order. Mixing them
  // up would make the seal narrate the best agent instead of the last verdict.
  let newestBlock = -1;
  let mark: SettlementMark = "none";
  for (const entry of snapshot.hall ?? []) {
    for (const settlement of entry.settlements ?? []) {
      if (settlement.blockNumber > newestBlock) {
        newestBlock = settlement.blockNumber;
        mark = settlement.verdict === "paid" || settlement.verdict === "slashed" || settlement.verdict === "refunded"
          ? settlement.verdict
          : "none";
      }
    }
  }

  const smiths = snapshot.agents ? snapshot.agents.length : null;
  const lead = snapshot.hall?.[0];

  return {
    mark,
    crowd: Math.min(1, (smiths ?? 0) / CROWD_SATURATION),
    seal: tierNumeral(lead?.tier ?? null),
    trials: snapshot.counts?.all ?? null,
    smiths,
    settled: snapshot.counts?.settled ?? null,
    markBlock: newestBlock < 0 ? null : newestBlock,
  };
}
