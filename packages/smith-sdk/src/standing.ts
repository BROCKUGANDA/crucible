/**
 * Standing — the v2 bible §18.2, computed from this repository's own read model.
 *
 *     Standing = Σ (w · o · δ)  ÷  (Σ (w · δ) + 3)        Display = 500 + 250 · Standing
 *
 * Every operand comes from a fact the chain already carries, except two, which are declared
 * neutral below rather than invented. It is exported here so the number a visitor reads and the
 * number an application gets from `/api/standing/:id` are the same computation, not two copies
 * that agree by luck.
 *
 * `params/crucible.params.json` has carried `standing_half_life_days: 45` since the params slice,
 * codegen'd into Rust and TS, and read by nothing — a parameter is only a parameter until
 * something computes with it. This is that something: the default comes from
 * `./params.js`, which the same generator writes, and `DEFAULT_HALF_LIFE_DAYS` is exported so a
 * test can assert the link rather than trust it. Callers may still pass a value, which is how the
 * half-life's effect is probed at a number no deployment would configure.
 */

/** Outcome values from §18.2, ×100 so they stay integers on their way in. */
export const OUTCOME_VALUE_BPS = {
  unchallengedPass: 100,
  slash: -200,
  yield: -25,
  timeout: -50,
  /** +1.50 for one independent break survived, +0.25 more each, capped at +2.00 by the table. */
  survivedBase: 150,
  survivedStep: 25,
  survivedCap: 200,
} as const;

export interface StandingOutcome {
  /** the reward the trial carried, in wei — the scale the weight is measured on */
  rewardWei: bigint;
  verdict: "paid" | "slashed" | "refunded" | "none";
  /** independent breaks filed and survived; only a paid verdict may use them */
  breaksSurvived: number;
  /** seconds since the epoch, from the settled log's own block time */
  settledAt: number;
  /** abandoned before the deadline (O4), or let the clock run out (O5) */
  exited?: "yield" | "timeout" | null;
}

export interface StandingInput {
  outcomes: StandingOutcome[];
  /** the mint's reward floor, in wei — the weight is measured in floors, not in absolute ETH */
  floorWei: bigint;
  /**
   * Defaults to `STANDING_HALF_LIFE_DAYS` from params. Overridable so a test can probe the decay
   * at a value no deployment would configure; a caller that passes one is not reading the source.
   */
  halfLifeDays?: number;
  /** now, in seconds. Passed in because a function that reads a clock cannot be tested at 45 days. */
  now: number;
}

import { STANDING_HALF_LIFE_DAYS } from "./params.js";

/** The half-life the standing formula decays on, from `params/crucible.params.json`. */
export const DEFAULT_HALF_LIFE_DAYS = Number(STANDING_HALF_LIFE_DAYS);

/** §18.2's `d`, held at neutral: nothing here measures suite difficulty. See the reported list. */
const NEUTRAL_DIFFICULTY = 1.0;
/** §18.2's `s`: 0.5 is the document's own value for a sponsor nobody has linked. */
const NEUTRAL_SPONSOR = 0.5;

export interface StandingAssumption {
  key: string;
  value: string;
  /** what would replace it, so the neutral reading is a to-do and not a permanent fiction */
  needs: string;
}

/**
 * The two inputs §18.2's weight wants and this repository does not have:
 * `d` (suite difficulty, 0.5–1.5) and `s` (sponsor independence, 0 / 0.5 / 1).
 *
 * They are held at 1.0 and 0.5 — 0.5 is the bible's own value for "unknown sponsor" — and
 * reported as assumptions by every caller, because a score computed with a fabricated difficulty
 * would be a measurement nobody could check. This is the same rule the hall follows: a figure is
 * read, or it is labelled as not being one.
 */
export const STANDING_ASSUMPTIONS: StandingAssumption[] = [
  {
    key: "difficulty",
    value: "1.0 (neutral)",
    needs: "suite strength and the family's historical pass rate, which nothing here records",
  },
  {
    key: "sponsorIndependence",
    value: "0.5 (unknown sponsor)",
    needs: "the funding-graph and timing linkage of §18.5, which is off-chain analysis this deployment does not run",
  },
  {
    key: "exitPenalties",
    value: "not counted (a refunded trial contributes no value either way)",
    needs: "the yield (−0.25) and timeout (−0.5) outcomes belong to the arena's O4/O5, which is wired to no route, keeper job or read model here",
  },
];

export interface Standing {
  /** the §18.2 score, −2.00 … +2.00, rounded to 4 decimals so it survives JSON unchanged */
  standing: number;
  /** 500 + 250·standing, on the 0–1000 display scale */
  display: number;
  /** outcomes counted — deliberately NOT the registry's `records`, which is a different book */
  counted: number;
  /** sum of the decayed weights, so a reader can see how much history is behind the score */
  weightMass: number;
  assumptions: StandingAssumption[];
  halfLifeDays: number;
}

/** §18.2 step 1: the value of one settled outcome. The table is in hundredths so the source of
 *  truth stays integer; the score itself is returned as the real number the formula needs. */
export function outcomeValue(o: StandingOutcome): number {
  const hundredths = (() => {
    if (o.exited === "yield") return OUTCOME_VALUE_BPS.yield;
    if (o.exited === "timeout") return OUTCOME_VALUE_BPS.timeout;
    if (o.verdict === "slashed") return OUTCOME_VALUE_BPS.slash;
    if (o.verdict !== "paid") return 0;
    if (o.breaksSurvived <= 0) return OUTCOME_VALUE_BPS.unchallengedPass;
    const stepped = OUTCOME_VALUE_BPS.survivedBase + OUTCOME_VALUE_BPS.survivedStep * (o.breaksSurvived - 1);
    return Math.min(stepped, OUTCOME_VALUE_BPS.survivedCap);
  })();
  return hundredths / 100;
}

/** §18.2 step 2: weight in reward floors. log2(1 + R/floor), so a floor-sized trial weighs 1. */
function outcomeWeight(rewardWei: bigint, floorWei: bigint): number {
  const floor = floorWei > 0n ? floorWei : 1n;
  const ratio = Number(rewardWei > floor ? rewardWei : floor) / Number(floor);
  return Math.log2(1 + ratio);
}

/** §18.2 step 3: δ = 2^(−age_days ÷ half_life_days). */
function decay(ageSeconds: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  const ageDays = Math.max(0, ageSeconds) / 86_400;
  return Math.pow(2, -ageDays / halfLifeDays);
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

/**
 * The computation. Empty history returns the prior's answer (0.0 standing, 500 display) rather
 * than null, because "no outcomes yet" is a real position on the scale, not an unknown: the +3 in
 * the denominator is what keeps a new agent near zero, and printing `—` for an agent with no
 * history would hide the mechanism.
 */
export function computeStanding(input: StandingInput): Standing {
  const halfLifeDays = input.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  let numerator = 0;
  let denominatorWeight = 0;
  let counted = 0;

  for (const o of input.outcomes) {
    const value = outcomeValue(o);
    // A refund is not an outcome for the agent — nobody won or failed the work — so it enters
    // neither side of the ratio. Counting it would drag a score toward zero with no event behind
    // the pull, which is the same mistake as printing 0 for a figure nothing measured.
    if (value === 0) continue;
    const delta = decay(input.now - o.settledAt, halfLifeDays);
    // The two neutral factors are STANDING_ASSUMPTIONS' difficulty (1.0) and sponsor
    // independence (0.5). They are named here, not written as literals, so removing the
    // assumption means removing it from both this line and the reported list.
    const decayed = outcomeWeight(o.rewardWei, input.floorWei) * NEUTRAL_DIFFICULTY * NEUTRAL_SPONSOR * delta;
    numerator += decayed * value;
    denominatorWeight += decayed;
    counted += 1;
  }

  const standing = numerator / (denominatorWeight + 3);
  return {
    standing: round4(standing),
    display: round4(500 + 250 * standing),
    counted,
    weightMass: round4(denominatorWeight),
    assumptions: STANDING_ASSUMPTIONS,
    halfLifeDays,
  };
}
