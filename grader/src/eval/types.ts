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
  n: number;
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
  maxFalsePassRate: number; // hard disqualifier: <= 1%
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
