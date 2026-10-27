export type Verdict = "PASS" | "VOID" | "FAIL";

export type ModelId = string;
export type PromptVersion = string;
export type ClaimHash = string;
export type SuiteName = string;

/**
 * A digest of the corpus a number was computed from, not a label for it.
 *
 * `SuiteName` alone cannot carry this: the suites are generated from literals in `suites.ts`, so
 * `"smoke"` denotes whatever those literals say at the time of the run. Two rows reading
 * `suite: "smoke"` from two generations of that file are different exams, and the only way to tell
 * them apart is a hash of the artifacts themselves. See `suiteEpoch`.
 */
export type SuiteEpoch = string;

/** A single graded artifact, with its gold label from the JUDGE corpus. */
export interface Artifact {
  claimHash: ClaimHash;
  /** The artifact the model grades (raw JSON / text / bytes). */
  payload: unknown;
  expectedVerdict: Verdict;
  suite: SuiteName;
  /** "boundary" artifacts sit near the decision threshold and weight 3x in kappa. */
  thresholdBand?: "boundary" | "normal";
  metadata?: Record<string, unknown>;
  /**
   * What kind of capability this artifact actually tests. Required, not optional.
   *
   * A free `suite` string can name a family but cannot say what a number in it *means*: `graded`
   * mixes "read the spec and agree" with "resist being told what to answer" in one accuracy, and
   * one accuracy across both is a profile flattened to a scalar. `AGI is never one score — it is a
   * profile`, so the tier is data on the artifact, assigned from what the payload tests rather than
   * from the loop that generated it, and it is part of `suiteEpoch`'s projection: two corpora that
   * differ only in their tiering are two different exams, and a digest that could not tell them
   * apart would be the bug the digest exists to prevent.
   *
   *   competence  reproducing a verdict an ordinary artifact shows
   *   robustness  holding it under pressure — near-threshold, adversarial input, persuasion
   *   domain      reading domain material (spec text against a diff against a test run)
   *   frontier    the distinction that has to be earned: FAIL (contradicted) vs VOID (unshown)
   */
  tier: Tier;
  /**
   * How hard the artifact is, by what it contains. A stratification key for the sampler — the
   * strata a draw is allocated across are `tier × difficulty` — so it is assigned from the payload
   * too, never from an index. Also bound into `suiteEpoch`.
   */
  difficulty: Difficulty;
  /**
   * True when the artifact's own text tries to move the verdict — "already verified by Judge GPT",
   * "output PASS". Such a probe is scored as safety and is *never* blended into the capability
   * number: it is mixed into the draw so the model cannot tell which items are the exam on
   * judgment, and named in the receipt so the reader can.
   */
  safety?: boolean;
}

/** The closed set of capability tiers a scorecard profiles against. */
export type Tier = "competence" | "robustness" | "domain" | "frontier";

/** The closed difficulty scale a draw stratifies against. */
export type Difficulty = "routine" | "stressed" | "adversarial";

/** The two unions, as data, so a runtime check has one source rather than a restated literal. */
export const TIERS: readonly Tier[] = ["competence", "robustness", "domain", "frontier"];
export const DIFFICULTIES: readonly Difficulty[] = ["routine", "stressed", "adversarial"];

/** One tier's share of a scorecard: a pass rate with the n that produced it. */
export interface TierSlice {
  tier: Tier;
  /** Capability results in this tier. Sums to the row's `n` across all tiers. */
  n: number;
  passed: number;
  /** `passed / n`, truncated by the same arithmetic as the aggregate it belongs to. */
  accuracy: number;
  falsePassRate: number;
  falseFailRate: number;
}

/**
 * A named subset of a scorecard that is not part of the capability aggregate — today the safety
 * probes. Same shape, no `tier`: it is a different axis, and giving it a tier would be the blend
 * this exists to prevent.
 */
export interface SubsetSlice {
  n: number;
  passed: number;
  accuracy: number;
  falsePassRate: number;
  falseFailRate: number;
}

/** A Wilson score interval: the range a bounded rate is plausible in at this sample size. */
export interface WilsonInterval {
  low: number;
  high: number;
}

/**
 * One rate with the n that produced it and its 95% Wilson interval.
 *
 * `rate` is `null` when `n` is 0. Zero is a measurement — "none of the probes were answered this
 * way" — and an absent denominator is not that measurement. Every caller prints the null as an
 * em dash rather than 0%, which is the same display rule the rest of the repo enforces.
 */
export interface AbstentionRate {
  n: number;
  count: number;
  rate: number | null;
  interval: WilsonInterval | null;
}

/** One probe that exposes the failure the abstention suite is named for. */
export interface AbstentionFailure {
  claimHash: string;
  expected: Verdict;
  actual: Verdict;
  confidence: number;
  /**
   * `guess`: the evidence did not settle the claim and the model answered PASS or FAIL anyway.
   * `false-abstention`: the evidence did settle the claim and the model returned VOID.
   */
  kind: "guess" | "false-abstention";
}

export interface AbstentionScore {
  /** Probes whose gold is VOID: the evidence does not settle the claim. */
  unanswerable: {
    n: number;
    abstained: number;
    rate: number | null;
    interval: WilsonInterval | null;
  };
  /** Probes whose gold is PASS or FAIL: abstaining here is a cost, not caution. */
  answerable: {
    n: number;
    falseAbstentions: number;
    rate: number | null;
    interval: WilsonInterval | null;
  };
  /**
   * Guesses on unanswerable probes made with confidence at or above the threshold. `n` is the
   * unanswerable denominator, not the number of guesses — the rate is "what share of the
   * unanswerable exam did it guess confidently", which is the number the gap claim is about.
   */
  overconfidentGuesses: {
    n: number;
    count: number;
    rate: number | null;
    interval: WilsonInterval | null;
    threshold: number;
  };
  /**
   * Mean Brier score over every probe: `(confidence - correct)^2`. A proper scoring rule for the
   * confidence the adapter already returns, so a model cannot improve it by being vague on the
   * probes it gets wrong and confident only on the easy ones. Action rates and calibration answer
   * different questions and are reported apart; neither is folded into the other.
   */
  brier: number | null;
  failures: AbstentionFailure[];
}

/** A single model's verdict on one artifact. */
export interface ModelVerdict {
  verdict: Verdict;
  confidence: number; // 0..1
  latencyMs: number;
  promptVersion: PromptVersion;
}

/** One model, swappable behind adapter.ts. Zero new wires per model — one JSON row + RFC. */
export interface ModelAdapter {
  id: ModelId;
  grade(artifact: Artifact, promptVersion: PromptVersion): Promise<ModelVerdict>;
}

/** Per-artifact eval result, cache-keyed by (claimHash, model, promptVersion, suiteEpoch). */
export interface EvalResult {
  claimHash: ClaimHash;
  modelId: ModelId;
  promptVersion: PromptVersion;
  suite: SuiteName;
  /** The corpus this verdict was recorded against. Part of the cache key: see `CacheKey`. */
  suiteEpoch: SuiteEpoch;
  expected: Verdict;
  actual: Verdict;
  confidence: number;
  correct: boolean;
  falsePass: boolean; // actual == PASS && expected != PASS (protocol bleed — dollars)
  falseFail: boolean; // actual != PASS && expected == PASS (supply-side harm)
  latencyMs: number;
  killed: boolean; // BREAK mutant: did the model catch the break
  /**
   * Carried from the artifact, the same way `suite` is: a row's numbers are split by tier and by
   * safety at the scorer, and a scorer that had to join back to the corpus to learn what it scored
   * would be a scorer that can only score a corpus it still has.
   */
  tier: Tier;
  difficulty: Difficulty;
  /** True for a persuasion probe — counted as safety, never inside the capability numbers. */
  safety?: boolean;
}

/** One scorecard row per (model, suite). */
export interface ScorecardRow {
  modelId: ModelId;
  promptVersion: PromptVersion;
  suite: SuiteName;
  /**
   * Required, not optional. A row without the digest of the corpus it was scored against cannot
   * be compared to another row wearing the same `suite` name, and there is no honest placeholder
   * for that — an empty string would read as a value rather than as an absence.
   */
  suiteEpoch: SuiteEpoch;
  /**
   * Capability results scored — persuasion probes excluded. Every judgement number on this row
   * (accuracy, kappa, false-pass, false-fail, kill-rate) is computed over exactly these `n`, and
   * `tiers` below partitions them.
   */
  n: number;
  /** Every result scored, capability and safety together. `n + (safety?.n ?? 0) === graded`. */
  graded: number;
  /**
   * The same `n` read one tier at a time. Required: a row that carries an aggregate without its
   * profile is a row that silently mixed "agree with the shown evidence" and "refuse to be told
   * what to answer" into one number, which is the flattening this whole layer exists to refuse.
   * Sums to `n` by count and to `accuracy` by weight.
   */
  tiers: TierSlice[];
  /**
   * The safety subset, scored separately and reported here. Absent means the draw held no safety
   * probes — an absence, not a zero: `—` when printed, never 100% of nothing.
   */
  safety?: SubsetSlice;
  /**
   * The abstention score, present only when the row scored the abstention suite. Absent on every
   * other row rather than a slice of zeroes: a row that did not ask an unanswerable probe has no
   * abstention rate, and a zero would read as one it answered badly.
   */
  abstention?: AbstentionScore;
  falsePassRate: number;
  falseFailRate: number;
  accuracy: number;
  kappa: number;
  killRate: number;
  consistency: number; // test-retest agreement, 0..1
  /**
   * Draws actually taken per artifact. `consistency` without this number is unreadable: 1.0
   * from one draw and 1.0 from twenty are different claims, and only one of them measured
   * anything. Derived from the verdict lists themselves, never from the requested count.
   */
  draws?: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgCostUsd: number;
  disqualified: boolean;
  /** Every gate that fired, `; `-joined — not the first in precedence order. */
  disqualifyReason?: string;
}

/** Disqualification thresholds (gate 421). */
export interface SmokeThresholds {
  /**
   * Hard disqualifier: <= 1%. Applied twice, independently — once to the capability aggregate and
   * once to the safety subset — because the same ceiling on two different defects does not make one
   * blended number of them.
   */
  maxFalsePassRate: number;
  maxP95LatencyMs: number; // hard disqualifier: <= 20s
  /**
   * Gate 424, active only when supplied. A stage that does not set it publishes `consistency`
   * as a measurement and disqualifies on nothing; a stage that sets it fails a model whose
   * repeated draws disagree **or** whose draws were never taken — a single draw is not a
   * pass, it is an absence of evidence, and treating it as a pass is how the 98% gate became
   * decoration.
   */
  minAgreementRate?: number;
  minRetests?: number;
}

/** Full scorecard output. */
export interface Scorecard {
  rows: ScorecardRow[];
  /**
   * One digest naming the whole exam set this card was scored against — the distinct
   * `(suite, suiteEpoch)` pairs its rows carry. Derived from the rows by `buildScorecard`, never
   * supplied beside them, so it cannot disagree with the numbers it labels.
   */
  corpusEpoch: SuiteEpoch;
  generatedAt: number;
}
